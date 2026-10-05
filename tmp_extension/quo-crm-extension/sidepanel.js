
function friendlyExpectedAreaName(rawArea, state) {
  const raw = String(rawArea || "").trim().toUpperCase();

  const exactAliases = {
    "BRBN BRBN": "Burbank",
    "CHICGOZN01": "Chicago",
    "CHICGOZN02": "Chicago",
    "CHICGOZN03": "Chicago",
    "CHICGOZN04": "Chicago",
    "IGNACIO": "Ignacio",
    "LA JOLLA": "La Jolla",
    "STOCKTON": "Stockton"
  };

  if (exactAliases[raw]) return exactAliases[raw];

  // Hide unusable telecom/service labels rather than showing ugly raw codes.
  const blockedPatterns = [
    /^X+$/,
    /^N\/?A$/,
    /^NONE$/,
    /^UNKNOWN$/,
    /^UNAVAILABLE$/,
    /^DIR\s*ASST$/,
    /^DIRECTORY/,
    /^TEST/,
    /^INFORMATION$/,
    /^OPERATOR$/,
    /^SPECIAL/,
    /^MOBILE$/,
    /^CELLULAR$/,
    /^WIRELESS$/,
    /^PAGING$/
  ];

  if (blockedPatterns.some((pattern) => pattern.test(raw))) {
    return "";
  }

  // Common telecom zone suffixes: CHICGOZN01 -> Chicago (fallback heuristic).
  const zoneMatch = raw.match(/^([A-Z ]+?)ZN\d+$/);
  if (zoneMatch) {
    const base = zoneMatch[1].replace(/\s+/g, " ").trim();
    const zoneAliases = {
      "CHICGO": "Chicago",
      "NYC": "New York",
      "LOSANGELS": "Los Angeles",
      "SANFRAN": "San Francisco"
    };
    if (zoneAliases[base]) return zoneAliases[base];
  }

  // Collapse duplicated tokens such as "BRBN BRBN".
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && parts[0] === parts[1]) {
    const duplicateAliases = {
      "BRBN": "Burbank"
    };
    if (duplicateAliases[parts[0]]) return duplicateAliases[parts[0]];
  }

  // Generic title-case fallback for clean human-readable rate-center names.
  return raw
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}


const US_STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia", PR: "Puerto Rico", VI: "U.S. Virgin Islands",
  GU: "Guam", AS: "American Samoa"
};

function fullStateName(state) {
  const code = String(state || "").trim().toUpperCase();
  return US_STATE_NAMES[code] || code;
}

const EDITABLE_FIELDS = [
  "customerName",
  "customerNumber",
  "customerAddress",
  "numberName",
  "serviceName",
  "referenceName",
  "serviceDetails",
  "direction",
  "leadStatus",
  "terms",
  "quote",
  "scheduleRequirement"
];

const ADDRESS_PROVIDER_NAME = "US Census Geocoder";
const ADDRESS_MIN_QUERY_LENGTH = 5;
const ADDRESS_DEBOUNCE_MS = 350;

// Theme UI elements & logic
const themeToggleBtn = document.getElementById("theme-toggle-btn");

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  if (themeToggleBtn) {
    themeToggleBtn.setAttribute("aria-checked", isDark ? "true" : "false");
    themeToggleBtn.setAttribute("title", isDark ? "Switch to Light Mode" : "Switch to Dark Mode");
  }
}

async function initTheme() {
  try {
    const data = await chrome.storage.local.get({ theme: "light" });
    applyTheme(data.theme || "light");
  } catch (e) {
    applyTheme("light");
  }
}

async function handleThemeToggle() {
  const currentTheme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const newTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(newTheme);
  try {
    await chrome.storage.local.set({ theme: newTheme });
  } catch (e) {
    console.debug("Failed to persist theme:", e);
  }
}

// Immediately apply theme on script execution to avoid flashing
initTheme();

// Lead capture UI elements
const form = document.getElementById("lead-form");
const feedback = document.getElementById("feedback");
const clearButton = document.getElementById("clear-form");
const createLeadButton = document.getElementById("create-lead");
const autoPickNumberBtn = document.getElementById("auto-pick-number");
const autoPickNumberNameBtn = document.getElementById("auto-pick-number-name");
const autoPickServiceNameBtn = document.getElementById("auto-pick-service-name");
const checkCrmNumberBtn = document.getElementById("check-crm-number");
const checkLeadFeedback = document.getElementById("check-lead-feedback");
const matchingLeadsContainer = document.getElementById("matching-leads");
const matchingLeadsTitle = document.getElementById("matching-leads-title");
const matchingLeadsList = document.getElementById("matching-leads-list");
const updateScheduleRequirementBtn = document.getElementById("update-schedule-requirement");
const autoPickPhotosBtn = document.getElementById("auto-pick-photos");
const findAddressBtn = document.getElementById("find-address");
const checkExpectedAreaBtn = document.getElementById("check-expected-area");
const expectedAreaResult = document.getElementById("expected-area-result");
const photosPreviewContainer = document.getElementById("photos-preview-container");
const noPhotosLabel = document.getElementById("no-photos-label");
const addressSuggestions = document.getElementById("address-suggestions");
const addressSuggestionsStatus = document.getElementById("address-suggestions-status");
const addressSuggestionsList = document.getElementById("address-suggestions-list");
const quoteField = document.getElementById("quote-field");

// Auth UI elements
const loginContainer = document.getElementById("login-container");
const leadCaptureContainer = document.getElementById("lead-capture-container");
const loginForm = document.getElementById("login-form");
const loginEmail = document.getElementById("login-email");
const loginPassword = document.getElementById("login-password");
const loginBtn = document.getElementById("login-btn");
const userSessionBar = document.getElementById("user-session-bar");
const userSessionEmail = document.getElementById("user-session-email");
const logoutBtn = document.getElementById("logout-btn");

// Tab Navigation elements
const tabBtnCapture = document.getElementById("tab-btn-capture");
const tabBtnReports = document.getElementById("tab-btn-reports");
const viewCapture = document.getElementById("view-capture");
const viewReports = document.getElementById("view-reports");

