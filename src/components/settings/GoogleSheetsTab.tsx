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
 * ==============================================================================
 * MARSHMALLOW CRM -> GOOGLE SHEETS LIVE SYNC SCRIPT
 * ==============================================================================
 * SPREADSHEET URL:
 * https://docs.google.com/spreadsheets/d/1zGnzG0ovA2ICiUNoOVgVjleVt0CDeN1yCfHEx83ucxs/edit?gid=0#gid=0
 *
 * DEPLOYMENT INSTRUCTIONS:
 * 1. Open your Google Sheet.
 * 2. In the top menu, click Extensions > Apps Script.
 * 3. Delete all code in the script editor and PASTE THIS ENTIRE FILE.
 * 4. Click the Save icon (Ctrl+S or Cmd+S).
 * 5. In the top-right corner, click Deploy > Manage deployments:
 *    - Click the Edit (pencil) icon next to your active deployment.
 *    - Under "Version", select "New version".
 *    - Click "Deploy".
 *    (CRITICAL: Every time you paste new code, you MUST deploy a "New version"!)
 * ==============================================================================
 */

// 17 headers in exact user-specified order
var HEADERS = [
  "Lead ID",
  "Lead Creation Date",
  "Customer Name",
  "Customer Phone No",
  "Address",
  "Service Type",
  "Service Details",
  "Number Name",
  "Schedule Requirements",
  "Pictures",
  "Tag",
  "Status",
  "Tech Name",
  "Tech Number",
  "Cs Notes",
  "Processor Notes",
  "Opr Notes"
];

// Header background styling
var HEADER_BG_COLOR = "#1E293B"; // Slate 800
var HEADER_FONT_COLOR = "#FFFFFF";

/**
 * Handle GET requests (Health check & diagnosis)
 */
function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    message: "Marshmallow CRM Google Sheets Sync Webhook is live and ready!",
    spreadsheetName: ss.getName(),
    sheets: ss.getSheets().map(function(s) { return s.getName(); }),
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle POST requests from Marshmallow CRM (Sync, Upsert, Edit, Delete)
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  var hasLock = lock.tryLock(30000);
  if (!hasLock) {
    return jsonResponse({
      success: false,
      error: "Server busy, please retry in a few moments."
    });
  }

  try {
    var rawData = e.postData ? e.postData.contents : null;
    if (!rawData) {
      return jsonResponse({ success: false, error: "Empty request body" });
    }

    var payload = JSON.parse(rawData);
    var action = payload.action || "sync_all";
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── Health check ping ──────────────────────────────────────────────────────
    if (action === "ping") {
      return jsonResponse({
        success: true,
        message: "Connected to Google Sheet successfully",
        spreadsheetName: ss.getName(),
        sheets: ss.getSheets().map(function(s) { return s.getName(); })
      });
    }

    // ── Clear all sheets (called before a batched sync starts) ─────────────────
    if (action === "clear_all") {
      handleClearAll(ss);
      return jsonResponse({ success: true, action: "clear_all" });
    }

    // ── Full bulk sync (legacy single-shot – kept for backwards compatibility) ──
    if (action === "sync_all") {
      var leads = payload.leads || [];
      var result = handleSyncAll(ss, leads);
      return jsonResponse({
        success: true,
        action: "sync_all",
        leadsCount: leads.length,
        sheetsCreated: result.sheetsCreated
      });
    }

    // ── Batched sync (new – called once per 200-lead chunk) ────────────────────
    if (action === "sync_batch") {
      var batchLeads    = payload.leads        || [];
      var batchNumber   = payload.batchNumber  || 1;
      var totalBatches  = payload.totalBatches || 1;
      var isLastBatch   = payload.isLastBatch  === true;

      var batchResult = handleSyncBatch(ss, batchLeads, batchNumber, totalBatches, isLastBatch);
      return jsonResponse({
        success: true,
        action: "sync_batch",
        batchNumber: batchNumber,
        totalBatches: totalBatches,
        leadsInBatch: batchLeads.length,
        isLastBatch: isLastBatch,
        sheetsWritten: batchResult.sheetsWritten
      });
    }

    // ── Upsert (new lead or edit/update existing lead) ─────────────────────────
    if (action === "upsert") {
      var lead = payload.lead;
      if (!lead) {
        return jsonResponse({ success: false, error: "Missing lead data" });
      }
      var upsertResult = handleUpsert(ss, lead, payload.previousStatus, payload.previousTag);
      return jsonResponse({
        success: true,
        action: "upsert",
        leadId: upsertResult.leadId,
        updatedRow: upsertResult.updatedRow
      });
    }

    // ── Delete lead ────────────────────────────────────────────────────────────
    if (action === "delete") {
      var delLeadId = payload.lead_id || (payload.lead && (payload.lead["Lead ID"] || payload.lead["Lead Id"]));
      var delJobId  = payload.job_id  || (payload.lead && (payload.lead._job_id || payload.lead.job_id));
      var delDbId   = payload.db_id   || (payload.lead && (payload.lead._id    || payload.lead.id));

      if (!delLeadId && !delJobId && !delDbId) {
        return jsonResponse({ success: false, error: "Missing lead_id or job_id to delete" });
      }

      var deletedFrom = handleDelete(ss, delLeadId, delJobId, delDbId);
      return jsonResponse({
        success: true,
        action: "delete",
        leadId: delLeadId,
        jobId: delJobId,
        dbId: delDbId,
        deletedFromSheets: deletedFrom
      });
    }

    return jsonResponse({ success: false, error: "Unknown action: " + action });

  } catch (err) {
    return jsonResponse({
      success: false,
      error: err.toString(),
      stack: err.stack
    });
  } finally {
    lock.releaseLock();
  }
}

