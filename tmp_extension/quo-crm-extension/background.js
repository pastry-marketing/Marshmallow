importScripts("supabase.js");

const SUPABASE_URL = "https://kxiqholnmhkwhdkhtopp.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt4aXFob2xubWhrd2hka2h0b3BwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNjU0OTcsImV4cCI6MjA4ODc0MTQ5N30.yDiNd6Sl2jWbkNN0Wf5cjClVJKoQXAd8q8kkBUWep7o";

// Create custom storage provider using chrome.storage.local for service worker compatibility
const chromeStorageProvider = {
  getItem: (key) => {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (res) => {
        resolve(res[key] || null);
      });
    });
  },
  setItem: (key, value) => {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => {
        resolve();
      });
    });
  },
  removeItem: (key) => {
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, () => {
        resolve();
      });
    });
  }
};

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: chromeStorageProvider,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

const DEFAULT_DRAFT = {
  customerName: "",
  customerNumber: "",
  customerAddress: "",
  numberName: "",
  serviceName: "",
  referenceName: "",
  serviceDetails: "",
  direction: "incoming",
  leadStatus: "default",
  terms: "",
  quote: "",
  scheduleRequirement: "",
  source: "quo.com",
  sourceUrl: "",
  capturedAt: "",
  createdByExtension: true,
  photos: []
};

const DRAFT_STORAGE_KEY = "leadDraft";
const SETTINGS_STORAGE_KEY = "crmSettings";
const CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const CENSUS_BENCHMARK = "Public_AR_Current";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDraft();
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("Quo CRM Lead Capture: could not set panel behavior.", error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDraft();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        success: false,
        error: error.message || "Unexpected error."
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "PAGE_CONTEXT_READY":
      return handlePageContextReady(message, sender);
    case "ASSIGN_SELECTION_TO_FIELD":
      return assignSelectionToField(message, sender);
    case "GET_DRAFT":
      return {
        success: true,
        draft: await getDraft()
      };
    case "UPDATE_DRAFT":
      return {
        success: true,
        draft: await updateDraft(message.payload || {})
      };
    case "CLEAR_DRAFT":
      return {
        success: true,
        draft: await clearDraft()
      };
    case "LOGIN":
      return login(message.email, message.password);
    case "VERIFY_MFA":
      return verifyMfa(message.factorId, message.code);
    case "VERIFY_ACCESS_CODE":
      return verifyAccessCode(message.code);
    case "LOGOUT":
      return logout();
    case "CHECK_AUTH":
      return checkAuth();
    case "CREATE_LEAD":
      return createLead();
    case "CHECK_LEAD_EXISTS":
      return checkLeadExists(message.phone);
    case "UPDATE_LEAD_SCHEDULE_REQUIREMENT":
      return updateLeadScheduleRequirement(
        message.leadId,
        message.scheduleRequirement,
        message.checkedPhone
      );
    case "GET_EXTENSION_REPORT":
      return getExtensionReport();
    case "CENSUS_ADDRESS_LOOKUP":
      return searchCensusAddress(message.address);
    case "GET_SETTINGS":
      return {
        success: true,
        settings: await getSettings()
      };
    case "SAVE_SETTINGS":
      return {
        success: true,
        settings: await saveSettings(message.payload || {})
      };
    case "QUO_SEND_MESSAGE":
      return handleQuoSendMessage(message);
    default:
      throw new Error("Unsupported message type.");
  }
}

async function ensureDraft() {
  const stored = await chrome.storage.local.get(DRAFT_STORAGE_KEY);
  if (!stored[DRAFT_STORAGE_KEY]) {
    await chrome.storage.local.set({
      [DRAFT_STORAGE_KEY]: { ...DEFAULT_DRAFT }
    });
  }
}

async function getDraft() {
  await ensureDraft();
  const stored = await chrome.storage.local.get(DRAFT_STORAGE_KEY);
  return {
    ...DEFAULT_DRAFT,
    ...(stored[DRAFT_STORAGE_KEY] || {})
  };
}