// Reports UI elements
const reportTodayCount = document.getElementById("report-today-count");
const reportYesterdayCount = document.getElementById("report-yesterday-count");
const reportHistoryList = document.getElementById("report-history-list");
const exportReportBtn = document.getElementById("export-report-btn");

let currentDraft = null;
let addressSuggestionTimer = null;
let suppressAddressLookup = false;
let npaNxxDatabasePromise = null;
let checkedLeads = [];
let selectedCheckedLeadId = "";
let checkedPhone = "";
let leadCheckCompleted = false;
let scheduleUpdateInProgress = false;

initialize();

async function initialize() {
  // Bind Theme Toggle
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", handleThemeToggle);
  }

  // Bind Tab Navigation
  if (tabBtnCapture && tabBtnReports) {
    tabBtnCapture.addEventListener("click", () => switchTab("capture"));
    tabBtnReports.addEventListener("click", () => switchTab("reports"));
  }

  // Bind Auth events
  loginForm.addEventListener("submit", handleLoginSubmit);
  logoutBtn.addEventListener("click", handleLogout);

  // Check initial authentication
  const authResponse = await chrome.runtime.sendMessage({ type: "CHECK_AUTH" });
  if (authResponse && authResponse.success) {
    showLeadCaptureUI(authResponse);
  } else {
    showLoginUI();
  }

  if (exportReportBtn) {
    exportReportBtn.addEventListener("click", handleExportReport);
  }

  // Listen to both input and change events to support immediate radio button syncing
  form.addEventListener("input", handleFormInput);
  form.addEventListener("change", handleFormInput);
  form.addEventListener("submit", handleCreateLead);
  clearButton.addEventListener("click", handleClearForm);
  autoPickNumberBtn.addEventListener("click", handleAutoPickNumber);
  autoPickNumberNameBtn.addEventListener("click", handleAutoPickNumberName);
  if (autoPickServiceNameBtn) {
    autoPickServiceNameBtn.addEventListener("click", handleAutoPickServiceName);
  }
  if (checkCrmNumberBtn) {
    checkCrmNumberBtn.addEventListener("click", handleCheckCrmNumber);
  }
  if (updateScheduleRequirementBtn) {
    updateScheduleRequirementBtn.addEventListener("click", handleUpdateScheduleRequirement);
  }
  if (autoPickPhotosBtn) {
    autoPickPhotosBtn.addEventListener("click", handleAutoPickPhotos);
  }
  if (findAddressBtn) {
    findAddressBtn.addEventListener("click", handleFindAddressClick);
  }
  if (checkExpectedAreaBtn) {
    checkExpectedAreaBtn.addEventListener("click", handleCheckExpectedArea);
  }

  // Automatic and silent URL tracking as tab updates or changes
  handleAutoPickUrlSilently();
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  chrome.tabs.onActivated.addListener(handleTabActivated);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "DRAFT_UPDATED" && message.draft) {
      const previousPhone = currentDraft?.customerNumber || "";
      currentDraft = message.draft;
      renderDraft(currentDraft);
      invalidateLeadCheckWhenPhoneChanges(previousPhone, currentDraft.customerNumber);
      updateScheduleRequirementButtonState();
      showFeedback("Draft updated from selected text.", "info");
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes.theme && changes.theme.newValue) {
      applyTheme(changes.theme.newValue);
    }

    if (changes.leadDraft?.newValue) {
      const previousPhone = currentDraft?.customerNumber || "";
      currentDraft = changes.leadDraft.newValue;
      renderDraft(currentDraft);
      invalidateLeadCheckWhenPhoneChanges(previousPhone, currentDraft.customerNumber);
      updateScheduleRequirementButtonState();
    }
  });

  if (addressSuggestionsList) {
    addressSuggestionsList.addEventListener("click", handleAddressSuggestionClick);
  }
}

function showLoginUI() {
  loginContainer.hidden = false;
  leadCaptureContainer.hidden = true;
  userSessionBar.hidden = true;
  resetLeadCheckState();
  clearFeedback();
}

function showLeadCaptureUI(authResponse) {
  loginContainer.hidden = true;
  leadCaptureContainer.hidden = false;
  userSessionBar.hidden = false;
  
  const displayEmail = authResponse.fullName || authResponse.user?.email || "Authenticated";
  userSessionEmail.textContent = displayEmail;
  userSessionEmail.title = authResponse.user?.email || "";

  switchTab("capture");
  clearFeedback();
  loadDraft();
  loadReports();
}

function switchTab(tabName) {
  if (tabName === "capture") {
    if (tabBtnCapture) tabBtnCapture.classList.add("active");
    if (tabBtnReports) tabBtnReports.classList.remove("active");
    if (viewCapture) viewCapture.classList.add("active");
    if (viewReports) viewReports.classList.remove("active");
  } else {
    if (tabBtnReports) tabBtnReports.classList.add("active");
    if (tabBtnCapture) tabBtnCapture.classList.remove("active");
    if (viewReports) viewReports.classList.add("active");
    if (viewCapture) viewCapture.classList.remove("active");
    loadReports();
  }
}

async function loadDraft() {
  const response = await chrome.runtime.sendMessage({ type: "GET_DRAFT" });
  currentDraft = response.draft;
  renderDraft(currentDraft);
  updateScheduleRequirementButtonState();
}