// ==============================================================================
// CLEAR ALL  –  wipe every sheet's data rows, keep headers
// ==============================================================================
function handleClearAll(ss) {
  var sheets = ss.getSheets();
  sheets.forEach(function(sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
    }
    // Re-stamp headers & formatting on each sheet
    setupSheetHeaders(sheet);
  });
}

// ==============================================================================
// SYNC BATCH  –  append one 200-lead chunk to all relevant sheets
// ==============================================================================
function handleSyncBatch(ss, leads, batchNumber, totalBatches, isLastBatch) {
  var sheetsWritten = [];

  // On the very first batch, ensure "All Leads" and "Tagged Leads" exist with
  // clean headers.  Status sheets will be created on-demand below.
  if (batchNumber === 1) {
    var allLeadsInit = getOrCreateSheet(ss, "All Leads");
    setupSheetHeaders(allLeadsInit);

    var taggedInit = getOrCreateSheet(ss, "Tagged Leads");
    setupSheetHeaders(taggedInit);
  }

  // 1. Append ALL leads in this batch → "All Leads"
  var allLeadsSheet = getOrCreateSheet(ss, "All Leads");
  appendRowsToSheet(allLeadsSheet, leads);
  sheetsWritten.push("All Leads");

  // 2. Bucket by Status → append to each status sub-sheet
  var leadsByStatus = {};
  leads.forEach(function(l) {
    var status = sanitizeSheetName((l["Status"] || "No Status").trim());
    if (!leadsByStatus[status]) leadsByStatus[status] = [];
    leadsByStatus[status].push(l);
  });

  Object.keys(leadsByStatus).forEach(function(statusName) {
    var statusSheet = getOrCreateSheet(ss, statusName);
    // Ensure headers exist (first write to this sheet this batch run)
    if (statusSheet.getLastRow() === 0) setupSheetHeaders(statusSheet);
    appendRowsToSheet(statusSheet, leadsByStatus[statusName]);
    sheetsWritten.push(statusName);
  });

  // 3. Tagged leads → "Tagged Leads"
  var taggedLeads = leads.filter(function(l) {
    return (l["Tag"] || "").trim() !== "";
  });
  if (taggedLeads.length > 0) {
    var taggedSheet = getOrCreateSheet(ss, "Tagged Leads");
    appendRowsToSheet(taggedSheet, taggedLeads);
    if (sheetsWritten.indexOf("Tagged Leads") === -1) sheetsWritten.push("Tagged Leads");
  }

  // 4. On the last batch, auto-fit columns on all written sheets
  if (isLastBatch) {
    sheetsWritten.forEach(function(name) {
      var s = ss.getSheetByName(name);
      if (s) autoFitColumns(s);
    });
  }

  return { sheetsWritten: sheetsWritten };
}

/**
 * Append an array of lead objects as rows to a sheet (no clearing)
 */
function appendRowsToSheet(sheet, leads) {
  if (!leads || leads.length === 0) return;

  var rows = leads.map(leadToRow);
  var startRow = sheet.getLastRow() + 1;

  // Expand sheet if needed
  var requiredRows = startRow + rows.length - 1;
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  }

  var dataRange = sheet.getRange(startRow, 1, rows.length, HEADERS.length);
  dataRange.setValues(rows)
    .setFontFamily("Arial")
    .setFontSize(10)
    .setVerticalAlignment("middle");
}

/**
 * Write header row with formatting. Safe to call on a fresh or existing sheet.
 */
function setupSheetHeaders(sheet) {
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  var headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange
    .setBackground(HEADER_BG_COLOR)
    .setFontColor(HEADER_FONT_COLOR)
    .setFontWeight("bold")
    .setFontSize(11)
    .setFontFamily("Arial")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sheet.setRowHeight(1, 36);
  sheet.setFrozenRows(1);
}

