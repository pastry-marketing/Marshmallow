import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { motion } from "framer-motion";
import { Megaphone, Send, AlertCircle, Circle, Trash2 } from "lucide-react";
import type { AppRole } from "@/types";

const AFFECTED_SECTIONS = [
  { value: "general", label: "General / Entire CRM" },
  { value: "leads", label: "All Leads" },
  { value: "quo_monitor", label: "Quo AI Assistant" },
  { value: "cancellation_requests", label: "Lead Cancellation Requests" },
  { value: "payment_requests", label: "Paid Approval Pending" },
  { value: "schedule", label: "Schedule" },
  { value: "analytics", label: "Analytics" },
  { value: "areas", label: "Area Insights" },
  { value: "activity_logs", label: "Activity Logs" },
  { value: "settings", label: "Settings" },
];

// Every role an update can be aimed at. Labels match the role picker in
// Settings, so the same role reads the same way in both places.
const ROLES: { value: AppRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "processor", label: "Processor" },
  { value: "customer_service", label: "Customer Service" },
  { value: "cs_admin", label: "CS Admin" },
  { value: "opr", label: "OPR (Operator)" },
  { value: "opr_admin", label: "OPR Admin" },
];

interface CrmUpdate {
  id: string;
  title: string;
  description: string;
  affected_section: string;
  target_roles: string[];
  priority: "normal" | "important";
  is_active: boolean;
  published_at: string;
  created_at: string;
}