async function updateDraft(partialDraft) {
  const current = await getDraft();
  
  if (partialDraft && partialDraft.customerNumber !== undefined) {
    partialDraft.customerNumber = formatPhoneNumber(partialDraft.customerNumber);
  }

  if (partialDraft && partialDraft.leadStatus !== undefined) {
    partialDraft.leadStatus = normalizeLeadStatus(partialDraft.leadStatus);
  }

  if (partialDraft && partialDraft.terms !== undefined) {
    partialDraft.terms = normalizeLeadTerms(partialDraft.terms);
  }

  if (partialDraft && partialDraft.quote !== undefined) {
    partialDraft.quote = String(partialDraft.quote || "");
  }

  const next = {
    ...current,
    ...partialDraft,
    source: "quo.com",
    createdByExtension: true
  };

  await chrome.storage.local.set({
    [DRAFT_STORAGE_KEY]: next
  });

  return next;
}

async function clearDraft() {
  const fresh = { ...DEFAULT_DRAFT };
  await chrome.storage.local.set({
    [DRAFT_STORAGE_KEY]: fresh
  });
  return fresh;
}

async function handlePageContextReady(message, sender) {
  if (sender?.frameId && sender.frameId !== 0) {
    return { success: true };
  }

  const currentDraft = await getDraft();
  return {
    success: true,
    draft: currentDraft
  };
}

async function assignSelectionToField(message, sender) {
  const field = message.field;
  const selectedText = (message.selectedText || "").trim();

  if (!field || !(field in DEFAULT_DRAFT)) {
    throw new Error("Invalid lead field.");
  }

  if (!selectedText) {
    throw new Error("No selected text to assign.");
  }

  const draft = await getDraft();
  const nextValue = mergeFieldValue(draft[field], selectedText);
  const sourceUrl = sender?.tab?.url || draft.sourceUrl || "";

  const updatedDraft = await updateDraft({
    [field]: nextValue,
    sourceUrl,
    capturedAt: new Date().toISOString()
  });

  if (sender?.tab?.id) {
    try {
      await chrome.sidePanel.open({ tabId: sender.tab.id });
    } catch (error) {
      console.warn("Quo CRM Lead Capture: could not open side panel.", error);
    }
  }

  try {
    await chrome.runtime.sendMessage({
      type: "DRAFT_UPDATED",
      draft: updatedDraft
    });
  } catch (error) {
    console.warn("Quo CRM Lead Capture: no active panel listener for draft update.", error);
  }

  return {
    success: true,
    draft: updatedDraft
  };
}

function mergeFieldValue(existingValue, incomingValue) {
  const current = (existingValue || "").trim();
  const incoming = incomingValue.trim();

  if (!current) {
    return incoming;
  }

  if (current.includes(incoming)) {
    return current;
  }

  return `${current}\n${incoming}`;
}

function normalizeLeadStatus(value) {
  const allowedStatuses = new Set(["default", "urgent_job", "pending_to_send", "quote_sent_waiting"]);
  return allowedStatuses.has(value) ? value : "default";
}

function normalizeLeadTerms(value) {
  const allowedTerms = new Set(["free_estimate", "quoted"]);
  return allowedTerms.has(value) ? value : "";
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
  const settings = stored[SETTINGS_STORAGE_KEY] || {};
  return {
    apiBaseUrl: settings.apiBaseUrl || "https://account-boosters-crm.lovable.app",
    apiToken: settings.apiToken || ""
  };
}

async function saveSettings(partialSettings) {
  const current = await getSettings();
  const next = {
    apiBaseUrl: normalizeBaseUrl(partialSettings.apiBaseUrl ?? current.apiBaseUrl ?? "https://account-boosters-crm.lovable.app"),
    apiToken: (partialSettings.apiToken ?? current.apiToken ?? "").trim()
  };

  await chrome.storage.sync.set({
    [SETTINGS_STORAGE_KEY]: next
  });

  return next;
}

function normalizeBaseUrl(value) {
  let cleaned = (value || "").trim().replace(/\/+$/, "");
  if (!cleaned) {
    return "";
  }
  if (!/^https?:\/\//i.test(cleaned)) {
    if (cleaned.startsWith("localhost") || cleaned.startsWith("127.0.0.1")) {
      cleaned = "http://" + cleaned;
    } else {
      cleaned = "https://" + cleaned;
    }
  }
  return cleaned;
}