async function loadNpaNxxDatabase() {
  if (!npaNxxDatabasePromise) {
    npaNxxDatabasePromise = fetch(chrome.runtime.getURL("data/npa-nxx.json"))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Prefix database could not be loaded (${response.status}).`);
        }
        return response.json();
      })
      .catch((error) => {
        npaNxxDatabasePromise = null;
        throw error;
      });
  }

  return npaNxxDatabasePromise;
}

function normalizeUsPhoneForAreaLookup(value) {
  let digits = String(value || "").replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }

  return digits;
}

function renderExpectedAreaResult(message, type = "success") {
  if (!expectedAreaResult) return;
  expectedAreaResult.hidden = false;
  expectedAreaResult.className = `expected-area-result expected-area-result--${type}`;
  expectedAreaResult.textContent = message;
}

async function handleCheckExpectedArea() {
  const phoneValue = form?.customerNumber?.value || "";
  const digits = normalizeUsPhoneForAreaLookup(phoneValue);

  if (digits.length < 6) {
    renderExpectedAreaResult("Enter a valid US phone number first.", "error");
    return;
  }

  const prefix = digits.slice(0, 6);

  checkExpectedAreaBtn.disabled = true;
  const originalHtml = checkExpectedAreaBtn.innerHTML;
  checkExpectedAreaBtn.innerHTML = `<span>Checking...</span>`;
  renderExpectedAreaResult(`Checking ${prefix.slice(0, 3)}-${prefix.slice(3)}...`, "loading");

  try {
    const database = await loadNpaNxxDatabase();
    const exact = database?.prefixes?.[prefix];

    if (exact) {
      const area = friendlyExpectedAreaName(exact.city || exact.rateCenter, exact.state);
      const state = fullStateName(exact.state);

      if (area && state) {
        renderExpectedAreaResult(`${area}, ${state}`, "success");
        return;
      }

      if (state) {
        renderExpectedAreaResult(`Area unavailable, ${state}`, "warning");
        return;
      }
    }

    // Keep this as an exact 6-digit lookup. Do not guess from the 3-digit area code.
    renderExpectedAreaResult(`Exact area not found for ${prefix.slice(0, 3)}-${prefix.slice(3)}.`, "warning");
  } catch (error) {
    renderExpectedAreaResult(error.message || "Could not check expected area.", "error");
  } finally {
    checkExpectedAreaBtn.disabled = false;
    checkExpectedAreaBtn.innerHTML = originalHtml;
  }
}

// Authentication Logic
async function handleLoginSubmit(event) {
  event.preventDefault();
  clearFeedback();
  loginBtn.disabled = true;
  const originalText = loginBtn.innerHTML;
  loginBtn.innerHTML = `<span>Signing In...</span>`;

  try {
    const email = loginEmail.value.trim();
    const password = loginPassword.value;

    const response = await chrome.runtime.sendMessage({
      type: "LOGIN",
      email,
      password
    });

    if (!response || !response.success) {
      throw new Error(response?.error || "Login failed. Check your credentials.");
    }

    showLeadCaptureUI(response);
  } catch (error) {
    showFeedback(error.message || "Authentication failed.", "error");
  } finally {
    loginBtn.disabled = false;
    loginBtn.innerHTML = originalText;
  }
}

async function handleLogout() {
  clearFeedback();
  try {
    await chrome.runtime.sendMessage({ type: "LOGOUT" });
    loginPassword.value = "";

    // Clear reports cache & UI
    await chrome.storage.local.remove("extensionReportCache");
    if (reportTodayCount) reportTodayCount.textContent = "0";
    if (reportYesterdayCount) reportYesterdayCount.textContent = "0";
    if (reportHistoryList) {
      reportHistoryList.innerHTML = `<li class="history-empty">No recent extension leads.</li>`;
    }

    showLoginUI();
  } catch (error) {
    showFeedback("Logout failed: " + error.message, "error");
  }
}

async function handleExportReport() {
  clearFeedback();
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_EXTENSION_REPORT" });
    if (!response || !response.success || !response.history || response.history.length === 0) {
      throw new Error("No recent extension leads found to export.");
    }

    // Build CSV
    const headers = ["Captured At", "Job ID", "Customer Name", "Customer Phone", "Status"];
    const rows = response.history.map((lead) => [
      lead.createdAt ? formatCapturedAt(lead.createdAt) : "",
      lead.jobId || "",
      lead.customerName || "",
      lead.customerPhone || "",
      lead.status || ""
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) =>
        row
          .map((val) => `"${String(val).replaceAll('"', '""')}"`)
          .join(",")
      )
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    
    const filename = `extension_leads_report_${new Date().toISOString().slice(0, 10)}.csv`;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showFeedback("Report CSV saved successfully.", "success");
  } catch (error) {
    showFeedback("Export failed: " + error.message, "error");
  }
}

// Reports Logic
async function loadReports() {
  try {
    // 1. Load from cache first for instant UI response
    const cached = await chrome.storage.local.get("extensionReportCache");
    if (cached && cached.extensionReportCache) {
      const data = cached.extensionReportCache;
      reportTodayCount.textContent = data.todayCount;
      reportYesterdayCount.textContent = data.yesterdayCount;
      renderHistoryList(data.history);
    }

    // 2. Fetch fresh data from background worker
    const response = await chrome.runtime.sendMessage({ type: "GET_EXTENSION_REPORT" });
    if (response && response.success) {
      reportTodayCount.textContent = response.todayCount;
      reportYesterdayCount.textContent = response.yesterdayCount;
      renderHistoryList(response.history);

      // Save to cache for next load
      await chrome.storage.local.set({
        extensionReportCache: {
          todayCount: response.todayCount,
          yesterdayCount: response.yesterdayCount,
          history: response.history
        }
      });
    }
  } catch (error) {
    console.error("Could not load extension reports", error);
  }
}

function renderHistoryList(history) {
  reportHistoryList.innerHTML = "";
  if (!history || history.length === 0) {
    reportHistoryList.innerHTML = `<li class="history-empty">No recent extension leads.</li>`;
    return;
  }

  history.forEach((lead) => {
    const li = document.createElement("li");
    li.className = "history-item";

    const dateStr = formatCapturedAt(lead.createdAt);
    
    // Status dot color mapping
    let dotColor = "var(--text-muted)";
    if (lead.status === "urgent_job" || lead.status === "need_tech") {
      dotColor = "#ef4444"; // red
    } else if (lead.status === "pending_to_send" || lead.status === "quote_sent_waiting") {
      dotColor = "#f59e0b"; // amber
    } else if (lead.status === "scheduled") {
      dotColor = "var(--primary-teal)"; // teal
    } else if (lead.status === "job_done" || lead.status === "paid") {
      dotColor = "#10b981"; // green
    } else if (lead.status === "cancelled") {
      dotColor = "#6b7280"; // grey
    }

    li.innerHTML = `
      <div class="history-item__left">
        <span class="history-item__title">${escapeHtml(lead.customerName || "No Name")}</span>
        <span class="history-item__phone">${escapeHtml(lead.customerPhone || "No Number")}</span>
        <span class="history-item__date">${escapeHtml(dateStr)}</span>
      </div>
      <div class="history-item__right">
        <span class="history-item__job-id">${escapeHtml(lead.jobId)}</span>
        <span class="history-item__status-dot" style="background-color: ${dotColor};" title="${escapeHtml(lead.status)}"></span>
      </div>
    `;
    reportHistoryList.appendChild(li);
  });
}

