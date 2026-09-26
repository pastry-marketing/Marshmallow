import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CheckCircle2, ClipboardCheck, ExternalLink, Search, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

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
import StatusBadge from "@/components/leads/StatusBadge";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { openLeadFromClick } from "@/lib/lead-navigation";
import {
  canReviewQuoteApproval,
  reviewQuoteApproval,
  type LeadQuoteApprovalRequest,
  type QuoteApprovalDecision,
} from "@/lib/quote-approval-requests";
import { STATUS_LABELS } from "@/lib/constants";
import type { Lead } from "@/types";
import { toast } from "sonner";

type QuoteApprovalRow = LeadQuoteApprovalRequest & { lead: Lead | null };

const requestTable = () => supabase.from("lead_quote_approval_requests" as never);

export default function QuoteApprovalRequests() {
  const { role, user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const { data: requests = [], isLoading } = useQuery<QuoteApprovalRow[]>({
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
    <div className="mx-auto max-w-[1200px] space-y-5">
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
        <div className="grid gap-4">
          {filteredRequests.map((request) => {
            const lead = request.lead;
            const customerName = lead?.customer_name || request.lead_customer_name || "Lead";
            const jobId = lead?.job_id || request.lead_job_id || request.lead_id;
            const busy = reviewingId === request.id;

            return (
              <Card key={request.id} className="overflow-hidden border-border/60">
                <CardContent className="p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold">{customerName}</h2>
                        {lead && <StatusBadge status={lead.status} size="sm" />}
                        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                          {jobId}
                        </span>
                      </div>

                      <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                        <p>Requested by {request.requested_by_name || "Customer Service"}</p>
                        <p>{format(new Date(request.created_at), "MMM d, yyyy · h:mm a")}</p>
                        <p>
                          Current status: {STATUS_LABELS[request.previous_status] || request.previous_status.replace(/_/g, " ")}
                        </p>
                        {lead?.service_type && <p>Service: {lead.service_type}</p>}
                      </div>

                      {lead?.address && (
                        <p className="rounded-2xl border border-border/50 bg-muted/[0.16] p-3 text-sm text-muted-foreground">
                          {lead.address}
                        </p>
                      )}
                    </div>

                    <div className="flex min-w-[230px] flex-col gap-2">
                      {lead && (
                        <Button
                          variant="outline"
                          className="gap-1.5"
                          onClick={(event) => openLeadFromClick(event, lead.id, navigate)}
                        >
                          <ExternalLink className="h-4 w-4" />
                          Open lead
                        </Button>
                      )}

                      {reviewer ? (
                        <>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button className="gap-1.5" disabled={busy}>
                                <CheckCircle2 className="h-4 w-4" />
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
                              <Button variant="outline" className="gap-1.5" disabled={busy}>
                                <XCircle className="h-4 w-4" />
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
                        </>
                      ) : (
                        <p className="rounded-xl border border-border/60 px-3 py-2 text-center text-xs text-muted-foreground">
                          Waiting for CS Admin or Admin approval
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