async function searchCensusAddress(address) {
  const normalizedAddress = String(address || "").trim();
  if (!normalizedAddress) {
    return {
      ok: false,
      error: "Enter an address first."
    };
  }

  const url = `${CENSUS_GEOCODER_URL}?address=${encodeURIComponent(normalizedAddress)}&benchmark=${encodeURIComponent(CENSUS_BENCHMARK)}&format=json`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Census request failed with status ${response.status}.`);
    }

    const payload = await response.json();
    const matches = Array.isArray(payload?.result?.addressMatches)
      ? payload.result.addressMatches
          .map((match) => ({
            matchedAddress: typeof match?.matchedAddress === "string" ? match.matchedAddress.trim() : ""
          }))
          .filter((match) => match.matchedAddress)
      : [];

    return {
      ok: true,
      matches
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Unable to search addresses."
    };
  }
}

// Authentication Handlers
async function login(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(error.message);
  }

  const userId = data.user?.id;
  const profile = await getUserProfile(userId);
  return {
    success: true,
    fullyAuthenticated: true,
    user: data.user,
    role: profile.role,
    fullName: profile.fullName
  };
}

async function verifyMfa(factorId, code) {
  const { data: challenge, error: challengeError } = await supabaseClient.auth.mfa.challenge({
    factorId
  });

  if (challengeError) {
    throw new Error(challengeError.message);
  }

  const { error: verifyError } = await supabaseClient.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code
  });

  if (verifyError) {
    throw new Error("Invalid MFA code. Please try again.");
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  const profile = await getUserProfile(user?.id);

  return {
    success: true,
    fullyAuthenticated: true,
    user,
    role: profile.role,
    fullName: profile.fullName
  };
}

async function verifyAccessCode(code) {
  const { data: result, error: fnError } = await supabaseClient.functions.invoke("admin-users", {
    body: { action: "verify_access_code", code }
  });

  if (fnError || result?.error) {
    throw new Error(result?.error || "Invalid access code.");
  }

  if (result?.session?.access_token && result?.session?.refresh_token) {
    await supabaseClient.auth.setSession({
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token
    });
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  const profile = await getUserProfile(user?.id);

  return {
    success: true,
    fullyAuthenticated: true,
    user,
    role: profile.role,
    fullName: profile.fullName
  };
}

async function logout() {
  await supabaseClient.auth.signOut();
  return { success: true };
}

async function checkAuth() {
  try {
    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError || !session) {
      return { success: false };
    }

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      return { success: false };
    }

    const profile = await getUserProfile(user.id);
    return {
      success: true,
      user,
      role: profile.role,
      fullName: profile.fullName
    };
  } catch (e) {
    console.warn("Auth check failed", e);
    return { success: false };
  }
}

async function getUserProfile(userId) {
  if (!userId) return { role: "no_role", fullName: "" };
  try {
    const [roleRes, profileRes] = await Promise.all([
      supabaseClient.from("user_roles").select("role").eq("user_id", userId).maybeSingle(),
      supabaseClient.from("profiles").select("full_name").eq("id", userId).maybeSingle()
    ]);

    return {
      role: roleRes?.data?.role || "no_role",
      fullName: profileRes?.data?.full_name || ""
    };
  } catch (e) {
    console.warn("Could not load user details", e);
    return { role: "no_role", fullName: "" };
  }
}

// Generate Job ID (Matches CRM implementation)
function generateJobId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "LD-";
  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// Create Lead in Supabase
async function createLead() {
  const draft = await getDraft();
  const { data: { user } } = await supabaseClient.auth.getUser();

  if (!user) {
    throw new Error("You must be logged in to create leads.");
  }

  if (!draft.customerName.trim() && !draft.customerNumber.trim()) {
    throw new Error("Customer Name or Customer Number is required.");
  }

  const jobId = generateJobId();

  // True when urgent was asked for and was not applied on insert. The side panel
  // reads this to say what is outstanding rather than reporting a plain success
  // for a request that did not happen.
  let urgentAfterInsert = false;
  // Carried back to the caller so the panel can say whether the check that follows
  // Whether the conversation check applies to the user creating this lead. Kept in
  // step with showsUrgentCheck() in src/lib/urgent-verification.ts and with the
  // bypass list in enforce_urgent_gate().
  let urgentCheckApplies = false;

  const insertData = {
    job_id: jobId,
    customer_name: draft.customerName.trim(),
    customer_phone: draft.customerNumber.trim() || null,
    customer_schedule_requirements: draft.scheduleRequirement.trim() || null,
    direction: draft.direction === "outgoing" ? "outgoing" : "incoming",
    address: draft.customerAddress.trim() || null,
    number_name: draft.numberName.trim() || null,
    service_type: draft.serviceName.trim() || "General",
    service_details: draft.serviceDetails.trim() || null,
    reference_name: draft.referenceName.trim() || null,
    created_by: user.id,
    source_url: draft.sourceUrl.trim() || null
  };

  const leadStatus = normalizeLeadStatus(draft.leadStatus);
if (leadStatus !== "default") {
      // A new lead is never inserted as urgent_job, whatever the role.
      //
      // The check reads the stored record and looks it up by id, so there is
      // nothing to check at insert time. Admin, processor and cs_admin are
      // permitted by the database to insert urgent_job directly, but they get the
      // same comparison and the same suggested fixes as everyone else, so the
      // status is withheld here and returned to the caller as work still to do.
      //
      // Sending the status through anyway would turn a clear message into a raw
      // database error surfaced inside the side panel.
      if (leadStatus === "urgent_job") {
        urgentAfterInsert = true;
        // Mirrors showsUrgentCheck() in src/lib/urgent-verification.ts. processor
        // is absent on purpose: they are not asked, and the database still lets
        // them insert urgent_job directly, so this block must not fire for them.
        const profile = await getUserProfile(user.id);
        urgentCheckApplies = ["customer_service", "admin", "cs_admin"].includes(profile.role);
        if (!urgentCheckApplies) {
          // Not asked. Put the status back the way they asked for it.
          insertData.status = "urgent_job";
          urgentAfterInsert = false;
        }
      } else {
        insertData.status = leadStatus;
      }
    }

  const leadTerms = normalizeLeadTerms(draft.terms);
  if (leadTerms) {
    insertData.terms = leadTerms;
  }
  if (leadTerms === "quoted" && draft.quote.trim()) {
    insertData.quote = draft.quote.trim();
  }

  const { data, error } = await supabaseClient
    .from("leads")
    .insert(insertData)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  // Upload picked photos to Supabase storage and link in lead_photos table
  if (draft.photos && draft.photos.length > 0) {
    for (const photoUrl of draft.photos) {
      try {
        const res = await fetch(photoUrl);
        if (!res.ok) continue;
        const blob = await res.blob();
        
        let ext = "jpg";
        const contentType = res.headers.get("content-type");
        if (contentType) {
          ext = contentType.split("/").pop();
          // Map binary jpeg subtype
          if (ext === "jpeg") ext = "jpg";
        } else {
          const match = photoUrl.match(/\.([^./?#]+)($|\?|#)/);
          if (match) ext = match[1];
        }
        
        const path = `leads/${data.id}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        
        const { error: uploadError } = await supabaseClient.storage
          .from("lead-photos")
          .upload(path, blob, {
            contentType: contentType || "image/jpeg"
          });
          
        if (!uploadError) {
          await supabaseClient.from("lead_photos").insert({
            lead_id: data.id,
            photo_url: path,
            uploaded_by: user.id
          });
        } else {
          console.error("Storage upload failed:", uploadError);
        }
      } catch (err) {
        console.error("Failed to upload chat picture:", err);
      }
    }
  }

  const settings = await getSettings();
  const leadUrl = settings.apiBaseUrl ? `${settings.apiBaseUrl}/leads/${data.id}` : null;

  return {
    success: true,
    payload: insertData,
    response: {
      leadUrl,
      lead: data,
      // True when urgent was asked for and was not applied on insert. The side
      // True when urgent was asked for and was not applied on insert. The side
      // panel reads this to say what is outstanding rather than reporting a plain
      // success for a request that did not happen.
      urgentCheckRequired: urgentAfterInsert,

    }
  };
}