// Lead Form logic
async function handleFormInput(event) {
  const target = event.target;
  if (!target.name || !EDITABLE_FIELDS.includes(target.name)) {
    return;
  }

  let value = target.value;
  if (target.type === "radio" && currentDraft && currentDraft[target.name] === value) {
    return;
  }

  if (target.name === "customerNumber") {
    formatPhoneInput(target);
    value = target.value;
  }

  const payload = {
    [target.name]: value
  };

  if (target.name === "terms" && value !== "quoted") {
    payload.quote = "";
    if (form.quote) {
      form.quote.value = "";
    }
  }

  const updatedDraft = {
    ...currentDraft,
    ...payload
  };

  const previousPhone = currentDraft?.customerNumber || "";
  currentDraft = updatedDraft;
  invalidateLeadCheckWhenPhoneChanges(previousPhone, updatedDraft.customerNumber);
  updateScheduleRequirementButtonState();
  updateQuoteFieldVisibility(updatedDraft.terms);
  await chrome.runtime.sendMessage({
    type: "UPDATE_DRAFT",
    payload
  });

  if (target.name === "customerAddress") {
    hideAddressSuggestions();
  }
}

async function handleClearForm() {
  const response = await chrome.runtime.sendMessage({ type: "CLEAR_DRAFT" });
  currentDraft = response.draft;
  suppressAddressLookup = false;
  renderDraft(currentDraft);
  resetTransientFormState();
  showFeedback("Draft cleared.", "info");
}

