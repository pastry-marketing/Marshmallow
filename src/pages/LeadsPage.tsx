import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-paginate";
import * as XLSX from "xlsx";
import { useDeferredValue } from "react";
import { useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Lead, LeadStatus, STATUS_LABELS, STATUS_DOT_COLORS, ALL_LEAD_STATUSES, compareLeadDisplayPriority } from "@/lib/constants";
import { countTechs } from "@/lib/lead-techs";
import { buildNearbyUrgentMap, isUrgentLead } from "@/lib/lead-proximity";
import { preloadZipDataset } from "@/lib/zipCentroids";
import { useAllowedStatuses } from "@/hooks/useAllowedStatuses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { type DateRange } from "react-day-picker";
import { ScheduleDateFilter } from "@/components/leads/ScheduleDateFilter";
import { doesLeadMatchScheduleDateRange } from "@/lib/schedule-date-filter";
import { Plus, Search, Download, Share2, X, SlidersHorizontal, BarChart3, Puzzle, FileText, Calendar as CalendarIcon, LayoutGrid, List, MapPin } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useNotepad } from "@/contexts/NotepadContext";
import LeadCard from "@/components/leads/LeadCard";
import OprLeadCard from "@/components/leads/OprLeadCard";
import LeadTable from "@/components/leads/LeadTable";
import type { LeadCancellationRequest } from "@/types";
import AddLeadDialog from "@/components/leads/AddLeadDialog";
import LeadReportDialog from "@/components/leads/LeadReportDialog";
import ExportLeadsDialog, { ExportOptions } from "@/components/leads/ExportLeadsDialog";
import InstallExtensionDialog from "@/components/leads/InstallExtensionDialog";
import { toast } from "sonner";
import { isOperatorRole } from "@/lib/access";


import { motion } from "framer-motion";
import { heroTitle, premiumEase, silkySpring, cardGridContainer, cardGridItem } from "@/lib/motion";

const PAGE_SIZES = [20, 40, 60, 100];

interface ProfileRow {
  id: string;
  full_name: string;
}

interface LeadShareRow {
  lead_id: string;
}

interface LeadNoteExportRow {
  lead_id: string;
  note_type: "general" | "cs" | "processor";
  content: string;
  user_id: string | null;
  user_name?: string | null;
  created_at: string | null;
}