// Helper for robust phone number comparison (ignores formatting, country codes, and extensions)
function comparePhones(phone1, phone2) {
  if (!phone1 || !phone2) return false;
  const p1 = phone1.trim().replace(/[()+\-\s]/g, '');
  const p2 = phone2.trim().replace(/[()+\-\s]/g, '');
  
  const getSig = (p) => {
    if (p.startsWith("1") && p.length >= 11) {
      return p.slice(1);
    }
    return p;
  };
  
  const s1 = getSig(p1);
  const s2 = getSig(p2);
  
  if (s1 === s2) return true;
  
  // Compare the main 10 digits of both significant numbers
  if (s1.length >= 10 && s2.length >= 10) {
    const main1 = s1.slice(0, 10);
    const main2 = s2.slice(0, 10);
    if (main1 === main2) return true;
  }
  
  return false;
}

// Check if lead with phone number exists in CRM (case/format insensitive)
async function checkLeadExists(phone) {
  if (!phone) {
    return { success: true, exists: false };
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    throw new Error("You must be logged in to check leads.");
  }

  const trimmed = phone.trim();
  const cleaned = trimmed.replace(/[()+\-\s]/g, '');

  if (cleaned.length < 4) {
    return { success: true, exists: false };
  }

  // Get the last 4 digits to find potential matches robustly in Postgres
  const trailingDigits = cleaned.slice(-4);

  const { data, error } = await supabaseClient
    .from("leads")
    .select("id, job_id, customer_name, customer_phone, status, created_at, service_type, address, customer_schedule_requirements")
    .neq("status", "cancelled")
    .ilike("customer_phone", `%${trailingDigits}%`)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(error.message);
  }

  // Filter candidates locally for robust phone number matching
  const matchingLeads = (data || []).filter(lead => {
    return comparePhones(lead.customer_phone, phone);
  });

  if (matchingLeads.length > 0) {
    return {
      success: true,
      exists: true,
      leads: matchingLeads
    };
  }

  return {
    success: true,
    exists: false
  };
}