async function handleCreateLead(event) {
  event.preventDefault();
  clearFeedback();
  createLeadButton.disabled = true;
  createLeadButton.innerHTML = `<svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="animation: spin 0.8s linear infinite"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-linecap="round"/></svg><span>Creating...</span>`;

  try {
    const response = await chrome.runtime.sendMessage({ type: "CREATE_LEAD" });

    if (!response?.success) {
      throw new Error(response?.error || "Lead creation failed.");
    }

    // Auto-clear the draft on successful creation
    const clearResponse = await chrome.runtime.sendMessage({ type: "CLEAR_DRAFT" });
    currentDraft = clearResponse.draft;
    suppressAddressLookup = false;
    renderDraft(currentDraft);
    resetTransientFormState();

      const leadUrl = response.response?.leadUrl;
      // The lead was created in its normal status because urgent was asked for.
      // Saying "created successfully" here would report a request that did not
      // happen, so the message states what is outstanding and what to do.
      const urgentPending = response.response?.urgentCheckRequired === true;
      // Prefers the deep link, which opens the AI review itself, so the status
      // change is not something the CS member has to redo by hand.
      const reviewUrl = response.response?.urgentReviewUrl || leadUrl;
      const successHtml = leadUrl
        ? `Lead created successfully. <a href="${escapeHtml(leadUrl)}" target="_blank" rel="noreferrer">Open Lead</a>`
        : "Lead created successfully.";

      showFeedback(
        urgentPending && reviewUrl
          ? `${successHtml}<br><br>This lead was not marked urgent. <a href="${escapeHtml(reviewUrl)}" target="_blank" rel="noreferrer">Run the conversation check</a> to review it against the customer chat, then mark it urgent.`
          : urgentPending
            ? `${successHtml}<br><br>This lead was not marked urgent. Open it in the CRM to run the conversation check first.`
            : successHtml,
        // "info" is the neutral-but-notable kind here. There is no
        // feedback--warning class in the stylesheet, so passing one would leave
        // the toast unstyled.
        urgentPending ? "info" : "success",
        true,
      );
    
    // Refresh stats and history list!
    loadReports();
  } catch (error) {
    showFeedback(error.message || "Lead creation failed.", "error");
  } finally {
    createLeadButton.disabled = false;
    createLeadButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Create Lead</span>`;
  }
}

const UPDATE_SCHEDULE_BUTTON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Update Schedule Requirement</span>`;

function normalizePhoneForLeadCheck(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

function phonesMatchForLeadCheck(a, b) {
  const first = normalizePhoneForLeadCheck(a);
  const second = normalizePhoneForLeadCheck(b);
  return Boolean(first && second && first === second);
}

function invalidateLeadCheckWhenPhoneChanges(previousPhone, nextPhone) {
  if (!checkedPhone && checkedLeads.length === 0) return;
  if (!phonesMatchForLeadCheck(previousPhone, nextPhone) || !phonesMatchForLeadCheck(checkedPhone, nextPhone)) {
    resetLeadCheckState();
  }
}

function updateScheduleRequirementButtonState() {
  if (!updateScheduleRequirementBtn) return;
  const hasSchedule = Boolean(form?.scheduleRequirement?.value.trim());
  const phoneStillMatches = phonesMatchForLeadCheck(form?.customerNumber?.value, checkedPhone);
  const canUpdate = leadCheckCompleted && selectedCheckedLeadId && hasSchedule && phoneStillMatches;
  updateScheduleRequirementBtn.disabled = scheduleUpdateInProgress || !canUpdate;

  if (scheduleUpdateInProgress) {
    updateScheduleRequirementBtn.title = "Updating the selected lead...";
  } else if (!leadCheckCompleted) {
    updateScheduleRequirementBtn.title = "Press Check Lead first";
  } else if (!selectedCheckedLeadId) {
    updateScheduleRequirementBtn.title = "Select a matching lead first";
  } else if (!hasSchedule) {
    updateScheduleRequirementBtn.title = "Enter a schedule requirement first";
  } else if (!phoneStillMatches) {
    updateScheduleRequirementBtn.title = "The customer number changed. Check Lead again";
  } else {
    updateScheduleRequirementBtn.title = "Replace the selected lead's schedule requirement";
  }
}

function resetLeadCheckState({ clearMessage = true } = {}) {
  checkedLeads = [];
  selectedCheckedLeadId = "";
  checkedPhone = "";
  leadCheckCompleted = false;

  if (matchingLeadsList) matchingLeadsList.replaceChildren();
  if (matchingLeadsContainer) matchingLeadsContainer.hidden = true;
  if (clearMessage) clearCheckLeadFeedback();
  updateScheduleRequirementButtonState();
}

function resetTransientFormState() {
  suppressAddressLookup = false;
  hideAddressSuggestions();
  resetLeadCheckState();
  if (expectedAreaResult) {
    expectedAreaResult.hidden = true;
    expectedAreaResult.textContent = "";
    expectedAreaResult.className = "expected-area-result";
  }
}

function addLeadMetaLine(container, text, className = "matching-lead-option__meta") {
  if (!text) return;
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  container.appendChild(line);
}

function renderMatchingLeads() {
  if (!matchingLeadsContainer || !matchingLeadsList) return;
  matchingLeadsList.replaceChildren();

  if (checkedLeads.length === 0) {
    matchingLeadsContainer.hidden = true;
    updateScheduleRequirementButtonState();
    return;
  }

  matchingLeadsContainer.hidden = false;
  if (matchingLeadsTitle) {
    matchingLeadsTitle.textContent = `${checkedLeads.length} matching lead${checkedLeads.length === 1 ? "" : "s"}`;
  }

  checkedLeads.forEach((lead) => {
    const label = document.createElement("label");
    label.className = "matching-lead-option";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "checkedLeadSelection";
    radio.value = lead.id;
    radio.checked = selectedCheckedLeadId === lead.id;
    radio.addEventListener("change", () => {
      selectedCheckedLeadId = lead.id;
      updateScheduleRequirementButtonState();
    });

    const content = document.createElement("div");
    content.className = "matching-lead-option__content";

    const title = document.createElement("div");
    title.className = "matching-lead-option__title";
    title.textContent = `${lead.job_id || "No Job ID"} · ${lead.customer_name || "Unnamed customer"}`;
    content.appendChild(title);

    addLeadMetaLine(content, [lead.service_type, lead.status].filter(Boolean).join(" · "));
    addLeadMetaLine(content, lead.address || "No address");
    addLeadMetaLine(
      content,
      `Current schedule: ${lead.customer_schedule_requirements || "None"}`,
      "matching-lead-option__schedule"
    );

    label.appendChild(radio);
    label.appendChild(content);
    matchingLeadsList.appendChild(label);
  });

  updateScheduleRequirementButtonState();
}

async function handleUpdateScheduleRequirement() {
  clearFeedback();

  const selectedLead = checkedLeads.find((lead) => lead.id === selectedCheckedLeadId);
  const scheduleRequirement = form.scheduleRequirement.value.trim();

  if (!leadCheckCompleted || !selectedLead) {
    showFeedback("Press Check Lead and select the correct existing lead first.", "error");
    updateScheduleRequirementButtonState();
    return;
  }
  if (!phonesMatchForLeadCheck(form.customerNumber.value, checkedPhone)) {
    resetLeadCheckState();
    showFeedback("The customer number changed. Press Check Lead again.", "error");
    return;
  }
  if (!scheduleRequirement) {
    showFeedback("Enter the new schedule requirement before updating.", "error");
    updateScheduleRequirementButtonState();
    return;
  }

  scheduleUpdateInProgress = true;
  updateScheduleRequirementBtn.innerHTML = `<svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-linecap="round"/></svg><span>Updating...</span>`;
  updateScheduleRequirementButtonState();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "UPDATE_LEAD_SCHEDULE_REQUIREMENT",
      leadId: selectedLead.id,
      scheduleRequirement,
      checkedPhone
    });

    if (!response?.success) {
      throw new Error(response?.error || "Schedule requirement update failed.");
    }

    const clearResponse = await chrome.runtime.sendMessage({ type: "CLEAR_DRAFT" });
    currentDraft = clearResponse.draft;
    renderDraft(currentDraft);
    resetTransientFormState();

    const updatedLead = response.response?.lead;
    const jobId = updatedLead?.job_id || selectedLead.job_id || "selected lead";
    const leadUrl = response.response?.leadUrl;
    const successHtml = leadUrl
      ? `Schedule requirement updated for Job ID ${escapeHtml(jobId)}. <a href="${escapeHtml(leadUrl)}" target="_blank" rel="noreferrer">Open Lead</a>`
      : `Schedule requirement updated for Job ID ${escapeHtml(jobId)}.`;

    showFeedback(successHtml, "success", true);
    loadReports();
  } catch (error) {
    showFeedback(error.message || "Schedule requirement update failed.", "error");
  } finally {
    scheduleUpdateInProgress = false;
    updateScheduleRequirementBtn.innerHTML = UPDATE_SCHEDULE_BUTTON_HTML;
    updateScheduleRequirementButtonState();
  }
}