export default function LeadsPage() {
  const { user, role } = useAuth();
  const { toggleNotepad, isNotepadOpen, activeUserIds } = useNotepad();
  const isAnyNotepadOpen = activeUserIds.length > 0;
  const [searchParams, setSearchParams] = useSearchParams();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [sharedLeads, setSharedLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("search") || "");
  const [scheduleDateRange, setScheduleDateRange] = useState<DateRange | undefined>();
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<"my" | "shared">("my");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "table">(() => {
    return (localStorage.getItem("leadsViewMode") as "grid" | "table") || "grid";
  });

  useEffect(() => {
    localStorage.setItem("leadsViewMode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (search) params.set("search", search);
    else params.delete("search");
    
    // Only update if it actually changed to avoid infinite re-renders
    if (params.toString() !== searchParams.toString()) {
      setSearchParams(params, { replace: true });
    }
  }, [search, searchParams, setSearchParams]);
  const [pagedMetadata, setPagedMetadata] = useState<Record<string, {
    hasNotes: { general: boolean; cs: boolean; processor: boolean; opr: boolean };
    techCount: number;
    photoCount: number;
    photoPaths: string[];
    pendingCancellationRequest: LeadCancellationRequest | null;
    cancellationReason: string | null;
  }>>({});
  const [metadataFallbackKey, setMetadataFallbackKey] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);

  const rawStatusFilter = searchParams.get("status") || "all";
  const isAdmin = role === "admin";
  const isCS = role === "customer_service";
  // CS Admins create leads with the same access a CS has.
  const canCreateLead = isAdmin || isCS || role === "cs_admin";

  const { filterLeads, allowedStatuses } = useAllowedStatuses();

  const safeStatusFilter =
    rawStatusFilter === "all" ||
    allowedStatuses.has(rawStatusFilter) ||
    (isOperatorRole(role) && leads.some((l) => Boolean(l.cs_tag) && l.status === rawStatusFilter))
      ? rawStatusFilter
      : "all";

  useEffect(() => {
    if (rawStatusFilter !== safeStatusFilter) {
      if (safeStatusFilter === "all") setSearchParams({});
      else setSearchParams({ status: safeStatusFilter });
    }
  }, [rawStatusFilter, safeStatusFilter, setSearchParams]);

  const setStatusFilter = (value: string) => {
    setPage(0);
    if (value === "all") setSearchParams({});
    else setSearchParams({ status: value });
  };

  const fetchProfiles = useCallback(async () => {
    const { data, error } = await supabase.from("profiles_public" as never).select("id, full_name") as { data: { id: string; full_name: string | null }[] | null; error: unknown };

    if (error) {
      toast.error((error as { message?: string })?.message ?? "Failed to load users");
      return;
    }

    if (data) {
      const map: Record<string, string> = {};
      (data as ProfileRow[]).forEach((p) => {
        map[p.id] = p.full_name;
      });
      setProfiles(map);
    }
  }, []);

  const fetchLeads = useCallback(async (isBackground = false) => {
    if (!user || !role) return;

    if (!isBackground) setLoading(true);

    try {
      // Page through the whole table so status tabs/counts reflect every lead,
      // not just the newest 1000 (PostgREST's default single-response cap).
      const all = await fetchAllRows<Lead>((from, to) => {
        let query = supabase
          .from("leads")
          .select("*")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to);
        // CS can see only own created leads
        if (role === "customer_service") {
          query = query.eq("created_by", user.id);
        }
        return query;
      });
      setLeads(all);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load leads");
      setLeads([]);
    }

    if (!isBackground) setLoading(false);
  }, [role, user]);

  const fetchSharedLeads = useCallback(async () => {
    if (!user || role !== "customer_service") return;

    const { data: shares, error: sharesError } = await supabase
      .from("lead_shares")
      .select("lead_id")
      .eq("shared_with_user_id", user.id);

    if (sharesError) {
      toast.error(sharesError.message);
      setSharedLeads([]);
      return;
    }

    if (!shares || shares.length === 0) {
      setSharedLeads([]);
      return;
    }

    const leadIds = (shares as LeadShareRow[]).map((share) => share.lead_id);

    const { data: leadsData, error: leadsError } = await supabase
      .from("leads")
      .select("*")
      .in("id", leadIds)
      .order("created_at", { ascending: false });

    if (leadsError) {
      toast.error(leadsError.message);
      setSharedLeads([]);
      return;
    }

    setSharedLeads((leadsData ?? []) as Lead[]);
  }, [role, user]);

  useEffect(() => {
    if (!user || !role) return;

    void fetchLeads();
    void fetchProfiles();

    if (role === "customer_service") {
      void fetchSharedLeads();
    } else {
      setSharedLeads([]);
    }
  }, [fetchLeads, fetchProfiles, fetchSharedLeads, role, user]);

  // Fallback Polling every 15 seconds (bulletproof fallback if Realtime is blocked by RLS)
  useEffect(() => {
    if (!user || !role) return;
    
    const intervalId = setInterval(() => {
      void fetchLeads(true);
      if (role === "customer_service") {
        void fetchSharedLeads();
      }
    }, 15000);

    return () => clearInterval(intervalId);
  }, [fetchLeads, fetchSharedLeads, user, role]);




  // Realtime subscription for leads table updates & Activate Customer chime
  useEffect(() => {
    if (!user || !role) return;

    const channel = supabase
      .channel("leads-realtime-page")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "leads",
        },
        (payload) => {
          const newRow = payload.new as Lead | undefined;
          const oldRow = payload.old as Lead | undefined;

          // Surgical merge — no full refetch needed
          if (payload.eventType === "INSERT" && newRow) {
            // Only add if this user should see the lead
            const shouldSee =
              role === "admin" || role === "processor" || role === "cs_admin" || isOperatorRole(role) ||
              (role === "customer_service" && newRow.created_by === user.id);
            if (shouldSee) {
              setLeads((prev) => [newRow, ...prev]);
            }
          } else if (payload.eventType === "UPDATE" && newRow) {
            setLeads((prev) =>
              prev.map((l) => (l.id === newRow.id ? { ...l, ...newRow } : l))
            );
            // Also update shared leads if applicable
            if (role === "customer_service") {
              setSharedLeads((prev) =>
                prev.map((l) => (l.id === newRow.id ? { ...l, ...newRow } : l))
              );
            }
          } else if (payload.eventType === "DELETE" && oldRow) {
            setLeads((prev) => prev.filter((l) => l.id !== oldRow.id));
            if (role === "customer_service") {
              setSharedLeads((prev) => prev.filter((l) => l.id !== oldRow.id));
            }
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [role, user]);

  const visibleMyLeads = useMemo(() => filterLeads([...leads]), [leads, filterLeads]);
  const visibleSharedLeads = useMemo(() => [...sharedLeads], [sharedLeads]);

  const currentLeads = activeTab === "shared" ? visibleSharedLeads : visibleMyLeads;

  // Distances come from the US ZIP centroid dataset, which is ~1.8MB and loaded lazily. Only
  // pulled in when there are urgent leads to compare, and the flag re-runs the grouping below
  // once it is in memory.
  const [zipDataReady, setZipDataReady] = useState(false);
  const hasUrgentLeads = useMemo(() => currentLeads.some((l) => isUrgentLead(l.status)), [currentLeads]);

  useEffect(() => {
    if (!hasUrgentLeads || zipDataReady) return;
    let active = true;
    void preloadZipDataset().then(() => {
      if (active) setZipDataReady(true);
    });
    return () => {
      active = false;
    };
  }, [hasUrgentLeads, zipDataReady]);

  // Derived from the live leads state, so a status change anywhere updates every card in the
  // cluster at once - the realtime subscription already keeps that state current.
  const nearbyUrgentMap = useMemo(
    () => buildNearbyUrgentMap(currentLeads),
    // zipDataReady is not read here, but recomputing once the centroids land is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentLeads, zipDataReady],
  );

  const filtered = useMemo(() => {
    let result = [...currentLeads];

    if (safeStatusFilter !== "all") {
      result = result.filter((l) => l.status === safeStatusFilter);
    }

    if (deferredSearch) {
      const s = deferredSearch.toLowerCase();
      result = result.filter(
        (l) =>
          l.customer_name?.toLowerCase().includes(s) ||
          l.job_id?.toLowerCase().includes(s) ||
          l.customer_phone?.toLowerCase().includes(s) ||
          l.customer_landline?.toLowerCase().includes(s) ||
          l.address?.toLowerCase().includes(s) ||
          l.city?.toLowerCase().includes(s) ||
          l.state?.toLowerCase().includes(s) ||
          l.service_type?.toLowerCase().includes(s),
      );
    }

    if (scheduleDateRange?.from) {
      result = result.filter((l) =>
        doesLeadMatchScheduleDateRange(l.customer_schedule_requirements, scheduleDateRange)
      );
    }

    result.sort((a, b) => compareLeadDisplayPriority(a, b, user?.id, role));

    return result;
  }, [currentLeads, deferredSearch, safeStatusFilter, scheduleDateRange, user?.id, role]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => {
    if (filtered.length === 0 && page !== 0) {
      setPage(0);
      return;
    }

    if (totalPages > 0 && page >= totalPages) {
      setPage(totalPages - 1);
    }
  }, [filtered.length, page, totalPages]);

  const pagedIdsStr = paged.map((l) => l.id).join(",");
  const usingMetadataFallback = metadataFallbackKey === pagedIdsStr;
  const pagedMetadataReady = usingMetadataFallback
    || paged.every((lead) => pagedMetadata[lead.id] !== undefined);

  useEffect(() => {
    let active = true;
    const loadPagedMetadata = async () => {
      const pagedIds = pagedIdsStr ? pagedIdsStr.split(",") : [];
      if (pagedIds.length === 0) {
        setPagedMetadata({});
        setMetadataFallbackKey(null);
        return;
      }

      setMetadataFallbackKey(null);

      try {
        const [notesRes, techNotesRes, photosRes, cancelRes] = await Promise.all([
          supabase
            .from("lead_notes")
            .select("lead_id, note_type")
            .in("lead_id", pagedIds),
          // Bodies of the processor notes only, so the card can show how many techs are inside
          // without pulling every note body on the page.
          supabase
            .from("lead_notes")
            .select("lead_id, content")
            .eq("note_type", "processor")
            .in("lead_id", pagedIds),
          supabase
            .from("lead_photos")
            .select("lead_id, photo_url, created_at")
            .in("lead_id", pagedIds)
            .order("created_at", { ascending: true }),
          // Not filtered to pending any more: the newest request per lead also supplies the
          // reason shown on a cancelled card, without a second round trip.
          supabase
            .from("lead_cancellation_requests")
            .select("*")
            .in("lead_id", pagedIds)
            .order("created_at", { ascending: false })
        ]);

        if (!active) return;
        const batchError = notesRes.error || techNotesRes.error || photosRes.error || cancelRes.error;
        if (batchError) throw batchError;

        const metadataMap: Record<string, {
          hasNotes: { general: boolean; cs: boolean; processor: boolean; opr: boolean };
          techCount: number;
          photoCount: number;
          photoPaths: string[];
          pendingCancellationRequest: LeadCancellationRequest | null;
          cancellationReason: string | null;
        }> = {};

        pagedIds.forEach((id) => {
          metadataMap[id] = {
            hasNotes: { general: false, cs: false, processor: false, opr: false },
            techCount: 0,
            photoCount: 0,
            photoPaths: [],
            pendingCancellationRequest: null,
            cancellationReason: null,
          };
        });

        if (notesRes.data) {
          notesRes.data.forEach((note) => {
            const mapItem = metadataMap[note.lead_id];
            if (mapItem) {
              if (note.note_type === "general") mapItem.hasNotes.general = true;
              else if (note.note_type === "cs") mapItem.hasNotes.cs = true;
              else if (note.note_type === "processor") mapItem.hasNotes.processor = true;
              else if (note.note_type === "opr") mapItem.hasNotes.opr = true;
            }
          });
        }

        if (techNotesRes.data) {
          const byLead = new Map<string, string[]>();
          (techNotesRes.data as { lead_id: string; content: string | null }[]).forEach((note) => {
            const bodies = byLead.get(note.lead_id) ?? [];
            bodies.push(note.content ?? "");
            byLead.set(note.lead_id, bodies);
          });

          byLead.forEach((bodies, leadIdKey) => {
            const mapItem = metadataMap[leadIdKey];
            if (mapItem) mapItem.techCount = countTechs(bodies);
          });
        }

        if (photosRes.data) {
          photosRes.data.forEach((photo) => {
            const mapItem = metadataMap[photo.lead_id];
            if (mapItem) {
              mapItem.photoCount += 1;
              mapItem.photoPaths.push(photo.photo_url);
            }
          });
        }

        if (cancelRes.data) {
          // Rows arrive newest first, so the first one seen for a lead is its latest request.
          const seenLatest = new Set<string>();

          cancelRes.data.forEach((req) => {
            const mapItem = metadataMap[req.lead_id];
            if (!mapItem) return;

            const requestCopy = { ...req } as unknown as LeadCancellationRequest;
            if (requestCopy.requested_by) {
              requestCopy.requester_name = profiles[requestCopy.requested_by] || requestCopy.requested_by_name || null;
            } else {
              requestCopy.requester_name = requestCopy.requested_by_name || null;
            }

            if (requestCopy.status === "pending") {
              mapItem.pendingCancellationRequest = requestCopy;
            }

            if (!seenLatest.has(req.lead_id)) {
              seenLatest.add(req.lead_id);
              mapItem.cancellationReason = requestCopy.comment || null;
            }
          });
        }

        setPagedMetadata(metadataMap);
      } catch (err) {
        console.error("Failed to load paged metadata", err);
        if (active) setMetadataFallbackKey(pagedIdsStr);
      }
    };

    void loadPagedMetadata();

    return () => {
      active = false;
    };
  }, [pagedIdsStr, profiles]);

  const countSource = activeTab === "shared" ? visibleSharedLeads : visibleMyLeads;

  const urgentCount = countSource.filter((l) => l.status === "urgent_job").length;
  const scheduledCount = countSource.filter((l) => l.status === "scheduled").length;
  const activeCount = countSource.filter(
    (l) => l.status !== "cancelled" && l.status !== "paid" && l.status !== "job_done",
  ).length;
  const hasActiveFilters = Boolean(search) || safeStatusFilter !== "all" || Boolean(scheduleDateRange?.from);

  const handleExportData = async (options: ExportOptions) => {
    setIsExporting(true);
    try {
      const allLeadMap = new Map<string, Lead>();
      leads.forEach((l) => allLeadMap.set(l.id, l));
      sharedLeads.forEach((l) => allLeadMap.set(l.id, l));
      const allLeadsList = Array.from(allLeadMap.values());

      let baseLeads = options.scope === "current" ? filtered : allLeadsList;

      // Apply Date Filter
      if (options.dateRangePreset !== "all_time") {
        const now = new Date();
        let startDate: Date | undefined;
        let endDate: Date | undefined = new Date();

        if (options.dateRangePreset === "custom") {
          if (options.customDateRange?.from) {
            startDate = new Date(options.customDateRange.from);
            startDate.setHours(0, 0, 0, 0);
            endDate = options.customDateRange.to
              ? new Date(options.customDateRange.to)
              : new Date(options.customDateRange.from);
            endDate.setHours(23, 59, 59, 999);
          }
        } else if (options.dateRangePreset === "today") {
          startDate = new Date(now.setHours(0, 0, 0, 0));
        } else if (options.dateRangePreset === "yesterday") {
          startDate = new Date(now.setHours(0, 0, 0, 0));
          startDate.setDate(startDate.getDate() - 1);
          endDate = new Date(startDate);
          endDate.setHours(23, 59, 59, 999);
        } else if (options.dateRangePreset === "7d") {
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        } else if (options.dateRangePreset === "30d") {
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        }

        if (startDate && endDate) {
          baseLeads = baseLeads.filter((lead) => {
            if (!lead || !lead.created_at) return false;
            const created = new Date(lead.created_at).getTime();
            return created >= startDate!.getTime() && created <= endDate!.getTime();
          });
        }
      }

      // Apply Limit
      let finalLeads = baseLeads;
      if (options.limit !== "all") {
        finalLeads = finalLeads.slice(0, options.limit);
      }

      const leadIdsToExport = finalLeads.map((l) => l.id);

      if (leadIdsToExport.length === 0) {
        toast.error("No leads match the selected criteria for export.");
        setIsExporting(false);
        return;
      }

      const noteSummaryByLead: Record<string, { general: string; cs: string; processor: string }> = {};
      let noteRows: LeadNoteExportRow[] = [];
      const chunkSize = 100;

      for (let i = 0; i < leadIdsToExport.length; i += chunkSize) {
        const chunk = leadIdsToExport.slice(i, i + chunkSize);
        const { data: chunkRows, error } = await supabase
          .from("lead_notes")
          .select("lead_id, note_type, content, user_id, user_name, created_at")
          .in("lead_id", chunk)
          .order("created_at", { ascending: true });

        if (error) {
          toast.error(`Failed to prepare note export: ${error.message}`);
          setIsExporting(false);
          return;
        }
        if (chunkRows) {
          noteRows = noteRows.concat(chunkRows as LeadNoteExportRow[]);
        }
      }

      (noteRows as LeadNoteExportRow[] | null)?.forEach((note) => {
        const key = note.note_type;
        if (!noteSummaryByLead[note.lead_id]) {
          noteSummaryByLead[note.lead_id] = { general: "", cs: "", processor: "" };
        }
        noteSummaryByLead[note.lead_id][key as keyof typeof noteSummaryByLead[string]] += `[${new Date(note.created_at || "").toLocaleString()}] ${note.user_name || "Unknown"}: ${note.content}\n\n`;
      });

      const exportRows = leadIdsToExport.map((id) => {
        const lead = allLeadMap.get(id);
        return {
          "Job ID": lead?.job_id,
          "Reference Name": lead?.reference_name,
          Status: lead?.status,
          "Customer Name": lead?.customer_name,
          "Customer Phone": lead?.customer_phone,
          "Customer Address": lead?.address,
          "Date Received": lead?.created_at ? new Date(lead.created_at).toLocaleString() : "",
          "Schedule Requirement": lead?.customer_schedule_requirements,
          "Assigned Technician": lead?.tech_name || "",
          "General Notes": noteSummaryByLead[id]?.general || "",
          "CS Notes": noteSummaryByLead[id]?.cs || "",
          "Processor Notes": noteSummaryByLead[id]?.processor || "",
        };
      });

      const ws = XLSX.utils.json_to_sheet(exportRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Leads");

      const filename = `leads_${new Date().toISOString().slice(0, 10)}`;
      XLSX.writeFile(wb, `${filename}.${options.format}`, options.format === "csv" ? { bookType: "csv" } : undefined);

      toast.success(`Exported ${exportRows.length} leads successfully`);
      setShowExportDialog(false);
    } catch (err: any) {
      toast.error(`Export failed: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Drops a deleted lead from the list at once, so the card goes when the toast appears rather
  // than when the refetch lands.
  const handleLeadDeleted = useCallback((leadId: string) => {
    setLeads((prev) => prev.filter((l) => l.id !== leadId));
    setSharedLeads((prev) => prev.filter((l) => l.id !== leadId));
  }, []);

  const handleRefresh = useCallback(async () => {
    await fetchLeads();
    if (role === "customer_service") {
      await fetchSharedLeads();
    }
  }, [fetchLeads, fetchSharedLeads, role]);

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <motion.section
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: premiumEase }}
        className="glass-panel-strong relative overflow-visible rounded-[32px] px-5 py-5 shadow-[0_38px_82px_-42px_rgba(59,130,246,0.28),0_18px_32px_-24px_rgba(125,211,252,0.18)] sm:px-6 sm:py-6 dark:bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_28%),radial-gradient(circle_at_top_right,hsl(198_100%_62%/0.10),transparent_24%),linear-gradient(180deg,hsl(var(--card)/0.84),hsl(var(--muted)/0.30))] dark:shadow-none"
      >
        <div className="pointer-events-none absolute inset-0 rounded-[32px] overflow-hidden bg-[radial-gradient(circle_at_top_left,hsl(194_100%_86%/0.22),transparent_30%),radial-gradient(circle_at_top_right,hsl(211_100%_88%/0.24),transparent_30%),radial-gradient(circle_at_bottom_left,hsl(188_100%_90%/0.16),transparent_26%)]" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <motion.div variants={heroTitle} initial="initial" animate="animate">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/10 bg-primary/[0.06] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
            <span className="h-2 w-2 rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.6)]" />
            Lead Workspace
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-[-0.04em] text-foreground">
            {safeStatusFilter !== "all" ? (
              <span className="flex items-center gap-2.5">
                <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT_COLORS[safeStatusFilter as LeadStatus]}`} />
                {STATUS_LABELS[safeStatusFilter as LeadStatus]}
              </span>
            ) : activeTab === "shared" ? (
              "Shared Leads"
            ) : (
              "All Leads"
            )}
          </h1>
          <p className="mt-2 max-w-2xl text-[15px] leading-6 text-muted-foreground/90">
            {filtered.length} lead{filtered.length !== 1 ? "s" : ""}
            {totalPages > 1 && ` · Page ${page + 1} of ${totalPages}`}
            {" · "}Search fast, change status quickly, and keep work moving without clutter.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.15, duration: 0.35 }}
          className="flex items-center gap-2 flex-wrap"
        >
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-[12px] h-9 border-border/60 hover:bg-muted/30"
              onClick={() => setShowExportDialog(true)}
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowInstallDialog(true)}
            className="gap-1.5 text-[12px] h-9 border-border/60 hover:bg-muted/30"
          >
            <Puzzle className="h-3.5 w-3.5" />
            Extension
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => toggleNotepad()}
            className={`gap-1.5 text-[12px] h-9 border-border/60 ${
              isAnyNotepadOpen ? "bg-primary/10 border-primary/30 text-primary" : "hover:bg-muted/30"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            Notepad
          </Button>

          {(isAdmin || isCS) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowReportDialog(true)}
              className="gap-1.5 text-[12px] h-9 border-border/60 hover:bg-muted/30"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Report
            </Button>
          )}

          <ScheduleDateFilter
            date={scheduleDateRange}
            setDate={(range) => {
              setScheduleDateRange(range);
              setPage(0);
            }}
            leads={leads}
          />

          {canCreateLead && (
            <Button onClick={() => setShowAddDialog(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              New Lead
            </Button>
          )}

          <AddLeadDialog
            open={showAddDialog}
            onOpenChange={setShowAddDialog}
            onSuccess={() => {
              fetchLeads();
              if (role === "customer_service") {
                fetchSharedLeads();
              }
            }}
          />

          <LeadReportDialog
            open={showReportDialog}
            onOpenChange={setShowReportDialog}
          />
        <ExportLeadsDialog
          open={showExportDialog}
          onOpenChange={setShowExportDialog}
          onExport={handleExportData}
          isExporting={isExporting}
          totalFiltered={filtered.length}
        />

          <InstallExtensionDialog
            open={showInstallDialog}
            onOpenChange={setShowInstallDialog}
          />
        </motion.div>
        </div>
      </motion.section>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        <motion.div whileHover={{ y: -3 }} transition={silkySpring} className="glass-panel rounded-[26px] p-4 shadow-[0_28px_54px_-34px_rgba(59,130,246,0.22)] dark:bg-[linear-gradient(180deg,hsl(var(--card)/0.86),hsl(var(--muted)/0.28))] dark:shadow-none">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">Active Pipeline</p>
          <div className="mt-3 flex items-end justify-between gap-3">
            <span className="text-3xl font-semibold tracking-[-0.04em] text-foreground tabular-nums">{activeCount}</span>
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-primary/10 bg-primary/[0.08]">
              <span className="h-2.5 w-2.5 rounded-full bg-primary" />
            </span>
          </div>
        </motion.div>

        {urgentCount > 0 && (
          <motion.div whileHover={{ y: -3 }} transition={silkySpring} className="rounded-[26px] border border-destructive/22 bg-[radial-gradient(circle_at_top_left,hsl(var(--destructive)/0.12),transparent_34%),linear-gradient(180deg,hsl(0_0%_100%/0.8),hsl(12_100%_97%/0.64))] p-4 shadow-[0_26px_50px_-30px_rgba(239,68,68,0.18),0_12px_24px_-20px_rgba(251,146,60,0.12)] dark:border-destructive/18 dark:bg-[radial-gradient(circle_at_top_left,hsl(var(--destructive)/0.12),transparent_34%),linear-gradient(180deg,hsl(225_28%_18%/0.96),hsl(226_26%_15%/0.92))] dark:shadow-[0_22px_42px_-30px_rgba(239,68,68,0.22)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-destructive/75">Urgent Attention</p>
            <div className="mt-3 flex items-end justify-between gap-3">
              <span className="text-3xl font-semibold tracking-[-0.04em] text-destructive tabular-nums">{urgentCount}</span>
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-destructive/15 bg-destructive/[0.1] dark:border-destructive/22 dark:bg-destructive/[0.14]">
                <span className="h-2.5 w-2.5 rounded-full bg-destructive status-pulse" />
              </span>
            </div>
          </motion.div>
        )}

        {scheduledCount > 0 && (
          <motion.div whileHover={{ y: -3 }} transition={silkySpring} className="glass-panel rounded-[26px] p-4 shadow-[0_28px_54px_-34px_rgba(59,130,246,0.22)] dark:bg-[linear-gradient(180deg,hsl(var(--card)/0.86),hsl(var(--muted)/0.28))] dark:shadow-none">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">Scheduled Jobs</p>
            <div className="mt-3 flex items-end justify-between gap-3">
              <span className="text-3xl font-semibold tracking-[-0.04em] text-foreground tabular-nums">{scheduledCount}</span>
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-primary/10 bg-primary/[0.06]">
                <span className="h-2.5 w-2.5 rounded-full bg-primary/60" />
              </span>
            </div>
          </motion.div>
        )}
      </motion.div>

      {isCS && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="glass-panel inline-flex gap-1 rounded-[22px] p-1.5 dark:bg-[linear-gradient(180deg,hsl(var(--card)/0.84),hsl(var(--muted)/0.28))]"
          role="tablist"
          aria-label="Lead ownership"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "my"}
            onClick={() => {
              setActiveTab("my");
              setPage(0);
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 ${
              activeTab === "my"
                ? "crm-lead-card-inner text-foreground shadow-[0_12px_24px_-18px_rgba(59,130,246,0.2)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            My Leads
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "shared"}
            onClick={() => {
              setActiveTab("shared");
              setPage(0);
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 flex items-center gap-1.5 ${
              activeTab === "shared"
                ? "crm-lead-card-inner text-foreground shadow-[0_12px_24px_-18px_rgba(59,130,246,0.2)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Share2 className="h-3.5 w-3.5" />
            Shared with me
            {visibleSharedLeads.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                {visibleSharedLeads.length}
              </span>
            )}
          </button>
        </motion.div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="glass-panel-strong rounded-[30px] p-3 shadow-[0_34px_74px_-40px_rgba(59,130,246,0.24)] dark:bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.10),transparent_24%),linear-gradient(180deg,hsl(var(--card)/0.84),hsl(var(--muted)/0.30))] dark:shadow-none"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-1 pb-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Refine Results</p>
            <p className="mt-1 text-[13px] text-muted-foreground">Search, filter, and resize the workspace without losing context.</p>
          </div>
          {hasActiveFilters && (
            <Button
              type="button"
              variant="ghost"
              className="h-10 rounded-xl px-4"
              onClick={() => {
                setSearch("");
                setStatusFilter("all");
                setScheduleDateRange(undefined);
              }}
            >
              Clear Filters
            </Button>
          )}
        </div>
        <div className="crm-lead-card-soft flex flex-col gap-3 rounded-[26px] p-3.5 shadow-[0_20px_34px_-26px_rgba(59,130,246,0.18)] lg:flex-row lg:items-center dark:shadow-none">
          <div className="relative flex-1 group">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/40 transition-colors group-focus-within:text-primary" />
            <Input
              placeholder="Search by name, phone, address, job ID..."
              className="crm-lead-card-inner h-11 rounded-[18px] border-border/70 bg-transparent pl-10 pr-10 shadow-[0_22px_32px_-24px_rgba(59,130,246,0.18)]"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setPage(0);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Clear lead search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Select value={safeStatusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="crm-lead-card-inner h-11 w-full rounded-[18px] border-border/70 bg-transparent shadow-[0_18px_28px_-22px_rgba(56,189,248,0.2)] sm:w-[220px]">
                <SlidersHorizontal className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {ALL_LEAD_STATUSES.filter((s) => allowedStatuses.has(s) || (isOperatorRole(role) && leads.some((l) => Boolean(l.cs_tag) && l.status === s))).map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_COLORS[s]}`} />
                      {STATUS_LABELS[s]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={String(pageSize)}
              onValueChange={(v) => {
                setPageSize(Number(v));
                setPage(0);
              }}
            >
              <SelectTrigger className="crm-lead-card-inner h-11 w-full rounded-[18px] border-border/70 bg-transparent shadow-[0_18px_28px_-22px_rgba(56,189,248,0.2)] sm:w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    Show {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center rounded-2xl border border-border/70 bg-transparent p-1 shadow-[0_18px_28px_-22px_rgba(56,189,248,0.2)] crm-lead-card-inner h-11">
              <Button
                variant="ghost"
                size="sm"
                className={`h-full rounded-xl px-3 ${viewMode === "grid" ? "bg-background shadow-sm" : "hover:bg-muted/50"}`}
                onClick={() => setViewMode("grid")}
                aria-label="Use lead card view"
                aria-pressed={viewMode === "grid"}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`h-full rounded-xl px-3 ${viewMode === "table" ? "bg-background shadow-sm" : "hover:bg-muted/50"}`}
                onClick={() => setViewMode("table")}
                aria-label="Use lead table view"
                aria-pressed={viewMode === "table"}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </motion.div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-56 rounded-xl skeleton-shimmer border border-border/30" />
          ))}
        </div>
      ) : paged.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35 }}
        >
          <Card className="crm-lead-card flex min-h-[260px] flex-col items-center justify-center gap-3 border-dashed border-2 px-6 text-center shadow-[0_34px_74px_-40px_rgba(59,130,246,0.22)] dark:shadow-none">
            <div className="crm-lead-card-inner flex h-14 w-14 items-center justify-center rounded-2xl">
              <Search className="h-5 w-5 text-muted-foreground/30" />
            </div>
            <p className="font-medium text-foreground text-base">
              {activeTab === "shared" ? "No leads have been shared with you yet" : "No leads found"}
            </p>
            <p className="max-w-sm text-[13px] text-muted-foreground">
              {search || safeStatusFilter !== "all" || scheduleDateRange?.from
                ? "Try adjusting your search or filter"
                : 'Click "New Lead" to get started'}
            </p>
            {hasActiveFilters && (
              <Button
                type="button"
                variant="outline"
                className="mt-1 rounded-xl"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                  setScheduleDateRange(undefined);
                }}
              >
                Reset Filters
              </Button>
            )}
          </Card>
        </motion.div>
      ) : viewMode === "table" ? (
        <LeadTable leads={paged} />
      ) : (
        <motion.div
          variants={cardGridContainer}
          initial="initial"
          animate="animate"
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
        >
          {paged.map((lead) => {
            const metadata = usingMetadataFallback ? undefined : pagedMetadata[lead.id];
            return (
            <motion.div key={lead.id} variants={cardGridItem}>
              <LeadCard
                lead={lead}
                profiles={profiles}
                onRefresh={handleRefresh}
                onDeleted={handleLeadDeleted}
                nearbyUrgentLeads={nearbyUrgentMap.get(lead.id)}
                initialHasNotes={metadata?.hasNotes}
                initialTechCount={metadata?.techCount}
                initialCancellationReason={metadata?.cancellationReason}
                initialPhotoCount={metadata?.photoCount}
                initialPhotoPaths={metadata?.photoPaths}
                initialPendingCancellationRequest={metadata?.pendingCancellationRequest}
              />
            </motion.div>
            );
          })}
        </motion.div>
      )}

      {totalPages > 1 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="flex items-center justify-center gap-1.5 pt-2"
        >
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>

          <div className="flex gap-1">
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              let p = i;

              if (totalPages > 7) {
                if (page < 4) p = i;
                else if (page > totalPages - 5) p = totalPages - 7 + i;
                else p = page - 3 + i;
              }

              return (
                <Button
                  key={p}
                  variant={p === page ? "default" : "outline"}
                  size="sm"
                  className="w-9"
                  onClick={() => setPage(p)}
                >
                  {p + 1}
                </Button>
              );
            })}
          </div>

          <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </motion.div>
      )}
    </div>
  );
}