// Replace the schedule requirement on one checked, non-cancelled lead.
async function updateLeadScheduleRequirement(leadId, requestedScheduleRequirement, checkedPhone) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    throw new Error("You must be logged in to update a lead.");
  }

  const id = String(leadId || "").trim();
  if (!id) {
    throw new Error("Select an existing lead before updating the schedule requirement.");
  }

  const draft = await getDraft();
  const scheduleRequirement = String(
    requestedScheduleRequirement ?? draft.scheduleRequirement ?? ""
  ).trim();
  if (!scheduleRequirement) {
    throw new Error("Schedule Requirement is required.");
  }

  const { data: existingLead, error: lookupError } = await supabaseClient
    .from("leads")
    .select("id, job_id, customer_name, customer_phone, status")
    .eq("id", id)
    .maybeSingle();

  if (lookupError) {
    throw new Error(lookupError.message);
  }
  if (!existingLead) {
    throw new Error("The selected lead no longer exists or you do not have access to it.");
  }
  if (existingLead.status === "cancelled") {
    throw new Error("Cancelled leads cannot be updated from the extension.");
  }
  if (checkedPhone && !comparePhones(existingLead.customer_phone, checkedPhone)) {
    throw new Error("The selected lead no longer matches the checked customer number. Check Lead again.");
  }

  const { data: updatedLead, error: updateError } = await supabaseClient
    .from("leads")
    .update({ customer_schedule_requirements: scheduleRequirement })
    .eq("id", id)
    .select("id, job_id, customer_name, customer_phone, status, customer_schedule_requirements")
    .single();

  if (updateError) {
    throw new Error(updateError.message);
  }

  const settings = await getSettings();
  const leadUrl = settings.apiBaseUrl
    ? `${settings.apiBaseUrl.replace(/\/$/, "")}/leads/${updatedLead.id}`
    : null;

  return {
    success: true,
    response: {
      leadUrl,
      lead: updatedLead
    }
  };
}