function renderDraft(draft) {
  draft = draft || {};

  // Update editable fields safely to prevent cursor jumping
  const inputs = [
    "customerName",
    "customerNumber",
    "customerAddress",
    "numberName",
    "serviceName",
    "referenceName",
    "serviceDetails",
    "quote",
    "scheduleRequirement"
  ];

  inputs.forEach((field) => {
    const element = form[field];
    if (element) {
      let val = draft[field] || "";
      if (field === "customerNumber") {
        val = formatPhoneNumber(val);
      }
      if (element.value !== val) {
        element.value = val;
      }
    }
  });

  // Sync direction (radio buttons / segmented control)
  const directionVal = draft.direction || "incoming";
  const radios = form.elements["direction"];
  if (radios) {
    radios.value = directionVal;
  }

  const leadStatusVal = draft.leadStatus || "default";
  const statusRadios = form.querySelectorAll('input[name="leadStatus"]');
  statusRadios.forEach((radio) => {
    radio.checked = radio.value === leadStatusVal;
  });

  const termsVal = draft.terms || "";
  const termsRadios = form.querySelectorAll('input[name="terms"]');
  termsRadios.forEach((radio) => {
    radio.checked = radio.value === termsVal;
  });
  updateQuoteFieldVisibility(termsVal);

  // Safely select and update read-only fields outside the main form element
  const capturedAtInput = document.querySelector('[name="capturedAt"]');
  const sourceUrlInput = document.querySelector('[name="sourceUrl"]');

  if (capturedAtInput) {
    const rawTime = draft.capturedAt || "";
    const formattedTime = rawTime ? formatCapturedAt(rawTime) : "";
    if (capturedAtInput.value !== formattedTime) {
      capturedAtInput.value = formattedTime;
    }
  }

  if (sourceUrlInput) {
    const rawUrl = draft.sourceUrl || "";
    if (sourceUrlInput.value !== rawUrl) {
      sourceUrlInput.value = rawUrl;
    }
  }

  // Render chat pictures preview
  renderPhotos(draft.photos || []);
}


function updateQuoteFieldVisibility(terms) {
  if (!quoteField) return;
  quoteField.hidden = terms !== "quoted";
}

function queueAddressSuggestions(rawValue) {
  if (suppressAddressLookup) {
    suppressAddressLookup = false;
  }

  const query = (rawValue || "").trim();
  if (!query || query.length < ADDRESS_MIN_QUERY_LENGTH) {
    hideAddressSuggestions();
    return;
  }

  showAddressSuggestionState("Click Find Address to search standardized matches.", "idle");
}

async function fetchAddressSuggestions(query) {
  try {
    const normalizedQuery = normalizeAddressQuery(query);
    const response = await chrome.runtime.sendMessage({
      type: "CENSUS_ADDRESS_LOOKUP",
      address: normalizedQuery
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unable to search addresses.");
    }

    const normalizedResults = (response.matches || [])
      .map((match) => ({
        address: typeof match?.matchedAddress === "string" ? match.matchedAddress.trim() : ""
      }))
      .filter((result) => result.address);

    if (normalizedResults.length === 0) {
      showAddressSuggestionState("No matching address found", "empty");
      return;
    }

    renderAddressSuggestions(normalizedResults);
  } catch (error) {
    console.error("Address suggestion lookup failed:", error);
    if ((error?.message || "").includes("Extension context invalidated")) {
      showAddressSuggestionState("Extension updated — refresh the Quo tab", "error");
      return;
    }
    showAddressSuggestionState(error?.message || "Unable to search addresses", "error");
  }
}

function renderAddressSuggestions(results) {
  if (!addressSuggestions || !addressSuggestionsStatus || !addressSuggestionsList) {
    return;
  }

  addressSuggestions.hidden = false;
  delete addressSuggestions.dataset.state;
  addressSuggestionsStatus.textContent = `Suggestions from ${ADDRESS_PROVIDER_NAME}`;
  addressSuggestionsList.innerHTML = "";

  results.forEach((result) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-item";
    button.dataset.address = result.address || "";
    button.textContent = result.address || "";
    addressSuggestionsList.appendChild(button);
  });
}

function showAddressSuggestionState(message, state) {
  if (!addressSuggestions || !addressSuggestionsStatus || !addressSuggestionsList) {
    return;
  }

  addressSuggestions.hidden = false;
  addressSuggestions.dataset.state = state;
  addressSuggestionsStatus.textContent = message;
  addressSuggestionsList.innerHTML = "";
}

function hideAddressSuggestions() {
  if (!addressSuggestions || !addressSuggestionsStatus || !addressSuggestionsList) {
    return;
  }

  addressSuggestions.hidden = true;
  addressSuggestionsStatus.textContent = "";
  addressSuggestionsList.innerHTML = "";
  delete addressSuggestions.dataset.state;
}

async function handleAddressSuggestionClick(event) {
  const button = event.target.closest(".suggestion-item");
  if (!button || !form.customerAddress) {
    return;
  }

  const nextAddress = button.dataset.address || "";
  suppressAddressLookup = true;
  form.customerAddress.value = nextAddress;

  currentDraft = {
    ...(currentDraft || {}),
    customerAddress: nextAddress
  };

  try {
    await chrome.runtime.sendMessage({
      type: "UPDATE_DRAFT",
      payload: {
        customerAddress: nextAddress
      }
    });
  } catch (error) {
    if ((error?.message || "").includes("Extension context invalidated")) {
      showFeedback("Extension was updated. Refresh the Quo tab and reopen the side panel.", "error");
      return;
    }
    throw error;
  }

  // Show confirmation inside the dropdown area, not the global toast
  if (addressSuggestions && addressSuggestionsStatus) {
    addressSuggestions.hidden = false;
    addressSuggestions.dataset.state = "success";
    addressSuggestionsStatus.textContent = "\u2713 Address applied successfully";
    if (addressSuggestionsList) addressSuggestionsList.innerHTML = "";
    // Auto-hide the dropdown after 2 seconds
    setTimeout(() => {
      hideAddressSuggestions();
    }, 2000);
  }
}

async function handleFindAddressClick() {
  clearFeedback();
  const query = (form.customerAddress?.value || "").trim();

  if (!query) {
    // Show the error inside the address dropdown, not the global toast
    showAddressSuggestionState("Enter an address first, then click Find.", "error");
    return;
  }

  window.clearTimeout(addressSuggestionTimer);
  showAddressSuggestionState("Searching addresses...", "loading");

  addressSuggestionTimer = window.setTimeout(() => {
    fetchAddressSuggestions(query);
  }, ADDRESS_DEBOUNCE_MS);
}

