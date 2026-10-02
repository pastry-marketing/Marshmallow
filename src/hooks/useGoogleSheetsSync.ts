import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { syncLeadUpsertToGoogleSheets, syncLeadDeleteToGoogleSheets, getGoogleSheetsConfig } from "@/lib/google-sheets";
import { claimSyncQueue, raiseSyncStaleAlert } from "@/lib/sheets-sync-health";
import {
  SYNC_TRIGGER_EVENTS,
  isIgnorableEvent,
  jobIdFromLeadPayload,
  leadIdFromChangePayload,
  leadIdFromLeadPayload,
} from "@/lib/sheets-sync-triggers";
import { realtimeBus } from "@/lib/realtime";
import type { Lead } from "@/types";

/** How long to wait for a lead to stop changing before writing it once. */
const SYNC_DEBOUNCE_MS = 1200;

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

    /**
     * Schedules one upsert for a lead, coalescing with anything already queued.
     *
     * A single debounce map is shared by all three source tables on purpose. If
     * a note is added while the lead form is open, two timers would fire and
     * the sheet would be written twice with different intermediate states.
     * Sharing the map means the last change wins and one write carries
     * everything.
     */
    const scheduleUpsert = (leadId: string) => {
      const existingTimer = pendingSyncsRef.current.get(leadId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(async () => {
        pendingSyncsRef.current.delete(leadId);
        try {
          // Re-read rather than trusting the event payload. A note change
          // carries no lead columns at all, and an event may be stale by the
          // time the debounce settles.
          const { data: freshLead } = await supabase
            .from("leads")
            .select("*")
            .eq("id", leadId)
            .maybeSingle();

          if (freshLead) {
            await syncLeadUpsertToGoogleSheets(freshLead as Lead);
          }
        } catch (err) {
          console.warn("Failed to sync lead upsert to Google Sheet:", err);
        }
      }, SYNC_DEBOUNCE_MS);

      pendingSyncsRef.current.set(leadId, timer);
    };

    const handleLeadChange = (event: Event) => {
      if (!isEnabledRef.current) return;
      const payload = (event as CustomEvent).detail;
      const eventType: string = payload?.eventType;
      if (isIgnorableEvent(eventType)) return;

      if (eventType === "DELETE") {
        const oldRow = payload.old as Partial<Lead> | undefined;
        const leadId = leadIdFromLeadPayload(payload);
        const jobId =
          jobIdFromLeadPayload(payload) || (leadId ? leadIdToJobIdMap.current.get(leadId) : undefined);

        if (leadId) {
          leadIdToJobIdMap.current.delete(leadId);
          // A pending upsert for a lead that no longer exists is pointless.
          const pending = pendingSyncsRef.current.get(leadId);
          if (pending) {
            clearTimeout(pending);
            pendingSyncsRef.current.delete(leadId);
          }
          void syncLeadDeleteToGoogleSheets(leadId, jobId).catch((err) => {
            console.warn("Failed to sync lead deletion to Google Sheet:", err);
          });
        }
        return;
      }

      const rawLead = payload.new as Lead | undefined;
      const leadId = leadIdFromLeadPayload(payload);
      if (!leadId) return;

      if (rawLead?.job_id) {
        leadIdToJobIdMap.current.set(leadId, rawLead.job_id);
      }

      scheduleUpsert(leadId);
    };

    /**
     * Notes and photos are part of the synced row, so a change to either has
     * to re-sync the lead it belongs to. These events carry only their own
     * row, so the lead is looked up by lead_id and then re-read in full.
     *
     * A delete here cannot be attributed if the table does not carry REPLICA
     * IDENTITY FULL, because Postgres then sends only the primary key. The
     * migration sets it for these tables so deletes resync too; where that is
     * not possible the change is skipped rather than guessed, and the nightly
     * reconciliation sweep is what catches the difference.
     */
    const handleChildChange = (event: Event) => {
      if (!isEnabledRef.current) return;
      const payload = (event as CustomEvent).detail;
      if (isIgnorableEvent(payload?.eventType)) return;

      const leadId = leadIdFromChangePayload(payload);
      if (!leadId) return;

      scheduleUpsert(leadId);
    };

realtimeBus.addEventListener("leads", handleLeadChange);
    SYNC_TRIGGER_EVENTS.filter((name) => name !== "leads").forEach((name) => {
      realtimeBus.addEventListener(name, handleChildChange);
    });

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
      SYNC_TRIGGER_EVENTS.filter((name) => name !== "leads").forEach((name) => {
        realtimeBus.removeEventListener(name, handleChildChange);
      });
      clearInterval(drainTimer);
      clearInterval(staleTimer);
      // Clear any pending debounce timers
      pendingSyncsRef.current.forEach((timer) => clearTimeout(timer));
      pendingSyncsRef.current.clear();
    };
  }, [role]);
}