// Get Report Stats for Current User
async function getExtensionReport() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    throw new Error("User not authenticated.");
  }

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseClient
    .from("leads")
    .select("id, job_id, customer_name, customer_phone, created_at, status")
    .eq("created_by", user.id)
    .eq("reference_name", "Chrome Extension")
    .gte("created_at", sevenDaysAgo.toISOString())
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  let todayCount = 0;
  let yesterdayCount = 0;
  let history = [];

  if (data) {
    data.forEach((lead) => {
      const createdDate = new Date(lead.created_at);
      if (createdDate >= today) {
        todayCount++;
      } else if (createdDate >= yesterday && createdDate < today) {
        yesterdayCount++;
      }
    });

    history = data.slice(0, 5).map(lead => ({
      id: lead.id,
      jobId: lead.job_id,
      customerName: lead.customer_name,
      customerPhone: lead.customer_phone,
      createdAt: lead.created_at,
      status: lead.status
    }));
  }

  return {
    success: true,
    todayCount,
    yesterdayCount,
    history
  };
}

// Phone formatting helper
function formatPhoneNumber(value) {
  if (!value) return "";
  const hasPlus = value.trim().startsWith("+");
  const digits = value.replace(/\D/g, "");
  
  if (digits.length === 0) {
    return hasPlus ? "+" : "";
  }
  
  const prefix = hasPlus ? "+" : "";
  
  if (hasPlus) {
    if (digits.length <= 3) {
      return prefix + digits;
    }
    if (digits.length <= 7) {
      return `${prefix}${digits.slice(0, 2)} ${digits.slice(2)}`;
    }
    if (digits.length <= 10) {
      return `${prefix}${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
    }
    return `${prefix}${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6, 10)} ${digits.slice(10)}`;
  }
  
  if (digits.startsWith("1")) {
    if (digits.length <= 1) {
      return "1";
    }
    if (digits.length <= 4) {
      return `1 (${digits.slice(1)}`;
    }
    if (digits.length <= 7) {
      return `1 (${digits.slice(1, 4)}) ${digits.slice(4)}`;
    }
    if (digits.length <= 11) {
      return `1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return `1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 11)} ext. ${digits.slice(11)}`;
  }
  
  if (digits.length <= 3) {
    return `(${digits}`;
  }
  if (digits.length <= 6) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }
  if (digits.length <= 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)} ext. ${digits.slice(10)}`;
}

async function handleQuoSendMessage(message) {
  const { chatUrl, message: chatMessage, scheduleTime } = message;
  
  if (!chatUrl || !chatMessage) {
    return { success: false, error: "Missing chatUrl or message." };
  }

  // Find an existing Quo tab
  const tabs = await chrome.tabs.query({ url: "*://*.quo.com/*" });
  
  if (tabs.length > 0) {
    const tab = tabs[0];
    
    // Send message to the content script to navigate and send
    const result = await sendMessageWithRetry(tab.id, {
      type: "NAVIGATE_AND_SEND_MESSAGE",
      chatUrl: chatUrl,
      message: chatMessage,
      scheduleTime: scheduleTime
    });
    
    // Auto-refresh the Quo tab so the UI is up-to-date for the user
    if (result && result.success) {
      chrome.tabs.reload(tab.id);
    }

    return { ...result, newTab: false };
  } else {
    // Open a new tab strictly in the background
    const newTab = await chrome.tabs.create({ url: chatUrl, active: false });
    
    // We need to wait for the tab to load before sending the message
    return new Promise((resolve) => {
      chrome.tabs.onUpdated.addListener(async function listener(tabId, info) {
        if (tabId === newTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          const result = await sendMessageWithRetry(tabId, {
            type: "NAVIGATE_AND_SEND_MESSAGE",
            chatUrl: chatUrl,
            message: chatMessage,
            scheduleTime: scheduleTime
          });
          
          if (result && result.success) {
            chrome.tabs.reload(tabId);
          }

          resolve({ ...result, newTab: true });
        }
      });
    });
  }
}

async function sendMessageWithRetry(tabId, message, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (resp) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(resp);
        });
      });
      if (response && response.success !== undefined) {
        console.log("Quo CRM Extension: Message successfully sent to content script on retry", i);
        return response;
      }
    } catch (e) {
      console.log("Quo CRM Extension: Content script not ready, retrying...", i);
    }
    // Wait 1 second before retrying
    await new Promise(r => setTimeout(r, 1000));
  }
  console.warn("Quo CRM Extension: Failed to send message to content script after retries.");
  return { success: false, error: "Content script did not respond after 15 seconds." };
}
