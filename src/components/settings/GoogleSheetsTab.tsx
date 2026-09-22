import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";
import {
  FileSpreadsheet,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Copy,
  Check,
  Zap,
  Layers,
  ArrowRight,
  Code2,
} from "lucide-react";
import {
  getGoogleSheetsConfig,
  saveGoogleSheetsConfig,
  syncAllLeadsToGoogleSheets,
  testGoogleSheetsWebhook,
  TARGET_SPREADSHEET_URL,
  type GoogleSheetsConfig,
} from "@/lib/google-sheets";

export function GoogleSheetsTab() {
  const [config, setConfig] = useState<GoogleSheetsConfig>({
    webhookUrl: "",
    autoSync: true,
    spreadsheetUrl: TARGET_SPREADSHEET_URL,
    lastSyncedAt: null,
    lastSyncStatus: "idle",
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ synced: number; total: number } | null>(null);

  useEffect(() => {
    void getGoogleSheetsConfig().then((data) => {
      setConfig(data);
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveGoogleSheetsConfig(config);
      toast.success("Google Sheets configuration saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!config.webhookUrl) {
      toast.error("Please enter a Google Apps Script Web App URL first.");
      return;
    }

    setTesting(true);
    try {
      const res = await testGoogleSheetsWebhook(config.webhookUrl);
      toast.success(res.message || "Connection successful!");
      const updated = {
        ...config,
        lastSyncStatus: "success" as const,
        lastSyncMessage: `Connected to ${res.spreadsheetName || "Google Sheet"}.`,
      };
      setConfig(updated);
      await saveGoogleSheetsConfig(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Connection test failed");
      const updated = {
        ...config,
        lastSyncStatus: "error" as const,
        lastSyncMessage: err instanceof Error ? err.message : "Connection failed",
      };
      setConfig(updated);
      await saveGoogleSheetsConfig(updated);
    } finally {
      setTesting(false);
    }
  };

  const handleSyncAll = async () => {
    if (!config.webhookUrl) {
      toast.error("Please configure and test your Webhook URL before syncing.");
      return;
    }

    setSyncingAll(true);
    setSyncProgress(null);
    try {
      const res = await syncAllLeadsToGoogleSheets((synced, total) => {
        setSyncProgress({ synced, total });
      });
      toast.success(res.message || `Successfully synced ${res.leadsCount} leads!`);
      const updated = await getGoogleSheetsConfig();
      setConfig(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
      const updated = await getGoogleSheetsConfig();
      setConfig(updated);
    } finally {
      setSyncingAll(false);
      setSyncProgress(null);
    }
  };

  const copyScriptCode = async () => {
    try {
      const response = await fetch("/google-sheets-sync.gs");
      let scriptCode = "";
      if (response.ok) {
        scriptCode = await response.text();
      } else {
        // Fallback: fetch directly or provide inline reference
        scriptCode = APPS_SCRIPT_SNIPPET;
      }

      await navigator.clipboard.writeText(scriptCode || APPS_SCRIPT_SNIPPET);
      setCopiedScript(true);
      toast.success("Apps Script code copied to clipboard!");
      setTimeout(() => setCopiedScript(false), 2500);
    } catch {
      await navigator.clipboard.writeText(APPS_SCRIPT_SNIPPET);
      setCopiedScript(true);
      toast.success("Apps Script code copied to clipboard!");
      setTimeout(() => setCopiedScript(false), 2500);
    }
  };

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isConfigured = Boolean(config.webhookUrl);

  return (
    <div className="space-y-6">
      {/* Overview Card */}
      <Card className="glass-panel border-border/60 shadow-premium-sm">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <FileSpreadsheet className="h-6 w-6" />
              </div>
              <div>
                <CardTitle className="text-lg font-semibold">Google Sheets Live Sync</CardTitle>
                <CardDescription className="text-xs">
                  Real-time bidirectional synchronization with your Google Sheet
                </CardDescription>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  isConfigured && config.lastSyncStatus === "success"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                    : isConfigured
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                    : "bg-muted text-muted-foreground border border-border/50"
                }`}
              >
                {isConfigured && config.lastSyncStatus === "success" ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Connected & Active
                  </>
                ) : isConfigured ? (
                  <>
                    <AlertCircle className="h-3.5 w-3.5" />
                    Pending Test
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-3.5 w-3.5" />
                    Setup Required
                  </>
                )}
              </span>

              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs h-8"
                onClick={() => window.open(config.spreadsheetUrl, "_blank")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Sheet
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-5 pt-0">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-border/60 bg-card/60 p-3.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Target Sheet</p>
              <p className="mt-1 font-semibold text-sm truncate text-foreground">Marshmallow CRM Leads</p>
              <a
                href={config.spreadsheetUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                View in Google Sheets <ArrowRight className="h-3 w-3" />
              </a>
            </div>

            <div className="rounded-2xl border border-border/60 bg-card/60 p-3.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Sync Engine</p>
              <p className="mt-1 font-semibold text-sm text-foreground">
                {config.autoSync ? "Instant Realtime" : "Manual Bulk"}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {config.autoSync ? "Triggers on create, edit & delete" : "Syncs on demand"}
              </p>
            </div>

            <div className="rounded-2xl border border-border/60 bg-card/60 p-3.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Last Bulk Sync</p>
              <p className="mt-1 font-semibold text-sm text-foreground">
                {config.lastSyncedAt ? new Date(config.lastSyncedAt).toLocaleString() : "Never"}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground truncate">
                {config.lastSyncMessage || "Ready to sync"}
              </p>
            </div>
          </div>

          {/* Configuration Form */}
          <div className="space-y-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
            <div className="space-y-2">
              <Label htmlFor="webhook-url" className="text-xs font-semibold text-foreground">
                Google Apps Script Web App URL (Webhook)
              </Label>
              <div className="flex gap-2">
                <Input
                  id="webhook-url"
                  type="url"
                  placeholder="https://script.google.com/macros/s/.../exec"
                  value={config.webhookUrl}
                  onChange={(e) => setConfig({ ...config, webhookUrl: e.target.value })}
                  className="font-mono text-xs bg-background"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleTestConnection}
                  disabled={testing || !config.webhookUrl}
                  className="gap-1.5 shrink-0 text-xs"
                >
                  {testing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 text-amber-500" />}
                  Test Connection
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Generated from your Google Sheet by clicking <b>Extensions &gt; Apps Script &gt; Deploy &gt; New deployment &gt; Web app</b>.
              </p>
            </div>

            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pt-2 border-t border-border/50">
              <div className="flex items-center space-x-3">
                <Switch
                  id="auto-sync"
                  checked={config.autoSync}
                  onCheckedChange={(checked) => setConfig({ ...config, autoSync: checked })}
                />
                <div>
                  <Label htmlFor="auto-sync" className="text-xs font-medium text-foreground cursor-pointer">
                    Automatic Realtime Sync
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Instantly syncs lead creation, updates, status changes, and deletions to Google Sheets.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSave}
                  disabled={saving}
                  className="text-xs h-9"
                >
                  {saving ? "Saving..." : "Save Settings"}
                </Button>

                <Button
                  size="sm"
                  onClick={handleSyncAll}
                  disabled={syncingAll || !config.webhookUrl}
                  className="gap-1.5 text-xs h-9 bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${syncingAll ? "animate-spin" : ""}`} />
                  {syncingAll
                    ? syncProgress
                      ? `Syncing... ${syncProgress.synced}/${syncProgress.total}`
                      : "Preparing..."
                    : "Sync All Leads Now"}
                </Button>
              </div>
            </div>

            {/* Progress bar shown during batched sync */}
            {syncingAll && (
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {syncProgress
                      ? `Batch syncing ${syncProgress.synced.toLocaleString()} of ${syncProgress.total.toLocaleString()} leads…`
                      : "Fetching all leads from database…"}
                  </span>
                  {syncProgress && (
                    <span className="font-mono font-semibold text-foreground">
                      {Math.round((syncProgress.synced / syncProgress.total) * 100)}%
                    </span>
                  )}
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: syncProgress ? `${Math.round((syncProgress.synced / syncProgress.total) * 100)}%` : "5%" }}
                  />
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Setup Instructions Card */}
      <Card className="glass-panel border-border/60">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Code2 className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="text-base font-semibold">1-Minute Setup Guide for Google Sheets</CardTitle>
                <CardDescription className="text-xs">
                  Copy this Apps Script into your Google Sheet to enable automated tab creation &amp; row shifting
                </CardDescription>
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={copyScriptCode}
              className="gap-1.5 text-xs"
            >
              {copiedScript ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedScript ? "Copied!" : "Copy Apps Script Code"}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-border/60 bg-card/50 p-3 space-y-1">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">1</span>
              <p className="text-xs font-medium text-foreground">Open Sheet</p>
              <p className="text-[11px] text-muted-foreground">
                Open <a href={config.spreadsheetUrl} target="_blank" rel="noreferrer" className="text-primary underline">your Google Sheet</a>.
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card/50 p-3 space-y-1">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">2</span>
              <p className="text-xs font-medium text-foreground">Open Apps Script</p>
              <p className="text-[11px] text-muted-foreground">
                Click <b>Extensions</b> &gt; <b>Apps Script</b> in Google Sheets menu.
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card/50 p-3 space-y-1">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">3</span>
              <p className="text-xs font-medium text-foreground">Paste &amp; Save</p>
              <p className="text-[11px] text-muted-foreground">
                Click <b>Copy Apps Script Code</b> above, paste into editor, and hit <b>Save</b> (Ctrl+S).
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card/50 p-3 space-y-1">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">4</span>
              <p className="text-xs font-medium text-foreground">Deploy as Web App</p>
              <p className="text-[11px] text-muted-foreground">
                Deploy &gt; New deployment &gt; Web app. Execute as: <b>Me</b>, Access: <b>Anyone</b>. Paste URL here!
              </p>
            </div>
          </div>

          {/* Included Features details */}
          <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-2">
            <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Layers className="h-4 w-4 text-primary" />
              What this Google Sheet sync handles automatically:
            </p>
            <div className="grid gap-2 sm:grid-cols-2 text-[12px] text-muted-foreground">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                <span><b>17 Mapped Columns:</b> Lead ID, Lead Creation Date, Customer Name, Customer Phone No, Address, Service Type &amp; Details, Number Name, Schedule Requirements, Pictures, Tag, Status, Tech Name, Tech Number, Cs Notes, Processor Notes, Opr Notes.</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                <span><b>Recent Leads on Top:</b> Reverse chronological order with recent leads always inserted on Row 2 directly below the header.</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                <span><b>Sub-sheets for Every Status:</b> Automatically creates &amp; updates tabs for "Waiting Customer Response", "Paid", "Urgent Job", "Job in Progress", "Scheduled", etc.</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                <span><b>Single Tagged Leads Sheet:</b> Dedicated "Tagged Leads" tab where all tagged leads are maintained, plus automatic row deletion and shift-up.</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const APPS_SCRIPT_SNIPPET = `/**
 * Marshmallow CRM -> Google Sheets Live Sync Script
 * Target: https://docs.google.com/spreadsheets/d/1zGnzG0ovA2ICiUNoOVgVjleVt0CDeN1yCfHEx83ucxs/edit?gid=0#gid=0
 */
var HEADERS = [
  "Lead ID", "Lead Creation Date", "Customer Name", "Customer Phone No",
  "Address", "Service Type", "Service Details", "Number Name",
  "Schedule Requirements", "Pictures", "Tag", "Status",
  "Tech Name", "Tech Number", "Cs Notes", "Processor Notes", "Opr Notes"
];

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    spreadsheetName: ss.getName(),
    sheets: ss.getSheets().map(function(s) { return s.getName(); })
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var hasLock = lock.tryLock(30000);
  if (!hasLock) return jsonResponse({ success: false, error: "Server busy" });
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action || "sync_all";
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (action === "ping") return jsonResponse({ success: true, message: "Connected to " + ss.getName() });
    if (action === "sync_all") return handleSyncAll(ss, payload.leads || []);
    if (action === "upsert") return handleUpsert(ss, payload.lead, payload.previousStatus, payload.previousTag);
    if (action === "delete") return handleDelete(ss, payload.lead_id);
    return jsonResponse({ success: false, error: "Unknown action: " + action });
  } catch(err) {
    return jsonResponse({ success: false, error: err.toString() });
  } finally {
    lock.releaseLock();
  }
}
// View complete script in google-sheets-sync.gs in workspace root!
`;