// ==============================================================================
// LEGACY sync_all  (still fully working for manual / small syncs)
// ==============================================================================
function handleSyncAll(ss, leads) {
  // Sort leads newest first
  var sortedLeads = leads.slice().sort(function(a, b) {
    var dateA = a._created_at || a.created_at || a["Lead Creation Date"] || 0;
    var dateB = b._created_at || b.created_at || b["Lead Creation Date"] || 0;
    return new Date(dateB).getTime() - new Date(dateA).getTime();
  });

  // Remove legacy tag sub-sheets
  ss.getSheets().forEach(function(sheet) {
    if (sheet.getName().indexOf("Tag - ") === 0) {
      try { ss.deleteSheet(sheet); } catch (e) {}
    }
  });

  var sheetsCreated = [];

  var allLeadsSheet = getOrCreateSheet(ss, "All Leads");
  populateSheet(allLeadsSheet, sortedLeads);
  sheetsCreated.push("All Leads");

  var leadsByStatus = {};
  sortedLeads.forEach(function(l) {
    var status = (l["Status"] || "No Status").trim();
    if (!leadsByStatus[status]) leadsByStatus[status] = [];
    leadsByStatus[status].push(l);
  });

  Object.keys(leadsByStatus).forEach(function(statusName) {
    var sanitizedStatusSheetName = sanitizeSheetName(statusName);
    var statusSheet = getOrCreateSheet(ss, sanitizedStatusSheetName);
    populateSheet(statusSheet, leadsByStatus[statusName]);
    sheetsCreated.push(sanitizedStatusSheetName);
  });

  ss.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (name !== "All Leads" && name !== "Tagged Leads" && name.indexOf("Tag - ") !== 0) {
      if (!leadsByStatus[name]) {
        populateSheet(sheet, []);
      }
    }
  });

  var allTaggedLeads = sortedLeads.filter(function(l) {
    return (l["Tag"] || "").trim() !== "";
  });
  var taggedSheet = getOrCreateSheet(ss, "Tagged Leads");
  populateSheet(taggedSheet, allTaggedLeads);
  sheetsCreated.push("Tagged Leads");

  return { sheetsCreated: sheetsCreated };
}

// ==============================================================================
// UPSERT (single lead, live auto-sync)
// ==============================================================================
function handleUpsert(ss, lead, previousStatus, previousTag) {
  var leadId = String(lead["Lead ID"] || lead["Lead Id"] || lead["_job_id"] || lead["job_id"] || "").trim();
  var dbId   = String(lead["_id"]     || lead["id"]     || "").trim();
  var jobId  = String(lead["_job_id"] || lead["job_id"] || "").trim();
  var rowData = leadToRow(lead);

  var allLeadsSheet = getOrCreateSheet(ss, "All Leads");
  var updatedRow = upsertRowInSheet(allLeadsSheet, leadId, rowData, dbId, jobId);

  var currentStatus           = (lead["Status"] || "").trim();
  var sanitizedCurrentStatus  = sanitizeSheetName(currentStatus);

  ss.getSheets().forEach(function(s) {
    var sName = s.getName();
    if (sName !== "All Leads" && sName !== "Tagged Leads" && sName !== sanitizedCurrentStatus) {
      deleteRowById(s, leadId, dbId, jobId);
    }
  });

  if (currentStatus) {
    var newStatusSheet = getOrCreateSheet(ss, sanitizedCurrentStatus);
    upsertRowInSheet(newStatusSheet, leadId, rowData, dbId, jobId);
  }

  var currentTag   = (lead["Tag"] || "").trim();
  var taggedSheet  = getOrCreateSheet(ss, "Tagged Leads");
  if (currentTag) {
    upsertRowInSheet(taggedSheet, leadId, rowData, dbId, jobId);
  } else {
    deleteRowById(taggedSheet, leadId, dbId, jobId);
  }

  return { leadId: leadId || dbId || jobId, updatedRow: updatedRow };
}

// ==============================================================================
// DELETE
// ==============================================================================
function handleDelete(ss, id1, id2, id3) {
  var sheets = ss.getSheets();
  var deletedFrom = [];
  sheets.forEach(function(sheet) {
    var wasDeleted = deleteRowById(sheet, id1, id2, id3);
    if (wasDeleted) deletedFrom.push(sheet.getName());
  });
  return deletedFrom;
}

// ==============================================================================
// UTILITY HELPERS
// ==============================================================================

function normalizeId(id) {
  if (id === null || id === undefined) return "";
  return String(id).trim().toLowerCase().replace(/\.0+\$/, "");
}

