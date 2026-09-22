import { supabase } from "@/integrations/supabase/client";
import { LEAD_STATUS_CONFIG, CS_TAG_LABELS, type Lead, type LeadStatus, type CsTag } from "@/types";
import { formatUSPhone } from "@/lib/phone";

export const TARGET_SPREADSHEET_URL =
  "https://docs.google.com/spreadsheets/d/1zGnzG0ovA2ICiUNoOVgVjleVt0CDeN1yCfHEx83ucxs/edit?gid=0#gid=0";

export const GOOGLE_SHEETS_CONFIG_STORAGE_KEY = "marshmallow_google_sheets_sync_config";

export interface GoogleSheetsConfig {
  webhookUrl: string;
  autoSync: boolean;
  spreadsheetUrl: string;
  lastSyncedAt?: string | null;
  lastSyncStatus?: "success" | "error" | "idle";
  lastSyncMessage?: string;
  lastSyncedCount?: number;
}

export interface GoogleSheetLeadRow {
  "Lead ID": string;
  "Lead Creation Date": string;
  "Customer Name": string;
  "Customer Phone No": string;
  Address: string;
  "Service Type": string;
  "Service Details": string;
  "Number Name": string;
  "Schedule Requirements": string;
  Pictures: string;
  Tag: string;
  Status: string;
  "Tech Name": string;
  "Tech Number": string;
  "Cs Notes": string;
  "Processor Notes": string;
  "Opr Notes": string;
  _created_at?: string;
  _id?: string;
  _job_id?: string;
}

interface NoteSummary {
  cs: string;
  processor: string;
  opr: string;
}

/**
 * Get Google Sheets Configuration
 * Checks Supabase settings first, falls back to localStorage
 */
