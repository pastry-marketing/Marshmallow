import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { syncLeadUpsertToGoogleSheets, syncLeadDeleteToGoogleSheets, getGoogleSheetsConfig } from "@/lib/google-sheets";
import { claimSyncQueue, raiseSyncStaleAlert } from "@/lib/sheets-sync-health";
import { realtimeBus } from "@/lib/realtime";
import type { Lead } from "@/types";

/** How often a session with the app open retries leads that previously failed. */
const QUEUE_DRAIN_INTERVAL_MS = 120_000;
/** How often to nudge the database to alert admins if sync has gone stale. */
const STALE_ALERT_INTERVAL_MS = 300_000;

/**
 * Hook to automatically synchronize lead changes in Supabase with Google Sheets.
 *
 * Listens on the global realtimeBus (which receives "leads" table events from the
 * single shared global channel) instead of opening a separate channel — this keeps
 * us within Supabase's realtime channel limits.
 *
 * Only runs when the viewer is an admin AND autoSync is enabled.
 *
 * Failures are recorded in the database rather than only in the console, so a
 * lead that failed to sync is not lost when the tab closes. This hook also
 * drains that queue while it is running: the queue is durable, but something
 * still has to work through it, and an open admin session is the cheapest place
 * that can happen without duplicating the row formatter on the server.
 */
export function useGoogleSheetsSync() {
  const { role } = useAuth();
  const isEnabledRef = useRef(true);
  const pendingSyncsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const leadIdToJobIdMap = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    // Only admins run the (client-side) Google Sheets sync.
    if (role !== "admin") return;

    let isMounted = true;

    void getGoogleSheetsConfig().then((config) => {
      if (!isMounted) return;
      const enabled = Boolean(config.autoSync && config.webhookUrl);
      // Do not listen when sync is turned off.
      if (!enabled) return;
      isEnabledRef.current = true;

      // Pre-populate lead ID → job_id mapping for reliable deletion tracking
      void supabase
        .from("leads")
        .select("id, job_id")
        .then(({ data }) => {
          if (data && isMounted) {
            data.forEach((l) => {
              if (l.id && l.job_id) {
                leadIdToJobIdMap.current.set(l.id, l.job_id);
              }
            });
          }
        });
    });

    const handleLeadChange = (event: Event) => {
      if (!isEnabledRef.current) return;
      const payload = (event as CustomEvent).detail;
      const eventType: string = payload?.eventType;

      if (eventType === "DELETE") {
        const oldRow = payload.old as Partial<Lead> | undefined;
        const leadId = oldRow?.id;
        const jobId =
          (oldRow as { job_id?: string } | undefined)?.job_id ||
          (leadId ? leadIdToJobIdMap.current.get(leadId) : undefined);

        if (leadId) {
          leadIdToJobIdMap.current.delete(leadId);
          void syncLeadDeleteToGoogleSheets(leadId, jobId).catch((err) => {
            console.warn("Failed to sync lead deletion to Google Sheet:", err);
          });
        }
        return;
      }

      if (eventType === "INSERT" || eventType === "UPDATE") {
        const rawLead = payload.new as Lead | undefined;
        const leadId = rawLead?.id;
        if (!leadId) return;

        if (rawLead.job_id) {
          leadIdToJobIdMap.current.set(leadId, rawLead.job_id);
        }

        const oldRow = payload.old as Partial<Lead> | undefined;

        // Debounce rapid changes to the same lead by 1.2 seconds
        const existingTimer = pendingSyncsRef.current.get(leadId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
          pendingSyncsRef.current.delete(leadId);
          try {
            // Fetch fresh complete lead record so all columns and joins are present
            const { data: freshLead } = await supabase
              .from("leads")
              .select("*")
              .eq("id", leadId)
              .maybeSingle();

            const leadToSync = (freshLead as Lead) || rawLead;
            if (leadToSync) {
              await syncLeadUpsertToGoogleSheets(
                leadToSync,
                oldRow?.status,
                oldRow?.cs_tag
              );
            }
          } catch (err) {
            console.warn("Failed to sync lead upsert to Google Sheet:", err);
          }
        }, 1200);

        pendingSyncsRef.current.set(leadId, timer);
      }
    };

    realtimeBus.addEventListener("leads", handleLeadChange);

    /**
     * Works through leads that previously failed to reach the sheet.
     *
     * Claiming happens in SQL with FOR UPDATE SKIP LOCKED, so two admins open
     * at once cannot process the same lead. A lead still failing after five
     * attempts is left alone: the backoff has grown to eight minutes by then,
     * and hammering a script that is already failing makes it worse.
     */
    const drainFailedQueue = async () => {
      if (!isMounted || !isEnabledRef.current) return;
      let items: Awaited<ReturnType<typeof claimSyncQueue>>;
      try {
        items = await claimSyncQueue(25);
      } catch {
        return;
      }
      if (!items?.length) return;

      for (const item of items) {
        if (!isMounted) return;
        if (item.attempts > 5) continue;

        try {
          if (item.op === "delete") {
            await syncLeadDeleteToGoogleSheets(item.lead_id, item.job_id ?? undefined);
          } else {
            const { data: freshLead } = await supabase
              .from("leads")
              .select("*")
              .eq("id", item.lead_id)
              .maybeSingle();
            if (freshLead) {
              await syncLeadUpsertToGoogleSheets(freshLead as Lead);
            }
          }
        } catch (err) {
          // Already recorded by dispatchToWebhook, which also re-queues it.
          console.warn("Queued lead sync failed again:", err);
        }
      }
    };

    const drainTimer = setInterval(() => void drainFailedQueue(), QUEUE_DRAIN_INTERVAL_MS);

    /**
     * Asks the database to alert admins when the sync has gone stale.
     *
     * The write happens in SQL, so the alert reaches admins who are not looking
     * at this tab. Throttling is server-side, so this can run freely.
     */
    const staleTimer = setInterval(() => {
      void raiseSyncStaleAlert().catch(() => undefined);
    }, STALE_ALERT_INTERVAL_MS);

    // Check once on mount rather than waiting a full interval for the first look.
    void raiseSyncStaleAlert().catch(() => undefined);

    return () => {
      isMounted = false;
      realtimeBus.removeEventListener("leads", handleLeadChange);
      clearInterval(drainTimer);
      clearInterval(staleTimer);
      // Clear any pending debounce timers
      pendingSyncsRef.current.forEach((timer) => clearTimeout(timer));
      pendingSyncsRef.current.clear();
    };
  }, [role]);
}