function stripId(id) {
  return normalizeId(id).replace(/^(job|lead)[-\s#:]*/i, "").replace(/[,\s#\-]/g, "");
}

function matchesAnyId(cellVal, dispVal, targetIds) {
  var normCell    = normalizeId(cellVal);
  var normDisp    = normalizeId(dispVal);
  var strippedCell = stripId(cellVal);
  var strippedDisp = stripId(dispVal);

  for (var i = 0; i < targetIds.length; i++) {
    var target = targetIds[i];
    if (!target) continue;
    var normTarget    = normalizeId(target);
    var strippedTarget = stripId(target);
    if (normCell     && normCell     === normTarget)    return true;
    if (normDisp     && normDisp     === normTarget)    return true;
    if (strippedCell && strippedTarget && strippedCell === strippedTarget) return true;
    if (strippedDisp && strippedTarget && strippedDisp === strippedTarget) return true;
  }
  return false;
}

function deleteRowById(sheet, id1, id2, id3) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;

  var targetIds = [id1, id2, id3].filter(Boolean);
  if (targetIds.length === 0) return false;

  var range        = sheet.getRange(2, 1, lastRow - 1, 1);
  var values       = range.getValues();
  var displayValues = range.getDisplayValues();
  var deleted      = false;

  for (var i = values.length - 1; i >= 0; i--) {
    if (values[i][0] === "" && displayValues[i][0] === "") continue;
    if (matchesAnyId(values[i][0], displayValues[i][0], targetIds)) {
      sheet.deleteRow(i + 2);
      deleted = true;
    }
  }
  return deleted;
}

function upsertRowInSheet(sheet, leadId, rowData, dbId, jobId) {
  var lastRow   = sheet.getLastRow();
  var foundRow  = -1;
  var targetIds = [leadId, dbId, jobId].filter(Boolean);

  if (lastRow > 1) {
    var range        = sheet.getRange(2, 1, lastRow - 1, 1);
    var values       = range.getValues();
    var displayValues = range.getDisplayValues();
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === "" && displayValues[i][0] === "") continue;
      if (matchesAnyId(values[i][0], displayValues[i][0], targetIds)) {
        foundRow = i + 2;
        break;
      }
    }
  }

  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, rowData.length).setValues([rowData]);
    return foundRow;
  } else {
    sheet.insertRowBefore(2);
    sheet.getRange(2, 1, 1, rowData.length).setValues([rowData]);
    sheet.getRange(2, 1, 1, rowData.length)
      .setFontFamily("Arial")
      .setFontSize(10)
      .setVerticalAlignment("middle");
    return 2;
  }
}

function populateSheet(sheet, leads) {
  sheet.clear();
  setupSheetHeaders(sheet);

  if (leads.length === 0) {
    autoFitColumns(sheet);
    return;
  }

  var rows = leads.map(leadToRow);
  var requiredRows = Math.max(rows.length + 1, 2);
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  }

  var dataRange = sheet.getRange(2, 1, rows.length, HEADERS.length);
  dataRange.setValues(rows)
    .setFontFamily("Arial")
    .setFontSize(10)
    .setVerticalAlignment("middle");

  autoFitColumns(sheet);
}

function leadToRow(lead) {
  return [
    lead["Lead ID"] || lead["Lead Id"] || lead["_job_id"] || lead["job_id"] || lead["_id"] || lead["id"] || "",
    lead["Lead Creation Date"] || "",
    lead["Customer Name"] || "",
    lead["Customer Phone No"] || lead["Customer phone no"] || "",
    lead["Address"] || lead["Customer Address"] || "",
    lead["Service Type"] || "",
    lead["Service Details"] || "",
    lead["Number Name"] || "",
    lead["Schedule Requirements"] || lead["Secaual requirenments"] || "",
    lead["Pictures"] || lead["Picture"] || "",
    lead["Tag"] || "",
    lead["Status"] || "",
    lead["Tech Name"] || "",
    lead["Tech Number"] || "",
    lead["Cs Notes"] || lead["Cs Ndes"] || "",
    lead["Processor Notes"] || lead["Processor Nodes"] || "",
    lead["Opr Notes"] || lead["OPR Nodes"] || ""
  ];
}

function autoFitColumns(sheet) {
  for (var col = 1; col <= HEADERS.length; col++) {
    sheet.autoResizeColumn(col);
    var width = sheet.getColumnWidth(col);
    if (width < 120) sheet.setColumnWidth(col, 120);
    if (width > 350) sheet.setColumnWidth(col, 350);
  }
}

function getOrCreateSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

function sanitizeSheetName(name) {
  if (!name) return "Sheet";
  var cleaned = name.replace(/[\\/?*\[\]:]/g, " ").trim();
  if (cleaned.length > 90) cleaned = cleaned.substring(0, 90).trim();
  return cleaned || "Sheet";
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
`;