export async function getGoogleSheetsConfig(): Promise<GoogleSheetsConfig> {
  const defaultConfig: GoogleSheetsConfig = {
    webhookUrl: "https://script.google.com/macros/s/AKfycbzRAUa3Ea5mCEP_cXjf1IFuTmK4jglnIHO_sUz8zR1RIpFL-DulMMtABu6AAuMUbS1y/exec",
    autoSync: true,
    spreadsheetUrl: TARGET_SPREADSHEET_URL,
    lastSyncedAt: null,
    lastSyncStatus: "idle",
  };

  try {
    const { data } = await supabase
      .from("quo_ai_settings" as never)
      .select("value")
      .eq("key", "google_sheets_sync_config")
      .maybeSingle();

    const dbConfig = (data as { value?: Partial<GoogleSheetsConfig> } | null)?.value;
    if (dbConfig && dbConfig.webhookUrl !== undefined) {
      const merged = { ...defaultConfig, ...dbConfig };
      try {
        localStorage.setItem(GOOGLE_SHEETS_CONFIG_STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // ignore storage errors
      }
      return merged;
    }
  } catch (err) {
    console.warn("Could not load Google Sheets config from DB, checking local storage:", err);
  }

  try {
    const saved = localStorage.getItem(GOOGLE_SHEETS_CONFIG_STORAGE_KEY);
    if (saved) {
      return { ...defaultConfig, ...JSON.parse(saved) };
    }
  } catch {
    // ignore
  }

  return defaultConfig;
}

/**
 * Save Google Sheets Configuration
 */
export async function saveGoogleSheetsConfig(config: GoogleSheetsConfig): Promise<void> {
  try {
    localStorage.setItem(GOOGLE_SHEETS_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }

  try {
    await supabase.from("quo_ai_settings" as never).upsert(
      {
        key: "google_sheets_sync_config",
        value: config,
        description: "Google Sheets Live Webhook Sync configuration",
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "key" }
    );
  } catch (err) {
    console.warn("Could not save Google Sheets config to DB:", err);
  }
}

/**
 * Format a Lead into the 17 exact columns requested
 */
/**
 * The sheet has one phone column. It carries the cell phone; a lead reachable only by landline
 * shows that number instead, marked, so the column is not blank for a lead that has a number.
 */
export function formatSheetPhone(lead: { customer_phone?: string | null; customer_landline?: string | null }): string {
  if (lead.customer_phone) return formatUSPhone(lead.customer_phone);
  if (lead.customer_landline) return `${formatUSPhone(lead.customer_landline)} (Landline)`;
  return "";
}

export function formatLeadForGoogleSheet(
  lead: Lead,
  noteSummary?: NoteSummary,
  photoUrls?: string[]
): GoogleSheetLeadRow {
  const addressParts = [lead.address, lead.city, lead.state, lead.zip_code].filter(Boolean);
  const fullAddress = addressParts.join(", ");

  const statusLabel =
    LEAD_STATUS_CONFIG[lead.status as LeadStatus]?.label ||
    lead.status?.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ||
    "";

  const tagLabel = lead.cs_tag
    ? CS_TAG_LABELS[lead.cs_tag as CsTag] || lead.cs_tag
    : "";

  const picture = photoUrls && photoUrls.length > 0 ? photoUrls.join("\n") : "";

  // Format Lead Creation Date
  let leadCreationDate = "";
  if (lead.created_at) {
    try {
      const d = new Date(lead.created_at);
      leadCreationDate = d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      leadCreationDate = lead.created_at;
    }
  }

  return {
    "Lead ID": lead.job_id || lead.id,
    "Lead Creation Date": leadCreationDate,
    "Customer Name": lead.customer_name || "",
    "Customer Phone No": formatSheetPhone(lead),
    Address: fullAddress,
    "Service Type": lead.service_type || "",
    "Service Details": lead.service_details || "",
    "Number Name": lead.number_name || "",
    "Schedule Requirements": lead.customer_schedule_requirements || "",
    Pictures: picture,
    Tag: tagLabel,
    Status: statusLabel,
    "Tech Name": lead.tech_name || "",
    "Tech Number": lead.tech_number ? formatUSPhone(lead.tech_number) : "",
    "Cs Notes": noteSummary?.cs || "",
    "Processor Notes": noteSummary?.processor || "",
    "Opr Notes": noteSummary?.opr || "",
    _created_at: lead.created_at,
    _id: lead.id,
    _job_id: lead.job_id || undefined,
  };
}

/**
 * Fetch all leads along with their notes threads and photos
 */
export async function fetchAllLeadsWithDetails(): Promise<GoogleSheetLeadRow[]> {
  // 1. Fetch ALL leads in batches of 1000 using range pagination so we are never capped
  const allLeads: Lead[] = [];
  const PAGE_SIZE = 1000;
  let from = 0;

  while (true) {
    const { data: chunk, error: leadsError } = await supabase
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (leadsError) {
      throw new Error(`Failed to load leads: ${leadsError.message}`);
    }

    if (!chunk || chunk.length === 0) {
      break;
    }

    allLeads.push(...(chunk as Lead[]));

    if (chunk.length < PAGE_SIZE) {
      break;
    }

    from += PAGE_SIZE;
  }

  if (allLeads.length === 0) {
    return [];
  }

  const typedLeads = allLeads;
  const leadIds = typedLeads.map((l) => l.id);

  // 2. Fetch all profiles for user name resolution in notes
  const { data: profilesData } = await supabase
    .from("profiles_public" as never)
    .select("id, full_name");
  const profileMap: Record<string, string> = {};
  if (profilesData) {
    (profilesData as { id: string; full_name: string | null }[]).forEach((p) => {
      if (p.full_name) profileMap[p.id] = p.full_name;
    });
  }

  // 3. Batch fetch lead_notes in chunks of 100
  const noteSummaryByLead: Record<string, NoteSummary> = {};
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100);
    const { data: notes } = await supabase
      .from("lead_notes")
      .select("lead_id, note_type, content, user_id, user_name, created_at")
      .in("lead_id", chunk)
      .order("created_at", { ascending: true });

    if (notes) {
      notes.forEach((note) => {
        if (!noteSummaryByLead[note.lead_id]) {
          noteSummaryByLead[note.lead_id] = { cs: "", processor: "", opr: "" };
        }
        const author = (note.user_id ? profileMap[note.user_id] : null) || note.user_name || "Unknown";
        const time = note.created_at ? new Date(note.created_at).toLocaleString() : "";
        const line = time ? `[${time}] ${author}: ${note.content}` : `${author}: ${note.content}`;

        if (note.note_type === "cs") {
          noteSummaryByLead[note.lead_id].cs = noteSummaryByLead[note.lead_id].cs
            ? `${noteSummaryByLead[note.lead_id].cs}\n${line}`
            : line;
        } else if (note.note_type === "processor") {
          noteSummaryByLead[note.lead_id].processor = noteSummaryByLead[note.lead_id].processor
            ? `${noteSummaryByLead[note.lead_id].processor}\n${line}`
            : line;
        } else if (note.note_type === "opr" || note.note_type === "general") {
          noteSummaryByLead[note.lead_id].opr = noteSummaryByLead[note.lead_id].opr
            ? `${noteSummaryByLead[note.lead_id].opr}\n${line}`
            : line;
        }
      });
    }
  }

  // 4. Batch fetch photos in chunks of 100
  const photoUrlsByLead: Record<string, string[]> = {};
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100);
    const { data: photos } = await supabase
      .from("lead_photos")
      .select("lead_id, photo_url")
      .in("lead_id", chunk)
      .order("created_at", { ascending: true });

    if (photos) {
      photos.forEach((p) => {
        if (!photoUrlsByLead[p.lead_id]) {
          photoUrlsByLead[p.lead_id] = [];
        }
        // Build public URL from Supabase storage
        const publicUrl = supabase.storage.from("lead-photos").getPublicUrl(p.photo_url).data.publicUrl;
        photoUrlsByLead[p.lead_id].push(publicUrl || p.photo_url);
      });
    }
  }

  // 5. Combine everything
  return typedLeads.map((lead) => {
    const notes = noteSummaryByLead[lead.id];
    const photos = photoUrlsByLead[lead.id];
    return formatLeadForGoogleSheet(lead, notes, photos);
  });
}

