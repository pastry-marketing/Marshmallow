import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CheckCircle2, ClipboardCheck, Search, XCircle } from "lucide-react";

import LeadCard from "@/components/leads/LeadCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  canReviewQuoteApproval,
  reviewQuoteApproval,
  type LeadQuoteApprovalRequest,
  type QuoteApprovalDecision,
} from "@/lib/quote-approval-requests";
import type { Lead } from "@/types";
import { toast } from "sonner";

type QuoteApprovalRow = LeadQuoteApprovalRequest & { lead: Lead | null };

const requestTable = () => supabase.from("lead_quote_approval_requests" as never);

export default function QuoteApprovalRequests() {
  const { role, user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const { data: requests = [], isLoading, refetch } = useQuery<QuoteApprovalRow[]>({
    queryKey: ["quote-approval-requests"],
    queryFn: async () => {
      const { data: rows, error } = await requestTable()
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const pending = (rows ?? []) as LeadQuoteApprovalRequest[];
      const leadIds = pending.map((request) => request.lead_id);
      const { data: leads, error: leadsError } = leadIds.length
        ? await supabase.from("leads").select("*").in("id", leadIds)
        : { data: [], error: null };
      if (leadsError) throw leadsError;

      const leadsById = new Map(((leads ?? []) as Lead[]).map((lead) => [lead.id, lead]));
      return pending.map((request) => ({
        ...request,
        lead: leadsById.get(request.lead_id) ?? null,
      }));
    },
    refetchInterval: 30_000,
  });

  const { data: profiles = {} } = useQuery({
    queryKey: ["profiles-map"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles_public" as never)
        .select("id, full_name");
      if (error) return {};

      return ((data ?? []) as { id: string; full_name: string | null }[]).reduce<Record<string, string>>(
        (profileMap, profile) => {
          profileMap[profile.id] = profile.full_name || "Unknown user";
          return profileMap;
        },
        {},
      );
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    const channel = supabase
      .channel("quote-approval-page-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lead_quote_approval_requests" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["quote-approval-requests"] });
          queryClient.invalidateQueries({ queryKey: ["pending-quote-approval-count"] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const filteredRequests = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return requests;

    return requests.filter((request) => {
      const lead = request.lead;
      return [
        lead?.customer_name,
        lead?.customer_phone,
        lead?.job_id,
        request.lead_customer_name,
        request.lead_job_id,
        request.requested_by_name,
      ].some((value) => value?.toLowerCase().includes(query));
    });
  }, [requests, search]);

  const handleReview = async (request: LeadQuoteApprovalRequest, decision: QuoteApprovalDecision) => {
    if (!user || !canReviewQuoteApproval(role)) return;

    setReviewingId(request.id);
    try {
      await reviewQuoteApproval({ request, reviewerId: user.id, decision });
      toast.success(
        decision === "approved"
          ? "Quote approved and moved to Quotes to Send"
          : "Quote request declined",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["quote-approval-requests"] }),
        queryClient.invalidateQueries({ queryKey: ["pending-quote-approval-count"] }),
        queryClient.invalidateQueries({ queryKey: ["pending-quote-requests-count"] }),
        queryClient.invalidateQueries({ queryKey: ["leads"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to review quote request");
    } finally {
      setReviewingId(null);
    }
  };

  const reviewer = canReviewQuoteApproval(role);

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <section className="glass-panel-strong rounded-[28px] px-5 py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-violet-500/20 bg-violet-500/10">
              <ClipboardCheck className="h-4 w-4 text-violet-500" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-[-0.035em]">Quote Approval</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {requests.length} pending request{requests.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <div className="relative w-full sm:w-[260px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search quote requests..."
              className="rounded-[16px] pl-9"
            />
          </div>
        </div>
      </section>

      {isLoading ? (
        <div className="h-40 rounded-2xl border border-border/40 skeleton-shimmer" />
      ) : filteredRequests.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-[220px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <ClipboardCheck className="h-9 w-9 opacity-30" />
            <span>No quote approvals are waiting.</span>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filteredRequests.map((request) => {
            const lead = request.lead;
            const customerName = lead?.customer_name || request.lead_customer_name || "Lead";
            const busy = reviewingId === request.id;

            if (!lead) {
              return (
                <Card key={request.id} className="border-dashed border-border/60">
                  <CardContent className="flex min-h-[220px] flex-col items-center justify-center gap-2 p-6 text-center">
                    <ClipboardCheck className="h-8 w-8 text-muted-foreground/30" />
                    <p className="text-sm font-medium">Lead details are unavailable</p>
                    <p className="text-xs text-muted-foreground">
                      Refresh the page or confirm that this reviewer can access the lead.
                    </p>
                  </CardContent>
                </Card>
              );
            }

            return (
              <div key={request.id} className="min-w-0 space-y-2">
                <div className="rounded-[20px] border border-violet-500/25 bg-violet-500/[0.07] p-3 shadow-sm">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-500">
                        Quote approval requested
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        By {request.requested_by_name || "Customer Service"}
                      </p>
                    </div>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {format(new Date(request.created_at), "MMM d · h:mm a")}
                    </span>
                  </div>

                  {reviewer ? (
                    <div className="grid grid-cols-2 gap-2">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" className="gap-1.5" disabled={busy}>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Approve quote
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Approve this quote request?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {customerName} will move to Quotes to Send for the quotation team.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Go back</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleReview(request, "approved")}>
                              Approve quote
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy}>
                            <XCircle className="h-3.5 w-3.5" />
                            Decline request
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Decline this quote request?</AlertDialogTitle>
                            <AlertDialogDescription>
                              The request will close and the lead will stay at its current status.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Go back</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => handleReview(request, "declined")}
                            >
                              Decline request
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ) : (
                    <p className="rounded-xl border border-violet-500/20 bg-background/40 px-3 py-2 text-center text-xs text-muted-foreground">
                      Waiting for CS Admin or Admin approval
                    </p>
                  )}
                </div>

                <LeadCard lead={lead} profiles={profiles} onRefresh={() => void refetch()} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
