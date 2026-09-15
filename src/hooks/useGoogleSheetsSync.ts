import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { syncLeadUpsertToGoogleSheets, syncLeadDeleteToGoogleSheets, getGoogleSheetsConfig } from "@/lib/google-sheets";
import type { Lead } from "@/types";

/**
 * Hook to automatically synchronize lead changes in Supabase with Google Sheets.
 *
 * The realtime subscription listens to the WHOLE leads table, so it is only
 * opened when the sync is actually enabled AND the viewer is an admin. Every
 * other session skips it entirely, which avoids billing a leads-wide realtime
 * subscription for every logged-in user.
 */
export function useGoogleSheetsSync() {
  const { role } = useAuth();
  const isEnabledRef = useRef(true);
  const pendingSyncsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const leadIdToJobIdMap = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    // Only admins run the (client-side) Google Sheets sync.
    if (role !== "admin") return;

    let isMounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    void getGoogleSheetsConfig().then((config) => {
      if (!isMounted) return;
      const enabled = Boolean(config.autoSync && config.webhookUrl);
      // Do not open a leads-wide realtime subscription when sync is turned off.
      if (!enabled) return;
      isEnabledRef.current = true;

      // Pre-populate lead ID to job_id mapping for reliable deletion tracking
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

      channel = supabase
        .channel("google-sheets-lead-sync")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "leads",
          },
          (payload) => {
            if (!isEnabledRef.current) return;

            const eventType = payload.eventType;

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
                // Fetch fresh complete lead record so all columns and joins are complete
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
        }
        )
        .subscribe();
    });

    return () => {
      isMounted = false;
      // Clear any pending timers
      pendingSyncsRef.current.forEach((timer) => clearTimeout(timer));
      pendingSyncsRef.current.clear();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [role]);
}