/**
 * Dispatch payload to Google Sheets Webhook
 * First tries Supabase Edge Function to bypass CORS.
 * If edge function is not deployed, sends direct fetch with mode: 'no-cors' fallback.
 */
async function dispatchToWebhook(
  payload: Record<string, unknown>,
  explicitWebhookUrl?: string
): Promise<{ success: boolean; message?: string; [key: string]: unknown }> {
  const config = await getGoogleSheetsConfig();
  const webhookUrl = explicitWebhookUrl || config.webhookUrl;

  if (!webhookUrl) {
    throw new Error("Google Sheets Webhook URL is not configured. Please paste your Web App URL in Settings > Google Sheets.");
  }

  // 1. Try invoking Edge Function
  try {
    const { data: edgeData, error: edgeError } = await supabase.functions.invoke("google-sheets-sync", {
      body: {
        ...payload,
        webhookUrl,
      },
    });

    if (!edgeError && edgeData && edgeData.success !== false) {
      return edgeData;
    }

    if (edgeError && !edgeError.message?.includes("FunctionsFetchError") && !edgeError.message?.includes("404")) {
      console.warn("Edge function responded with error, attempting direct webhook dispatch:", edgeError);
    }
  } catch (edgeErr) {
    console.warn("Edge function call failed, falling back to direct fetch:", edgeErr);
  }

  // 2. Direct fetch fallback
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // Google Apps Script handles text/plain without preflight CORS
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      return parsed;
    } catch {
      return { success: res.ok, message: text.substring(0, 200) };
    }
  } catch (directErr) {
    // If browser CORS blocked reading response, Apps Script may still have received the request
    console.warn("Direct fetch had CORS restriction, testing no-cors mode:", directErr);
    try {
      await fetch(webhookUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      return { success: true, message: "Dispatched to Google Sheet (opaque response)" };
    } catch (finalErr) {
      throw new Error(`Failed to contact Google Sheets Webhook: ${finalErr instanceof Error ? finalErr.message : String(finalErr)}`);
    }
  }
}

/**
 * Bulk Sync all leads to Google Sheets in batches of 200 to avoid
 * Google Apps Script execution-time and payload-size limits.
 */