function normalizeAddressQuery(rawQuery) {
  let normalized = (rawQuery || "").trim();
  normalized = normalized.replace(/\s+/g, " ");
  normalized = normalized.replace(/\bin\s+([A-Za-z][A-Za-z.\-'\s]+)/i, ", $1");
  normalized = normalized.replace(/\b(?:please|pls|find|address|at|near|around)\b/gi, " ");
  normalized = normalized.replace(/\s+,/g, ",");
  normalized = normalized.replace(/,\s*,+/g, ", ");
  normalized = normalized.replace(/\s{2,}/g, " ");
  normalized = normalized.replace(/\s*,\s*/g, ", ");
  return normalized.trim().replace(/,$/, "");
}

function formatCapturedAt(isoString) {
  try {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch (e) {
    return isoString;
  }
}

function showFeedback(message, type, allowHtml = false) {
  feedback.hidden = false;
  feedback.className = `feedback feedback--${type}`;
  
  let iconSvg = "";
  if (type === "success") {
    iconSvg = `<svg class="feedback__icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  } else if (type === "error") {
    iconSvg = `<svg class="feedback__icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  } else {
    iconSvg = `<svg class="feedback__icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  }
  
  const contentSpan = document.createElement("span");
  contentSpan.className = "feedback__content";
  if (allowHtml) {
    contentSpan.innerHTML = message;
  } else {
    contentSpan.textContent = message;
  }
  
  feedback.innerHTML = "";
  feedback.appendChild(createSvgElement(iconSvg));
  feedback.appendChild(contentSpan);
  
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "feedback__close";
  closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.addEventListener("click", clearFeedback);
  feedback.appendChild(closeBtn);
}

function createSvgElement(svgString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, "image/svg+xml");
  return doc.documentElement;
}

function clearFeedback() {
  feedback.hidden = true;
  feedback.textContent = "";
  feedback.className = "feedback";
  clearCheckLeadFeedback();
}

function escapeHtml(value) {
  if (!value) return "";
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function handleAutoPickNumber() {
  clearFeedback();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active browser tab found.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_CUSTOMER_NUMBER" });
    
    if (response && response.success && response.number) {
      const formatted = formatPhoneNumber(response.number);
      form.customerNumber.value = formatted;

      await chrome.runtime.sendMessage({
        type: "UPDATE_DRAFT",
        payload: {
          customerNumber: formatted
        }
      });

      const previousPhone = currentDraft.customerNumber || "";
      currentDraft.customerNumber = formatted;
      invalidateLeadCheckWhenPhoneChanges(previousPhone, formatted);
      updateScheduleRequirementButtonState();
      showFeedback(`Customer number auto-picked: ${formatted}`, "success");
    } else {
      throw new Error("Could not find any customer number in the header of this page.");
    }
  } catch (error) {
    let errMsg = error.message || "Failed to auto-pick number.";
    if (errMsg.includes("Receiving end does not exist") || errMsg.includes("Could not establish connection")) {
      errMsg = "Could not connect to quo.com page. Please ensure you are active on the quo.com chat page and refresh the page.";
    }
    showFeedback(errMsg, "error");
  }
}

async function handleAutoPickNumberName() {
  clearFeedback();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active browser tab found.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NUMBER_NAME" });
    
    if (response && response.success && response.name) {
      form.numberName.value = response.name;

      await chrome.runtime.sendMessage({
        type: "UPDATE_DRAFT",
        payload: {
          numberName: response.name
        }
      });

      currentDraft.numberName = response.name;
      showFeedback(`Number name auto-picked: ${response.name}`, "success");
    } else {
      throw new Error("Could not find active channel/number name on this page.");
    }
  } catch (error) {
    let errMsg = error.message || "Failed to auto-pick number name.";
    if (errMsg.includes("Receiving end does not exist") || errMsg.includes("Could not establish connection")) {
      errMsg = "Could not connect to quo.com page. Please ensure you are active on the quo.com chat page and refresh the page.";
    }
    showFeedback(errMsg, "error");
  }
}

async function handleAutoPickServiceName() {
  clearFeedback();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active browser tab found.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "OPEN_ASSIGN_FIELD_MENU",
      field: "serviceName"
    });

    if (!response?.success) {
      throw new Error(response?.error || "Failed to open service text picker.");
    }

    showFeedback("Select service text in the chat, then click Service Name / Keyword in the Assign Field menu.", "info");
  } catch (error) {
    let errMsg = error.message || "Failed to open service text picker.";
    if (errMsg.includes("Receiving end does not exist") || errMsg.includes("Could not establish connection")) {
      errMsg = "Could not connect to quo.com page. Please ensure you are active on the quo.com chat page and refresh the page.";
    }
    showFeedback(errMsg, "error");
  }
}

async function handleCheckCrmNumber() {
  clearFeedback();
  resetLeadCheckState();

  let phone = formatPhoneNumber(form.customerNumber.value.trim());

  try {
    if (checkCrmNumberBtn) checkCrmNumberBtn.disabled = true;

    // Auto-pick the active Quo customer number before checking.
    try {
      showCheckLeadFeedback("Auto-picking customer number...", "info");
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const scrapeResponse = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_CUSTOMER_NUMBER" });
        if (scrapeResponse?.success && scrapeResponse.number) {
          phone = formatPhoneNumber(scrapeResponse.number.trim());
          form.customerNumber.value = phone;
          currentDraft.customerNumber = phone;
          await chrome.runtime.sendMessage({
            type: "UPDATE_DRAFT",
            payload: { customerNumber: phone }
          });
        }
      }
    } catch (error) {
      console.log("Auto-pick during check lead failed, falling back to current field value:", error);
    }

    if (!phone) {
      showCheckLeadFeedback("Please enter or auto-pick a phone number to check.", "error");
      return;
    }

    showCheckLeadFeedback("Checking CRM database...", "info");
    const response = await chrome.runtime.sendMessage({
      type: "CHECK_LEAD_EXISTS",
      phone
    });

    if (!response?.success) {
      throw new Error(response?.error || "Failed to check lead status.");
    }

    checkedPhone = phone;
    leadCheckCompleted = true;
    checkedLeads = Array.isArray(response.leads) ? response.leads : [];
    selectedCheckedLeadId = "";
    renderMatchingLeads();

    if (checkedLeads.length > 0) {
      showCheckLeadFeedback(
        `Found ${checkedLeads.length} existing active lead${checkedLeads.length === 1 ? "" : "s"}. Select the correct lead below.`,
        "info"
      );
    } else {
      showCheckLeadFeedback("Not in CRM. You can safely add this lead.", "success");
    }
  } catch (error) {
    resetLeadCheckState({ clearMessage: false });
    showCheckLeadFeedback(error.message || "Failed to check CRM.", "error");
  } finally {
    if (checkCrmNumberBtn) checkCrmNumberBtn.disabled = false;
    updateScheduleRequirementButtonState();
  }
}

function showCheckLeadFeedback(message, type, allowHtml = false) {
  if (!checkLeadFeedback) return;
  checkLeadFeedback.hidden = false;
  checkLeadFeedback.className = `feedback feedback--${type}`;
  
  let iconSvg = "";
  if (type === "success") {
    iconSvg = `<svg class="feedback__icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  } else if (type === "error") {
    iconSvg = `<svg class="feedback__icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  } else {
    iconSvg = `<svg class="feedback__icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  }
  
  const contentSpan = document.createElement("span");
  contentSpan.className = "feedback__content";
  if (allowHtml) {
    contentSpan.innerHTML = message;
  } else {
    contentSpan.textContent = message;
  }
  
  checkLeadFeedback.innerHTML = "";
  checkLeadFeedback.appendChild(createSvgElement(iconSvg));
  checkLeadFeedback.appendChild(contentSpan);
}

function clearCheckLeadFeedback() {
  if (checkLeadFeedback) {
    checkLeadFeedback.hidden = true;
    checkLeadFeedback.innerHTML = "";
  }
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

function formatPhoneInput(input) {
  const selectionStart = input.selectionStart;
  const originalValue = input.value;
  const formattedValue = formatPhoneNumber(originalValue);
  
  if (originalValue !== formattedValue) {
    input.value = formattedValue;
    
    let digitsBeforeCursor = 0;
    for (let i = 0; i < selectionStart; i++) {
      if (/\d/.test(originalValue[i])) {
        digitsBeforeCursor++;
      }
    }
    
    let newCursorPosition = 0;
    let digitsCount = 0;
    while (newCursorPosition < formattedValue.length && digitsCount < digitsBeforeCursor) {
      if (/\d/.test(formattedValue[newCursorPosition])) {
        digitsCount++;
      }
      newCursorPosition++;
    }
    
    input.setSelectionRange(newCursorPosition, newCursorPosition);
  }
}

async function handleAutoPickUrlSilently() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
      if (!currentDraft || currentDraft.sourceUrl !== tab.url) {
        if (!currentDraft) {
          currentDraft = {};
        }
        currentDraft.sourceUrl = tab.url;
        const sourceUrlInput = document.querySelector('[name="sourceUrl"]');
        if (sourceUrlInput) {
          sourceUrlInput.value = tab.url;
        }
        await chrome.runtime.sendMessage({
          type: "UPDATE_DRAFT",
          payload: { sourceUrl: tab.url }
        });
      }
    }
  } catch (error) {
    console.debug("Silent auto-pick URL failed:", error);
  }
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.url) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id === tabId) {
        await handleAutoPickUrlSilently();
      }
    } catch (e) {
      console.debug("Error handling tab update:", e);
    }
  }
}