export default function CrmUpdates() {
  const { user, role } = useAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [section, setSection] = useState("");
  const [priority, setPriority] = useState<"normal" | "important">("normal");
  const [selectedRoles, setSelectedRoles] = useState<AppRole[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<CrmUpdate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: history = [], isLoading } = useQuery({
    queryKey: ["crm-updates-history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_updates" as never)
        .select("*")
        .order("published_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CrmUpdate[];
    },
    enabled: role === "admin",
  });

  const toggleRole = (r: AppRole) => {
    setSelectedRoles((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = "Title is required";
    if (!description.trim()) next.description = "Description is required";
    if (!section) next.section = "Please select an affected section";
    if (selectedRoles.length === 0) next.roles = "Select at least one role";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handlePublish = async () => {
    if (!validate()) return;
    setSubmitting(true);
    const { error } = await supabase.from("crm_updates" as never).insert({
      title: title.trim(),
      description: description.trim(),
      affected_section: section,
      target_roles: selectedRoles,
      priority,
      is_active: true,
      created_by: user?.id ?? null,
      published_at: new Date().toISOString(),
    } as never);
    setSubmitting(false);
    if (error) {
      toast({ title: "Failed to publish", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Update published", description: "Targeted users will see it live." });
    setTitle("");
    setDescription("");
    setSection("");
    setPriority("normal");
    setSelectedRoles([]);
    setErrors({});
    queryClient.invalidateQueries({ queryKey: ["crm-updates-history"] });
  };

  const toggleActive = async (item: CrmUpdate) => {
    const { error } = await supabase
      .from("crm_updates" as never)
      .update({ is_active: !item.is_active } as never)
      .eq("id", item.id);
    if (error) {
      toast({ title: "Failed", description: error.message, variant: "destructive" });
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["crm-updates-history"] });
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase
      .from("crm_updates" as never)
      .delete()
      .eq("id", deleteTarget.id);
    setDeleting(false);
    if (error) {
      toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "CRM update deleted successfully." });
    setDeleteTarget(null);
    queryClient.invalidateQueries({ queryKey: ["crm-updates-history"] });
  };

  const sectionLabel = useMemo(
    () => Object.fromEntries(AFFECTED_SECTIONS.map((s) => [s.value, s.label])),
    [],
  );
  const roleLabel = useMemo(
    () => Object.fromEntries(ROLES.map((r) => [r.value, r.label])),
    [],
  );

  if (role !== "admin") {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Admin access required.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="mb-6"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[hsl(230,94%,66%)] text-primary-foreground shadow-[0_10px_24px_-10px_hsl(var(--primary)/0.6)]">
            <Megaphone className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">CRM Updates</h1>
            <p className="text-sm text-muted-foreground">
              Broadcast one-time live update notifications to selected CRM roles.
            </p>
          </div>
        </div>
      </motion.div>

      {/* New Update Card */}
      <Card className="rounded-3xl border border-border/60 bg-card/80 shadow-[0_20px_44px_-32px_rgba(59,130,246,0.22)]">
        <CardContent className="p-6 sm:p-8">
          <div className="mb-5 flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Send className="h-4 w-4" />
            </span>
            <h2 className="text-lg font-semibold text-foreground">New Update</h2>
          </div>

          <div className="space-y-5">
            <div>
              <Label className="mb-1.5 block text-sm font-medium">Update Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. All Leads Updated"
                maxLength={200}
                className="rounded-xl"
              />
              {errors.title && (
                <p className="mt-1 text-xs text-destructive">{errors.title}</p>
              )}
            </div>

            <div>
              <Label className="mb-1.5 block text-sm font-medium">Update Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What changed and what action, if any, should users take?"
                maxLength={2000}
                rows={4}
                className="rounded-xl"
              />
              {errors.description && (
                <p className="mt-1 text-xs text-destructive">{errors.description}</p>
              )}
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-sm font-medium">Affected Section</Label>
                <Select value={section} onValueChange={setSection}>
                  <SelectTrigger className="rounded-xl">
                    <SelectValue placeholder="Select affected section" />
                  </SelectTrigger>
                  <SelectContent>
                    {AFFECTED_SECTIONS.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.section && (
                  <p className="mt-1 text-xs text-destructive">{errors.section}</p>
                )}
              </div>

              <div>
                <Label className="mb-1.5 block text-sm font-medium">Priority</Label>
                <Select
                  value={priority}
                  onValueChange={(v) => setPriority(v as "normal" | "important")}
                >
                  <SelectTrigger className="rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="important">Important</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="mb-2 block text-sm font-medium">Target Roles</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {ROLES.map((r) => {
                  const selected = selectedRoles.includes(r.value);
                  return (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => toggleRole(r.value)}
                      className={`group flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all ${
                        selected
                          ? "border-primary/70 bg-primary/10 shadow-[0_10px_24px_-16px_hsl(var(--primary)/0.55)]"
                          : "border-border/60 bg-card hover:border-border"
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                          selected ? "border-primary bg-primary" : "border-muted-foreground/40 bg-transparent"
                        }`}
                      >
                        {selected && <span className="h-2 w-2 rounded-full bg-primary-foreground" />}
                      </span>
                      <span className={`text-sm font-medium ${selected ? "text-foreground" : "text-foreground/80"}`}>
                        {r.label}
                      </span>
                    </button>
                  );
                })}
              </div>
              {errors.roles && (
                <p className="mt-2 text-xs text-destructive">{errors.roles}</p>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handlePublish}
                disabled={submitting}
                className="rounded-xl gap-2"
                size="lg"
              >
                <Send className="h-4 w-4" />
                {submitting ? "Publishing..." : "Publish Update"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* History Card */}
      <Card className="mt-6 rounded-3xl border border-border/60 bg-card/80 shadow-[0_20px_44px_-32px_rgba(59,130,246,0.22)]">
        <CardContent className="p-6 sm:p-8">
          <h2 className="mb-4 text-lg font-semibold text-foreground">Notification History</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No updates yet.</p>
          ) : (
            <div className="space-y-3">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-border/60 bg-background/40 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                        {item.priority === "important" && (
                          <Badge variant="destructive" className="gap-1">
                            <AlertCircle className="h-3 w-3" />
                            Important
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className={
                            item.is_active
                              ? "border-emerald-400/50 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                              : "border-muted-foreground/30 bg-muted text-muted-foreground"
                          }
                        >
                          <Circle className={`mr-1 h-2 w-2 ${item.is_active ? "fill-emerald-500 text-emerald-500" : "fill-muted-foreground text-muted-foreground"}`} />
                          {item.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-sm text-muted-foreground">{item.description}</p>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span className="rounded-full bg-muted px-2 py-0.5">
                          {sectionLabel[item.affected_section] ?? item.affected_section}
                        </span>
                        {item.target_roles.map((r) => (
                          <span key={r} className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
                            {roleLabel[r] ?? r}
                          </span>
                        ))}
                        <span>
                          {format(new Date(item.published_at), "MMM d, yyyy h:mm a")}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant={item.is_active ? "outline" : "default"}
                        size="sm"
                        onClick={() => toggleActive(item)}
                        className="rounded-xl"
                      >
                        {item.is_active ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDeleteTarget(item)}
                        aria-label="Delete notification"
                        title="Delete notification"
                        className="rounded-xl border-destructive/40 bg-destructive/5 text-destructive hover:bg-destructive hover:text-destructive-foreground hover:border-destructive dark:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete CRM Update?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will permanently delete this notification and its acknowledgement records.
                  This action cannot be undone.
                </p>
                {deleteTarget && (
                  <p className="rounded-lg border border-border/60 bg-muted/50 px-3 py-2 text-sm font-medium text-foreground">
                    {deleteTarget.title}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting..." : "Delete Permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