export async function syncAllLeadsToGoogleSheets(
  onProgress?: (synced: number, total: number) => void
): Promise<{
  success: boolean;
  leadsCount: number;
  message?: string;
}> {
  const rows = await fetchAllLeadsWithDetails();
  const config = await getGoogleSheetsConfig();
  const BATCH_SIZE = 200;
  const total = rows.length;
  let synced = 0;

  // Send a "clear_all" command first so the sheet starts fresh
  try {
    await dispatchToWebhook({ action: "clear_all" });
  } catch (err) {
    console.warn("clear_all failed, proceeding with batched upsert anyway:", err);
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(total / BATCH_SIZE);

    try {
      await dispatchToWebhook({
        action: "sync_batch",
        leads: batch,
        batchNumber,
        totalBatches,
        isLastBatch: i + BATCH_SIZE >= rows.length,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const updatedConfig: GoogleSheetsConfig = {
        ...config,
        lastSyncStatus: "error",
        lastSyncMessage: `Failed at batch ${batchNumber}/${totalBatches}: ${errorMsg}`,
      };
      await saveGoogleSheetsConfig(updatedConfig);
      throw new Error(`Sync failed at batch ${batchNumber}/${totalBatches}: ${errorMsg}`);
    }

    synced += batch.length;
    onProgress?.(synced, total);
  }

  const updatedConfig: GoogleSheetsConfig = {
    ...config,
    lastSyncedAt: new Date().toISOString(),
    lastSyncStatus: "success",
    lastSyncMessage: `Successfully synced ${total} leads across all status and tag tabs.`,
    lastSyncedCount: total,
  };
  await saveGoogleSheetsConfig(updatedConfig);

  return {
    success: true,
    leadsCount: total,
    message: updatedConfig.lastSyncMessage,
  };
}

/**
 * Upsert a single lead into Google Sheets
 */
export async function syncLeadUpsertToGoogleSheets(
  lead: Lead,
  previousStatus?: string,
  previousTag?: string
): Promise<void> {
  const config = await getGoogleSheetsConfig();
  if (!config.autoSync || !config.webhookUrl) {
    return;
  }

  // Load photos for this single lead
  let photoUrls: string[] = [];
  try {
    const { data: photos } = await supabase
      .from("lead_photos")
      .select("photo_url")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: true });
    if (photos) {
      photoUrls = photos.map((p) => supabase.storage.from("lead-photos").getPublicUrl(p.photo_url).data.publicUrl || p.photo_url);
    }
  } catch {
    // ignore
  }

  // Load latest notes for this lead
  const noteSummary: NoteSummary = { cs: "", processor: "", opr: "" };
  try {
    const { data: notes } = await supabase
      .from("lead_notes")
      .select("note_type, content, user_name, created_at")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: true });

    if (notes) {
      notes.forEach((note) => {
        const time = note.created_at ? new Date(note.created_at).toLocaleString() : "";
        const line = time ? `[${time}] ${note.user_name || "User"}: ${note.content}` : `${note.user_name || "User"}: ${note.content}`;
        if (note.note_type === "cs") {
          noteSummary.cs = noteSummary.cs ? `${noteSummary.cs}\n${line}` : line;
        } else if (note.note_type === "processor") {
          noteSummary.processor = noteSummary.processor ? `${noteSummary.processor}\n${line}` : line;
        } else if (note.note_type === "opr" || note.note_type === "general") {
          noteSummary.opr = noteSummary.opr ? `${noteSummary.opr}\n${line}` : line;
        }
      });
    }
  } catch {
    // ignore
  }

  const formattedRow = formatLeadForGoogleSheet(lead, noteSummary, photoUrls);

  const prevStatusLabel = previousStatus
    ? LEAD_STATUS_CONFIG[previousStatus as LeadStatus]?.label || previousStatus
    : undefined;

  const prevTagLabel = previousTag
    ? CS_TAG_LABELS[previousTag as CsTag] || previousTag
    : undefined;

  await dispatchToWebhook({
    action: "upsert",
    lead: formattedRow,
    lead_id: lead.id,
    job_id: lead.job_id || undefined,
    previousStatus: prevStatusLabel,
    previousTag: prevTagLabel,
  });
}

/**
 * Delete a lead from Google Sheets (removes row and shifts rows below up)
 */
export async function syncLeadDeleteToGoogleSheets(
  leadId: string,
  jobId?: string
): Promise<void> {
  const config = await getGoogleSheetsConfig();
  if (!config.autoSync || !config.webhookUrl) {
    return;
  }

  let resolvedJobId = jobId;
  // If jobId is not provided, try to fetch it from Supabase in case lead hasn't been deleted yet
  if (!resolvedJobId && leadId) {
    try {
      const { data } = await supabase
        .from("leads")
        .select("job_id")
        .eq("id", leadId)
        .maybeSingle();
      if (data?.job_id) {
        resolvedJobId = data.job_id;
      }
    } catch {
      // ignore
    }
  }

  await dispatchToWebhook({
    action: "delete",
    lead_id: resolvedJobId || leadId,
    job_id: resolvedJobId || undefined,
    db_id: leadId,
  });
}

/**
 * Test connection to the Google Sheets Webhook
 */
export async function testGoogleSheetsWebhook(webhookUrl: string): Promise<{
  success: boolean;
  message: string;
  spreadsheetName?: string;
  sheets?: string[];
}> {
  if (!webhookUrl || !webhookUrl.startsWith("http")) {
    throw new Error("Please provide a valid Webhook URL starting with https://");
  }

  const res = await dispatchToWebhook({ action: "ping" }, webhookUrl);
  return {
    success: true,
    message: String(res.message || "Connected successfully to Google Sheets!"),
    spreadsheetName: typeof res.spreadsheetName === "string" ? res.spreadsheetName : undefined,
    sheets: Array.isArray(res.sheets) ? res.sheets : undefined,
  };
}