async function handleTabActivated(activeInfo) {
  try {
    await handleAutoPickUrlSilently();
  } catch (e) {
    console.debug("Error handling tab activation:", e);
  }
}

async function handleAutoPickPhotos() {
  clearFeedback();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active browser tab found.");
    }

    // Send a message to content.js to scrape images
    const response = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_CHAT_IMAGES" });
    
    if (response && response.success && response.images && response.images.length > 0) {
      // Merge with existing picked photos (avoid duplicates)
      const existingPhotos = currentDraft.photos || [];
      const newPhotos = response.images.filter(img => !existingPhotos.includes(img));
      const mergedPhotos = [...existingPhotos, ...newPhotos];
      
      currentDraft.photos = mergedPhotos;
      await chrome.runtime.sendMessage({
        type: "UPDATE_DRAFT",
        payload: { photos: mergedPhotos }
      });
      
      renderPhotos(mergedPhotos);
      showFeedback(`Picked ${newPhotos.length} new pictures from the chat.`, "success");
    } else {
      throw new Error("No pictures found in the active chat page.");
    }
  } catch (error) {
    let errMsg = error.message || "Failed to pick pictures.";
    if (errMsg.includes("Receiving end does not exist") || errMsg.includes("Could not establish connection")) {
      errMsg = "Please ensure you are active on the quo.com chat page and refresh the page.";
    }
    showFeedback(errMsg, "error");
  }
}

function renderPhotos(photos) {
  if (!photosPreviewContainer || !noPhotosLabel) return;
  
  photosPreviewContainer.innerHTML = "";
  
  if (!photos || photos.length === 0) {
    photosPreviewContainer.style.display = "none";
    noPhotosLabel.style.display = "block";
    return;
  }
  
  photosPreviewContainer.style.display = "grid";
  noPhotosLabel.style.display = "none";
  
  photos.forEach((url, index) => {
    const thumb = document.createElement("div");
    thumb.className = "photo-thumb";
    
    const img = document.createElement("img");
    img.src = url;
    img.alt = `Chat image ${index + 1}`;
    
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "photo-thumb__remove";
    removeBtn.title = "Remove picture";
    removeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    
    removeBtn.addEventListener("click", async () => {
      const updatedPhotos = currentDraft.photos.filter((_, idx) => idx !== index);
      currentDraft.photos = updatedPhotos;
      await chrome.runtime.sendMessage({
        type: "UPDATE_DRAFT",
        payload: { photos: updatedPhotos }
      });
      renderPhotos(updatedPhotos);
    });
    
    thumb.appendChild(img);
    thumb.appendChild(removeBtn);
    photosPreviewContainer.appendChild(thumb);
  });
}
