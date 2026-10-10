const FIELD_ACTIONS = [
  {
    label: "Customer Name",
    field: "customerName",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`
  },
  {
    label: "Customer Number",
    field: "customerNumber",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`
  },
  {
    label: "Address",
    field: "customerAddress",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`
  },
  {
    label: "Number Name",
    field: "numberName",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`
  },
  {
    label: "Service Name / Keyword",
    field: "serviceName",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
  },
  {
    label: "Schedule Req.",
    field: "scheduleRequirement",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`
  }
];

const MENU_ID = "quo-crm-floating-menu";
const RELOAD_BANNER_ID = "quo-crm-reload-banner";
const MENU_MARGIN = 12;
let menuElement = null;
let reloadBannerElement = null;
let hideMenuTimeout = null;
let latestSelectionText = "";
let latestSelectionRect = null;
let latestPointerPosition = null;
let suppressMenuUntilSelectionChanges = false;
let contextInvalidated = false;
let heartbeatInterval = null;
let lastNotifiedConversationUrl = window.location.href;
let conversationChangeObserver = null;

initialize();

function initialize() {
  notifyPageReady();
  document.addEventListener("selectionchange", cacheSelectionState);
  document.addEventListener("mouseup", handleSelectionEvent);
  document.addEventListener("keyup", handleSelectionEvent);
  document.addEventListener("mousemove", trackPointerPosition, true);
  document.addEventListener("mousedown", handleDocumentMouseDown, true);
  window.addEventListener("scroll", handleViewportChange, true);
  window.addEventListener("resize", handleViewportChange);
  window.addEventListener("blur", hideMenu);
  window.addEventListener("popstate", notifyConversationUrlChange);

  conversationChangeObserver = new MutationObserver(notifyConversationUrlChange);
  conversationChangeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Poll for context invalidation (extension reloaded/updated while this
  // tab stayed open) so we can surface a clear recovery prompt instead of
  // letting every subsequent action fail with a raw thrown error.
  heartbeatInterval = window.setInterval(checkExtensionContext, 4000);

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.theme?.newValue) {
        if (menuElement) {
          menuElement.setAttribute("data-theme", changes.theme.newValue);
        }
      }
    });
  } catch (e) {
    // Ignore context issues
  }
}

/**
 * Returns true only when the extension's background connection is alive.
 * chrome.runtime can still exist as an object after invalidation, but
 * chrome.runtime.id becomes undefined — that's the reliable signal.
 */
function isExtensionContextValid() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
  } catch (error) {
    return false;
  }
}

function checkExtensionContext() {
  if (contextInvalidated) return;
  if (!isExtensionContextValid()) {
    handleContextInvalidated();
  }
}

/**
 * Called the first time we detect the extension was reloaded/updated
 * underneath this tab. Stops further background calls, hides the
 * field-assign menu, and shows a small persistent banner with a
 * one-click reload instead of failing silently or with alert() popups.
 */
function handleContextInvalidated() {
  if (contextInvalidated) return;
  contextInvalidated = true;

  if (heartbeatInterval) {
    window.clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  hideMenu();
  showReloadBanner();
}

function showReloadBanner() {
  if (reloadBannerElement) return;

  const banner = document.createElement("div");
  banner.id = RELOAD_BANNER_ID;
  banner.innerHTML = `
    <span class="quo-reload-banner__dot"></span>
    <span class="quo-reload-banner__text">Donut extension was updated. Refresh this tab to keep capturing leads.</span>

    <button type="button" class="quo-reload-banner__btn">Refresh Tab</button>
    <button type="button" class="quo-reload-banner__close" aria-label="Dismiss">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  banner.querySelector(".quo-reload-banner__btn").addEventListener("click", () => {
    window.location.reload();
  });
  banner.querySelector(".quo-reload-banner__close").addEventListener("click", () => {
    banner.remove();
    reloadBannerElement = null;
  });

  document.body.appendChild(banner);
  reloadBannerElement = banner;
}

function handleSelectionEvent(event) {
  if (event) {
    updatePointerPositionFromEvent(event);
  }

  cacheSelectionState();
  window.clearTimeout(hideMenuTimeout);
  hideMenuTimeout = window.setTimeout(showMenuForSelection, 10);
}

function trackPointerPosition(event) {
  updatePointerPositionFromEvent(event);
}

function updatePointerPositionFromEvent(event) {
  if (
    !event ||
    typeof event.clientX !== "number" ||
    typeof event.clientY !== "number"
  ) {
    return;
  }

  latestPointerPosition = {
    clientX: event.clientX,
    clientY: event.clientY
  };
}

function handleDocumentMouseDown(event) {
  updatePointerPositionFromEvent(event);

  if (menuElement && menuElement.contains(event.target)) {
    return;
  }

  hideMenu();
}

function showMenuForSelection() {
  if (suppressMenuUntilSelectionChanges || !latestSelectionText) {
    hideMenu();
    return;
  }

  if (!menuElement) {
    menuElement = buildMenu();
    document.body.appendChild(menuElement);
  }

  refreshSelectionAnchor();
  const anchor = getMenuAnchor();
  if (!anchor) {
    hideMenu();
    return;
  }

  menuElement.dataset.selectedText = latestSelectionText;
  menuElement.classList.remove("quo-hidden");
  positionMenu(anchor);
}

function buildMenu() {
  const container = document.createElement("div");
  container.id = MENU_ID;
  container.classList.add("quo-hidden");
  container.addEventListener("mousedown", handleMenuMouseDown);
  container.addEventListener("click", handleMenuClick);

  // Sync theme with extension storage
  try {
    chrome.storage.local.get({ theme: "light" }, (data) => {
      if (container && chrome.runtime?.id) {
        container.setAttribute("data-theme", data?.theme || "light");
      }
    });
  } catch (e) {
    container.setAttribute("data-theme", "light");
  }

  const header = document.createElement("div");
  header.className = "quo-menu-header";

  const title = document.createElement("div");
  title.className = "quo-title";
  title.textContent = "Assign Field";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "quo-close-btn";
  closeButton.dataset.action = "close";
  closeButton.setAttribute("aria-label", "Close assignment menu");
  closeButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  header.append(title, closeButton);
  container.appendChild(header);

  const actionGrid = document.createElement("div");
  actionGrid.className = "quo-action-grid";

  FIELD_ACTIONS.forEach(({ label, field, icon }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quo-field-btn";
    button.dataset.field = field;
    button.innerHTML = `${icon}<span>${label}</span>`;
    actionGrid.appendChild(button);
  });

  container.appendChild(actionGrid);
  return container;
}

function positionMenu(anchor) {
  if (!menuElement || !anchor) {
    return;
  }

  const menuRect = measureMenu();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const preferredLeft = anchor.centerX - menuRect.width / 2;
  const maxLeft = Math.max(MENU_MARGIN, viewportWidth - menuRect.width - MENU_MARGIN);
  const left = clamp(preferredLeft, MENU_MARGIN, maxLeft);

  const spaceBelow = viewportHeight - anchor.bottom;
  const spaceAbove = anchor.top;
  const openAbove = spaceBelow < menuRect.height + MENU_MARGIN && spaceAbove >= menuRect.height + MENU_MARGIN;

  let top = openAbove
    ? anchor.top - menuRect.height - MENU_MARGIN
    : anchor.bottom + MENU_MARGIN;

  const maxTop = Math.max(MENU_MARGIN, viewportHeight - menuRect.height - MENU_MARGIN);
  top = clamp(top, MENU_MARGIN, maxTop);

  menuElement.style.left = `${Math.round(left)}px`;
  menuElement.style.top = `${Math.round(top)}px`;
}

function measureMenu() {
  const wasHidden = menuElement.classList.contains("quo-hidden");
  const previousVisibility = menuElement.style.visibility;

  if (wasHidden) {
    menuElement.classList.remove("quo-hidden");
    menuElement.style.visibility = "hidden";
  }

  const rect = menuElement.getBoundingClientRect();

  if (wasHidden) {
    menuElement.classList.add("quo-hidden");
    menuElement.style.visibility = previousVisibility;
  }

  return {
    width: rect.width || 190,
    height: rect.height || 272
  };
}

async function assignSelection(field) {
  const selectedText = menuElement?.dataset.selectedText || latestSelectionText || "";

  if (!isExtensionContextValid()) {
    handleContextInvalidated();
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ASSIGN_SELECTION_TO_FIELD",
      field,
      selectedText
    });

    if (!response?.success) {
      throw new Error(response?.error || "Failed to capture selected text.");
    }

    suppressMenuUntilSelectionChanges = true;
    clearActiveSelection();
    hideMenu();
  } catch (error) {
    console.error("Quo CRM Lead Capture:", error);

    if (String(error?.message || "").includes("Extension context invalidated")) {
      handleContextInvalidated();
      return;
    }

    alert(error.message || "Failed to assign selected text.");
  }
}

function handleDismissMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  suppressMenuUntilSelectionChanges = true;
  clearActiveSelection();
  hideMenu();
}

function handleMenuMouseDown(event) {
  if (!event.target.closest("button")) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
}

async function handleMenuClick(event) {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (button.dataset.action === "close") {
    handleDismissMenu(event);
    return;
  }

  if (button.dataset.field) {
    await assignSelection(button.dataset.field);
  }
}

function hideMenu() {
  if (menuElement) {
    menuElement.classList.add("quo-hidden");
  }
}

function cacheSelectionState() {
  const inputSelection = getInputSelection();
  if (inputSelection) {
    suppressMenuUntilSelectionChanges = false;
    latestSelectionText = inputSelection.text;
    latestSelectionRect = inputSelection.rect;
    return;
  }

  const selectionDetails = getSelectionDetails();
  const selectedText = selectionDetails?.text || "";

  if (!selectionDetails || !selectedText) {
    latestSelectionText = "";
    latestSelectionRect = null;
    suppressMenuUntilSelectionChanges = false;
    return;
  }

  latestSelectionText = selectedText;
  latestSelectionRect = selectionDetails.rect;
  suppressMenuUntilSelectionChanges = false;
}

function getInputSelection() {
  const activeElement = getDeepActiveElement(document);
  if (!activeElement) {
    return null;
  }

  const isTextInput =
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLInputElement &&
      ["text", "search", "tel", "url", "email"].includes(activeElement.type));

  if (!isTextInput) {
    return null;
  }

  const start = activeElement.selectionStart;
  const end = activeElement.selectionEnd;
  if (typeof start !== "number" || typeof end !== "number" || start === end) {
    return null;
  }

  const text = activeElement.value.slice(start, end).trim();
  if (!text) {
    return null;
  }

  const rect = getSelectionRectFromTextControl(activeElement, start, end);
  if (!isUsableRect(rect)) {
    return null;
  }

  return {
    text,
    rect
  };
}

function getSelectionDetails() {
  const selection = getDeepSelection();
  const selectedText = selection ? selection.toString().trim() : "";

  if (!selection || !selectedText || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rect = getSelectionRectFromRange(range);
  if (!isUsableRect(rect)) {
    return null;
  }

  return {
    text: selectedText,
    rect
  };
}

function getSelectionRectFromRange(range) {
  const primaryRect = range.getBoundingClientRect();
  if (isUsableRect(primaryRect)) {
    return primaryRect;
  }

  const clientRects = Array.from(range.getClientRects() || []);
  return clientRects.find(isUsableRect) || null;
}

function getSelectionRectFromTextControl(element, start, end) {
  if (typeof element.getBoundingClientRect !== "function") {
    return null;
  }

  const baseRect = element.getBoundingClientRect();
  if (!isUsableRect(baseRect)) {
    return null;
  }

  const mirror = document.createElement("div");
  const computed = window.getComputedStyle(element);
  const propertiesToCopy = [
    "boxSizing",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "textAlign",
    "textTransform",
    "textIndent",
    "whiteSpace",
    "wordBreak",
    "overflowWrap"
  ];

  mirror.style.position = "fixed";
  mirror.style.left = `${Math.round(baseRect.left)}px`;
  mirror.style.top = `${Math.round(baseRect.top)}px`;
  mirror.style.width = `${Math.round(baseRect.width)}px`;
  mirror.style.height = `${Math.round(baseRect.height)}px`;
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.whiteSpace = element instanceof HTMLTextAreaElement ? "pre-wrap" : "pre";
  mirror.style.overflow = "hidden";

  propertiesToCopy.forEach((property) => {
    mirror.style[property] = computed[property];
  });

  const beforeText = document.createTextNode(element.value.slice(0, start));
  const selectionSpan = document.createElement("span");
  selectionSpan.textContent = element.value.slice(start, end) || " ";

  mirror.appendChild(beforeText);
  mirror.appendChild(selectionSpan);
  document.body.appendChild(mirror);

  const rect = selectionSpan.getBoundingClientRect();
  document.body.removeChild(mirror);

  return isUsableRect(rect) ? rect : baseRect;
}

function getDeepActiveElement(root) {
  let activeElement = root?.activeElement || null;
  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }
  return activeElement;
}

function getDeepSelection() {
  const activeElement = getDeepActiveElement(document);
  if (activeElement?.shadowRoot?.getSelection) {
    const shadowSelection = activeElement.shadowRoot.getSelection();
    if (shadowSelection && shadowSelection.toString().trim()) {
      return shadowSelection;
    }
  }

  return window.getSelection();
}

function isUsableRect(rect) {
  return !!rect && Number.isFinite(rect.top) && Number.isFinite(rect.left) &&
    Number.isFinite(rect.bottom) && Number.isFinite(rect.right) &&
    (rect.width > 0 || rect.height > 0);
}

function getMenuAnchor() {
  if (isUsableRect(latestSelectionRect)) {
    return rectToAnchor(latestSelectionRect);
  }

  if (latestPointerPosition) {
    const { clientX, clientY } = latestPointerPosition;
    return {
      top: clientY,
      bottom: clientY,
      left: clientX,
      right: clientX,
      centerX: clientX
    };
  }

  return null;
}

function rectToAnchor(rect) {
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    centerX: rect.left + rect.width / 2
  };
}

function refreshSelectionAnchor() {
  const inputSelection = getInputSelection();
  if (inputSelection && inputSelection.text === latestSelectionText) {
    latestSelectionRect = inputSelection.rect;
    return;
  }

  const selectionDetails = getSelectionDetails();
  if (selectionDetails && selectionDetails.text === latestSelectionText) {
    latestSelectionRect = selectionDetails.rect;
    return;
  }

  latestSelectionRect = null;
}

function handleViewportChange() {
  if (!menuElement || menuElement.classList.contains("quo-hidden")) {
    return;
  }

  refreshSelectionAnchor();
  const anchor = getMenuAnchor();
  if (!anchor) {
    hideMenu();
    return;
  }

  positionMenu(anchor);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clearActiveSelection() {
  const activeElement = document.activeElement;
  if (
    activeElement &&
    (activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLInputElement)
  ) {
    const end = activeElement.selectionEnd;
    if (typeof end === "number") {
      activeElement.setSelectionRange(end, end);
    }
  }

  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
  }

  latestSelectionText = "";
  latestSelectionRect = null;
}

async function notifyPageReady() {
  if (!isExtensionContextValid()) {
    handleContextInvalidated();
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      type: "PAGE_CONTEXT_READY",
      url: window.location.href
    });
  } catch (error) {
    console.warn("Quo CRM Lead Capture: could not initialize page context.", error);
    if (String(error?.message || "").includes("Extension context invalidated")) {
      handleContextInvalidated();
    }
  }
}

// Listen for messages from the sidepanel and background script
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "SCRAPE_CUSTOMER_NUMBER") {
      const number = scrapeCustomerNumber();
      sendResponse({ success: !!number, number });
    } else if (message?.type === "SCRAPE_CHAT_DIRECTION") {
      scrapeChatDirection().then(sendResponse);
      return true;
    } else if (message?.type === "SCRAPE_CHAT_DETAILS") {
      scrapeChatDetails().then(sendResponse);
      return true;
    } else if (message?.type === "SCRAPE_NUMBER_NAME") {
      const name = scrapeNumberName();
      sendResponse({ success: !!name, name });
    } else if (message?.type === "SCRAPE_CHAT_IMAGES") {
      const images = scrapeChatImages();
      sendResponse({ success: !!images, images });
    } else if (message?.type === "OPEN_ASSIGN_FIELD_MENU") {
      const response = openAssignFieldMenu(message.field);
      sendResponse(response);
    } else if (message?.type === "PREPARE_PHOTOS") {
      handlePreparePhotos(message.chatUrl, message.photoUrls).then(sendResponse);
      return true;
    } else if (message?.type === "NAVIGATE_AND_SEND_MESSAGE") {
      handleNavigateAndSendMessage(message.chatUrl, message.message, message.scheduleTime, message.navigationPrepared).then(result => {
        sendResponse(result || { success: true });
      });
      return true; // Keep message channel open for async response
    }
    return true; // Keep message channel open for async response
  });
}

function notifyConversationUrlChange() {
  if (window.location.href === lastNotifiedConversationUrl) return;
  lastNotifiedConversationUrl = window.location.href;

  if (!isExtensionContextValid()) return;
  chrome.runtime.sendMessage({
    type: "QUO_CHAT_CHANGED",
    url: window.location.href
  }).catch(() => {
    // The side panel may be closed; the current URL will still be synced when
    // it is opened later.
  });
}

async function scrapeChatDetails() {
  // Capture the currently rendered metadata before direction detection moves
  // the virtualized feed to its beginning and restores it.
  const number = scrapeCustomerNumber();
  const name = scrapeNumberName();
  const images = scrapeChatImages();
  const directionResult = await scrapeChatDirection();

  return {
    success: !!(number || name || directionResult?.direction || images.length),
    number: number || "",
    name: name || "",
    direction: directionResult?.direction || "",
    images,
    directionError: directionResult?.success ? "" : (directionResult?.error || "")
  };
}

/**
 * Determine who created the oldest contact activity in the active Quo
 * conversation. Calls and missed calls count because they often represent the
 * customer's first contact before either side sends a text message.
 *
 * Quo renders its feed with React Virtuoso, so a long conversation only keeps
 * the visible activities in the DOM. Move that scroller to its real beginning,
 * inspect the oldest activity, and then restore the user's previous position.
 */
async function scrapeChatDirection() {
  const feed = document.querySelector('[data-testid="feed"]');
  const scroller = feed?.querySelector('[data-testid="virtuoso-scroller"]');

  if (!feed || !scroller) {
    return {
      success: false,
      error: "Open a Quo conversation before using Auto direction."
    };
  }

  const originalDistanceFromBottom = Math.max(
    0,
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
  );

  try {
    // Repeatedly request the top. If Quo fetches an older page when the top is
    // reached, Virtuoso can move the scroll position to preserve its anchor;
    // another pass then continues toward the true first activity.
    let previousOldestIndex = null;
    let unchangedPasses = 0;
    let reachedOldestActivity = false;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      scroller.scrollTo({ top: 0, behavior: "auto" });
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForDirectionFrame(350);

      const oldestIndex = getOldestRenderedActivityIndex(feed);
      if (oldestIndex === 0 && scroller.scrollTop <= 2) {
        reachedOldestActivity = true;
        break;
      }

      if (oldestIndex !== null && oldestIndex === previousOldestIndex && scroller.scrollTop <= 2) {
        unchangedPasses += 1;
        if (unchangedPasses >= 2) break;
      } else {
        unchangedPasses = 0;
      }
      previousOldestIndex = oldestIndex;
    }

    if (!reachedOldestActivity) {
      return {
        success: false,
        error: "Quo did not load the beginning of this conversation. Choose the direction manually."
      };
    }

    const direction = directionFromOldestRenderedActivity(feed);
    if (!direction) {
      return {
        success: false,
        error: "The oldest loaded Quo activity did not expose enough sender information. Choose the direction manually."
      };
    }

    return { success: true, direction };
  } finally {
    // Preserve where the user was reading, including the common case where the
    // chat was at the bottom. Bottom distance remains stable if older pages were
    // prepended while detecting the first activity.
    await waitForDirectionFrame(50);
    const restoreTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight - originalDistanceFromBottom
    );
    scroller.scrollTo({ top: restoreTop, behavior: "auto" });
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
}

function getOldestRenderedActivityIndex(feed) {
  const indexes = Array.from(feed.querySelectorAll('[role="listitem"][data-index]'))
    .map((item) => Number(item.getAttribute("data-index")))
    .filter(Number.isFinite);

  return indexes.length ? Math.min(...indexes) : null;
}

function directionFromOldestRenderedActivity(feed) {
  const activities = Array.from(feed.querySelectorAll('[role="listitem"][data-index]'))
    .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));

  for (const activity of activities) {
    // Activity timestamps link to the same conversation with an `at` anchor.
    // Quo places incoming timestamps on the bubble's right (inline `left`) and
    // outgoing timestamps on its left (inline `right`). This avoids relying on
    // Quo's generated class names, which change between releases.
    const timestamps = activity.querySelectorAll('a[href*="?at="], a[href*="&at="]');
    for (const timestamp of timestamps) {
      if (timestamp.style.right) return "outgoing";
      if (timestamp.style.left) return "incoming";
    }
  }

  return null;
}

function waitForDirectionFrame(delay) {
  return new Promise((resolve) => window.setTimeout(resolve, delay));
}

function openAssignFieldMenu(field) {
  cacheSelectionState();

  if (!latestSelectionText) {
    return {
      success: false,
      error: "Select text in the quo.com chat first, then use Auto-pick."
    };
  }

  showMenuForSelection();

  if (!menuElement || menuElement.classList.contains("quo-hidden")) {
    return {
      success: false,
      error: "Could not open the Assign Field menu for the current selection."
    };
  }

  if (field) {
    menuElement.dataset.preferredField = field;
  }

  return { success: true };
}

function scrapeNumberName() {
  const activeLink = document.querySelector('[aria-current="page"], [aria-current="true"]');
  if (!activeLink) {
    return null;
  }

  // Scan all children nodes to find the name text
  const elements = activeLink.querySelectorAll('span, div');
  let potentialNames = [];

  for (const el of elements) {
    if (el.children.length === 0) {
      const text = el.textContent.trim();
      if (!text) continue;

      // Skip line phone numbers
      if (isPhoneNumber(text)) {
        continue;
      }

      // Skip emoji flag/icons (usually length <= 2)
      if (text.length <= 2) {
        continue;
      }

      potentialNames.push(text);
    }
  }

  // The name is usually the longest text
  if (potentialNames.length > 0) {
    potentialNames.sort((a, b) => b.length - a.length);
    return potentialNames[0];
  }

  return null;
}

function scrapeCustomerNumber() {
  // Scope search to the active chat header container
  let header = null;

  const quickActions = document.getElementById("message-quick-actions");
  if (quickActions) {
    header = quickActions.closest('div._160c0eh1') || quickActions.parentElement;
  }

  if (!header) {
    header = document.querySelector('div._160c0eh1.xw761z0.xw761z1') || 
             document.querySelector('div._10cjd4h0');
  }

  if (header) {
    // Strategy 1: Look for avatar label inside the header
    const avatarEl = header.querySelector('[aria-label*="\'s avatar"]');
    if (avatarEl) {
      const label = avatarEl.getAttribute('aria-label');
      const match = label.match(/^([+\d\s()\-]+)'s avatar/);
      if (match) {
        const potential = match[1].trim();
        if (isPhoneNumber(potential)) {
          return potential;
        }
      }
    }

    // Strategy 2: Scan elements inside the header for phone number pattern
    const phoneRegex = /^\+?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/;
    const allDivs = header.querySelectorAll('div, button, span');
    for (const el of allDivs) {
      if (el.children.length === 0 || (el.children.length === 1 && el.firstElementChild.tagName.toUpperCase() === 'SVG')) {
        const text = el.textContent.trim();
        if (phoneRegex.test(text)) {
          return text;
        }
      }
    }

    // Strategy 3: Broader search inside copy buttons inside header
    const copyButtons = header.querySelectorAll('button');
    for (const btn of copyButtons) {
      // Check the button's own text content first (handles direct text child nodes alongside SVG copy icons)
      const btnText = btn.textContent.trim();
      if (phoneRegex.test(btnText) || isPhoneNumber(btnText)) {
        return btnText;
      }
      const divs = btn.querySelectorAll('div');
      for (const div of divs) {
        const text = div.textContent.trim();
        if (phoneRegex.test(text)) {
          return text;
        }
      }
    }

    // Strategy 4: Fallback - broad scan of all potential text-containing elements inside the header
    const candidates = header.querySelectorAll('button, span, div, p, a');
    for (const candidate of candidates) {
      const text = candidate.textContent.trim();
      if (isPhoneNumber(text)) {
        return text;
      }
    }
  }

  return null;
}

function isPhoneNumber(str) {
  const cleaned = str.replace(/[()+\-\s]/g, '');
  return /^\d{7,15}$/.test(cleaned);
}

function scrapeChatImages() {
  const images = Array.from(document.querySelectorAll('img'));
  const chatImages = [];
  
  images.forEach(img => {
    // 1. Get raw image source from src or lazy-load attributes
    let imageUrl = img.src || "";
    const dataSrc = img.getAttribute('data-src') || 
                    img.getAttribute('data-original') || 
                    img.getAttribute('data-original-src') ||
                    img.getAttribute('data-url') ||
                    img.getAttribute('data-lazy') ||
                    img.getAttribute('srcset');
                    
    if (dataSrc) {
      const cleanSrc = dataSrc.trim().split(/[\s,]+/)[0];
      if (cleanSrc) imageUrl = cleanSrc;
    }
    
    if (!imageUrl) return;
    
    // Resolve relative URLs to absolute
    try {
      imageUrl = new URL(imageUrl, window.location.origin).href;
    } catch (e) {
      return;
    }

    // If the image is inside an <a> tag pointing to an image, check the href
    const parentLink = img.closest('a');
    if (parentLink && parentLink.href) {
      const href = parentLink.href.toLowerCase();
      if (
        href.endsWith('.jpg') || 
        href.endsWith('.jpeg') || 
        href.endsWith('.png') || 
        href.endsWith('.webp') || 
        href.endsWith('.gif') ||
        href.includes('/attachments/') ||
        href.includes('/media/') ||
        href.includes('/uploads/')
      ) {
        imageUrl = parentLink.href;
      }
    }

    // 2. Filter out explicit avatars/profile photos
    const classStr = (img.className || "").toLowerCase();
    const altStr = (img.alt || "").toLowerCase();
    const ariaLabel = (img.getAttribute('aria-label') || "").toLowerCase();
    const parentClass = img.parentElement ? (img.parentElement.className || "").toLowerCase() : "";
    
    if (
      classStr.includes('avatar') || 
      altStr.includes('avatar') || 
      ariaLabel.includes('avatar') ||
      parentClass.includes('avatar') ||
      classStr.includes('profile') ||
      altStr.includes('profile') ||
      parentClass.includes('profile')
    ) {
      return;
    }

    // 3. Filter out small icons/logos if they have explicitly measured small sizes
    const rect = img.getBoundingClientRect();
    const width = rect.width || img.clientWidth || img.naturalWidth || 0;
    const height = rect.height || img.clientHeight || img.naturalHeight || 0;
    
    // Skip if it's explicitly measured as very small (e.g. <= 32px)
    if ((width > 0 && width <= 32) || (height > 0 && height <= 32)) {
      return;
    }
    
    // Skip typical tracking pixels / spacer images (1x1)
    if (width === 1 && height === 1) {
      return;
    }

    // Skip SVG data URLs
    if (imageUrl.startsWith('data:image/svg+xml')) {
      return;
    }
    
    // Avoid duplicates
    if (!chatImages.includes(imageUrl)) {
      chatImages.push(imageUrl);
    }
  });
  
  return chatImages;
}

function safePathname(url) {
  try { return new URL(url, window.location.origin).pathname; } catch (e) { return url; }
}

// Quo/OpenPhone uses a Slate.js composer. Try the specific labels first, then
// progressively more generic selectors, so a small UI/label change doesn't
// break sending outright.
const COMPOSER_SELECTORS = [
  'div[role="textbox"][aria-label="message input"]',
  'div[role="textbox"][aria-label*="message" i]',
  '[contenteditable="true"][aria-label*="message" i]',
  '[contenteditable="true"][aria-multiline="true"]',
  '[data-slate-editor="true"]',
  '[data-lexical-editor="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[aria-label*="message input" i]',
  'textarea[aria-label*="message" i]',
  'textarea[placeholder*="message" i]',
  'div[contenteditable="true"]',
];
const SEND_SELECTORS = [
  'button[aria-label="Send message"]:not([aria-disabled="true"]):not([disabled])',
  'button[aria-label*="send" i]:not([aria-disabled="true"]):not([disabled])',
];

function queryAny(selectors) {
  for (const s of selectors) {
    try { const el = document.querySelector(s); if (el) return el; } catch (e) { /* ignore */ }
  }
  return null;
}

function isVisibleElement(element) {
  if (!element || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findComposer() {
  for (const selector of COMPOSER_SELECTORS) {
    try {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
      if (candidates.length) return candidates[candidates.length - 1];
    } catch (e) { /* ignore */ }
  }
  return null;
}

function waitForAny(selectors, timeout = 8000) {
  return new Promise((resolve) => {
    const isComposerQuery = selectors === COMPOSER_SELECTORS;
    const findMatch = () => isComposerQuery ? findComposer() : queryAny(selectors);
    const found = findMatch();
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const el = findMatch();
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}

function getConversationId(url) {
  try { const m = String(url).match(/\/c\/([^/?#]+)/); return m ? m[1] : null; } catch (e) { return null; }
}

function phoneFromChatUrl(url) {
  try { return (new URL(url).searchParams.get("phone") || "").replace(/\D/g, "").slice(-10); }
  catch (e) { return ""; }
}

function setNativeInputValue(input, value) {
  const prototype = input instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new InputEvent("input", { data: value, inputType: "insertText", bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findConversationForPhone(phone) {
  const last10 = String(phone || "").replace(/\D/g, "").slice(-10);
  if (!last10) return null;

  const selectors = [
    'a[href*="/c/"]',
    '[role="option"]',
    '[role="listitem"]',
    '[role="row"]',
    '[data-testid*="conversation" i]',
    '[data-testid*="contact" i]',
    'button'
  ];
  const matches = [];
  const seen = new Set();

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const clickable = element.matches('a,button,[role="option"],[role="listitem"],[role="row"],[role="button"],[role="link"]')
        ? element
        : element.closest('a,button,[role="option"],[role="listitem"],[role="row"],[role="button"],[role="link"]');
      if (!clickable || seen.has(clickable) || !isVisibleElement(clickable)) continue;
      seen.add(clickable);

      const searchable = [
        clickable.textContent,
        clickable.getAttribute("aria-label"),
        clickable.getAttribute("title"),
        clickable.getAttribute("data-phone-number"),
        clickable.getAttribute("href")
      ].filter(Boolean).join(" ").replace(/\D/g, "");
      if (!searchable.includes(last10)) continue;

      const href = clickable.getAttribute("href") || "";
      const role = clickable.getAttribute("role") || "";
      const score =
        (href.includes("/c/") ? 1000 : 0) +
        (["option", "listitem", "row"].includes(role) ? 500 : 0) +
        (clickable.hasAttribute("data-testid") ? 250 : 0) -
        (clickable.tagName === "BUTTON" ? 200 : 0);
      matches.push({ clickable, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches[0]?.clickable || null;
}

async function waitForConversationForPhone(phone, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = findConversationForPhone(phone);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function openConversationForPhone(phone) {
  let conversation = await waitForConversationForPhone(phone, 3500);
  if (!conversation) {
    let search = Array.from(document.querySelectorAll(
      'input[placeholder*="search" i], input[aria-label*="search" i], [role="searchbox"]'
    )).find(isVisibleElement);

    if (!search) {
      const searchButton = Array.from(document.querySelectorAll(
        'button[aria-label*="search" i], button[title*="search" i], [role="button"][aria-label*="search" i]'
      )).find(isVisibleElement);
      if (searchButton) {
        searchButton.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        search = Array.from(document.querySelectorAll(
          'input[placeholder*="search" i], input[aria-label*="search" i], [role="searchbox"]'
        )).find(isVisibleElement);
      }
    }

    if (search instanceof HTMLInputElement || search instanceof HTMLTextAreaElement) {
      search.focus();
      setNativeInputValue(search, phone);
      conversation = await waitForConversationForPhone(phone, 5000);
    }
  }

  if (!conversation) return false;
  const initialConversationId = getConversationId(window.location.href);
  const linkedConversationId = getConversationId(conversation.getAttribute("href") || "");
  conversation.scrollIntoView({ block: "center", inline: "nearest" });
  conversation.click();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const currentConversationId = getConversationId(window.location.href);
    if (linkedConversationId && currentConversationId === linkedConversationId && findComposer()) return true;
    if (!linkedConversationId && currentConversationId && currentConversationId !== initialConversationId && findComposer()) return true;
    if (!initialConversationId && !linkedConversationId && findComposer()) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

// Switch the Quo SPA to a chat URL without a full reload. Prefer the app's own
// in-page link (a guaranteed router transition that also loads the conversation
// data); otherwise drive the History API. Returns which method it used, and
// logs it so we can see whether the chat link is actually being opened.
function spaNavigate(chatUrl) {
  try {
    const path = safePathname(chatUrl);
    const convId = getConversationId(chatUrl);
    let link = document.querySelector(`a[href="${chatUrl}"]`) || document.querySelector(`a[href="${path}"]`);
    if (!link && convId) link = document.querySelector(`a[href*="${convId}"]`);
    if (link) {
      console.log("[Donut] opening chat via in-page link:", link.getAttribute("href"));
      link.click();
      return "link";
    }
    console.log("[Donut] no in-page link found for chat; using History API. convId:", convId);
  } catch (e) { /* ignore */ }
  try {
    window.history.pushState({}, "", chatUrl);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    window.dispatchEvent(new CustomEvent("pushstate"));
    console.log("[Donut] navigated via pushState to:", chatUrl);
    return "pushstate";
  } catch (e) {
    console.warn("[Donut] pushState navigation failed:", e && e.message);
    return "failed";
  }
}

// Put text into a Slate.js composer. Slate only registers input it receives
// through its own handlers, so a real paste (with a DataTransfer) goes through
// Slate's insertData path and updates its model — which is what enables the Send
// button. Direct DOM writes / execCommand put text in the DOM but Slate ignores
// them, so Send stays disabled. Whether it truly worked is judged by the caller
// watching the Send button, not by DOM text.
async function handlePreparePhotos(chatUrl, photoUrls) {
  try {
    const onTarget = () => window.top === window && new URL(window.location.href).pathname === new URL(chatUrl).pathname;
    if (!onTarget()) return { success: false, retryable: true, error: "The technician conversation is still loading." };
    const editor = await waitForAny(COMPOSER_SELECTORS, 3000);
    if (!editor) return { success: false, retryable: true, error: "The technician composer is still loading." };
    // Fetch the full batch before touching the composer. Never replace its text draft.
    const transfer = new DataTransfer();
    let totalBytes = 0;
    const signal = AbortSignal.timeout(30000);
    for (let i = 0; i < photoUrls.length; i++) {
      const response = await fetch(photoUrls[i], { signal });
      if (!response.ok) throw new Error(`Photo ${i + 1} download failed (${response.status}).`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error(`Photo ${i + 1} is not an image.`);
      totalBytes += blob.size;
      if (totalBytes > 30 * 1024 * 1024) throw new Error("Photos exceed 30 MB. Use Copy all photos to send a combined image instead.");
      const extension = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1].replace(/[^a-z0-9]/gi, "");
      transfer.items.add(new File([blob], `lead-photo-${i + 1}.${extension}`, { type: blob.type }));
    }
    if (!onTarget() || editor !== findComposer()) throw new Error("The chat changed while photos were downloading. Nothing was attached.");
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(input =>
      !input.disabled && (input.multiple || photoUrls.length === 1) &&
      (!input.accept || /image|\.png|\.jpg|\.jpeg/i.test(input.accept)));
    if (inputs.length !== 1) throw new Error("Could not identify Quo's photo attachment input. Use Copy all photos and paste into this chat.");
    const input = inputs[0];
    if (input.files?.length) throw new Error("Quo already has selected attachments. Send or clear them before adding this batch.");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // This is a handoff, not delivery: Quo owns upload limits and its Send button.
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || "Could not prepare photos in Quo." };
  }
}

function composerText(editor) {
  return (editor?.value || editor?.textContent || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findEnabledSendButton(editor) {
  const labelled = queryAny(SEND_SELECTORS);
  if (labelled) return labelled;
  const form = editor?.closest?.("form");
  return form?.querySelector?.('button[type="submit"]:not([aria-disabled="true"]):not([disabled])') || null;
}

async function insertIntoComposer(editor, message) {
  const expected = String(message || "").replace(/\s+/g, " ").trim();
  const containsMessage = () => expected && composerText(editor).includes(expected);

  // Real focus + selection, like a user click.
  try {
    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    editor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    editor.click();
  } catch (e) { /* ignore */ }
  editor.focus();

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(editor, message);
    else editor.value = message;
    editor.dispatchEvent(new InputEvent("input", {
      data: message,
      inputType: "insertText",
      bubbles: true
    }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return containsMessage();
  }

  // Select any existing draft so the paste replaces it.
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { /* ignore */ }

  // Primary: paste through Slate's insertData handler.
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", message);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  } catch (e) { /* ignore */ }

  await new Promise((resolve) => setTimeout(resolve, 120));
  if (containsMessage()) return true;

  // Some Quo releases reject synthetic ClipboardEvents. Keep two user-input
  // style fallbacks, but verify the exact message appears before continuing.
  try { document.execCommand("insertText", false, message); } catch (e) { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (containsMessage()) return true;

  try {
    editor.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText",
      data: message,
      bubbles: true,
      cancelable: true
    }));
  } catch (e) { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 80));
  return containsMessage();
}

async function waitForComposerClear(editor, waitMs) {
  if (!composerText(editor)) return false;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const box = findComposer();
    if (!composerText(box)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function handleNavigateAndSendMessage(chatUrl, message, scheduleTime, navigationPrepared = false) {
  try {
    console.log("[Donut] send requested. target:", chatUrl, "| current:", window.location.href);
    // 1. FAST PATH: switch chats via the SPA router, no full page reload.
    const convId = getConversationId(chatUrl);
    const targetPhone = phoneFromChatUrl(chatUrl);
    const isTopFrame = window.top === window;
    const onTarget = () => (convId ? getConversationId(window.location.href) === convId : window.location.pathname === safePathname(chatUrl));

    if (isTopFrame && !navigationPrepared && !onTarget()) {
      const method1 = spaNavigate(chatUrl);
      await waitForAny(COMPOSER_SELECTORS, 3000);
      if (!onTarget()) {
        const method2 = spaNavigate(chatUrl);
        await waitForAny(COMPOSER_SELECTORS, 4000);
        console.log("[Donut] nav retry method:", method2);
      }
      // Brief settle so the new conversation's composer attaches its handlers.
      await new Promise(r => setTimeout(r, 250));
      console.log("[Donut] after nav. url:", window.location.href, "| onTarget:", onTarget(), "| method:", method1);
    }

    if (isTopFrame && convId && !onTarget()) {
      return { success: false, retryable: true, error: "The requested Quo conversation did not finish loading." };
    }

    if (isTopFrame && !convId && targetPhone) {
      console.log("[Donut] selecting customer conversation by phone:", targetPhone);
      if (!await openConversationForPhone(targetPhone)) {
        return {
          success: false,
          error: `Could not find the customer conversation for ${targetPhone} in this Quo inbox.`
        };
      }
    }

    // 2. Wait for the editor to appear
    const editor = await waitForAny(COMPOSER_SELECTORS, 3000);
    if (!editor) {
      console.error("Quo CRM Extension: Could not find message input editor.");
      return { success: false, retryable: true, error: "Could not find message input editor on page." };
    }

    // 3. Insert the message into the Slate composer. Success is judged by the
    // Send button enabling (Slate registered the text), not by DOM text.
    const insertOk = await insertIntoComposer(editor, message);
    if (!insertOk) {
      console.error("Quo CRM Extension: Message text did not register in the composer.");
      return { success: false, error: "Could not type the message into the Quo composer." };
    }
    console.log("[Donut] message inserted; waiting for Send to enable…");

    if (scheduleTime) {
      console.log("Quo CRM: Attempting to schedule message...");
      // 5a. Wait and poll for the Schedule button to become enabled
      let scheduleBtn;
      for (let i = 0; i < 40; i++) {
        scheduleBtn = document.querySelector('button[aria-label="Schedule message"]:not([aria-disabled="true"])');
        if (scheduleBtn) break;
        await new Promise(r => setTimeout(r, 50));
      }

      if (!scheduleBtn) {
        console.error("Quo CRM: Schedule button not found or is disabled.");
        return { success: false, error: "Schedule button never became enabled after pasting the message." };
      }
      scheduleBtn.click();
      console.log("Quo CRM: Clicked schedule button.");

      // Wait for the modal input
      const modalInput = await waitForElement('input[placeholder*="Try: 5pm"]', 5000);
      if (!modalInput) {
        console.error("Quo CRM: Schedule modal input not found.");
        return { success: false, error: "Schedule modal did not appear." };
      }
      console.log("Quo CRM: Found modal input.");

      // Type the schedule time using React native setter hack
      modalInput.focus();
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeInputValueSetter.call(modalInput, scheduleTime);
      modalInput.dispatchEvent(new Event('input', { bubbles: true }));
      console.log("Quo CRM: Typed schedule time: " + scheduleTime);
      
      // Wait for dropdown options to populate natively instead of a fixed 1.5s delay
      const firstOption = await waitForElement('ul[aria-label="Suggested datetimes"] li[role="option"]', 3000);
      if (firstOption) {
        firstOption.click();
        console.log("Quo CRM: Clicked schedule option.");
        
        // Wait a moment to let the UI react to the dropdown selection
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Check if there is a final "Schedule" or "Confirm" button in the modal
        // Usually, primary buttons in these modals have specific attributes.
        // We'll look for a button containing "Schedule" text or aria-label that isn't the original one we clicked.
        const possibleConfirmBtns = Array.from(document.querySelectorAll('button:not([aria-disabled="true"])'))
            .filter(b => b.textContent.includes('Schedule') || b.textContent.includes('Confirm'));
        
        // The last one is usually the modal's action button
        if (possibleConfirmBtns.length > 0) {
            const confirmBtn = possibleConfirmBtns[possibleConfirmBtns.length - 1];
            confirmBtn.click();
            console.log("Quo CRM: Clicked final schedule/confirm button.");
        }
        
        if (await waitForComposerClear(editor, 4000)) return { success: true };
        return { success: false, error: "The schedule action did not clear the composer, so it could not be verified." };
      } else {
        console.error("Quo CRM: No scheduling option found in dropdown.");
        return { success: false, error: "Could not find a scheduling option in the dropdown." };
      }
    } else {
      // The message is really sent only when the composer empties itself. We use
      // that as the source of truth, so we never report a fake success.
      // 5b. Wait and poll for the normal Send button to become enabled (up to ~2.5s).
      let sendButton;
      for (let i = 0; i < 50; i++) {
        sendButton = findEnabledSendButton(editor);
        if (sendButton) break;
        await new Promise(r => setTimeout(r, 50));
      }

      if (sendButton) {
        console.log("[Donut] clicking Send button.");
        sendButton.click();
        if (await waitForComposerClear(editor, 2500)) return { success: true };
        console.warn("[Donut] Send clicked but composer never cleared — message may not have sent.");
        return { success: false, error: "Clicked Send but the message did not go out (composer never cleared)." };
      }

      // Fallback: in the Quo composer, Enter (without Shift) sends the message.
      console.log("[Donut] Send button disabled/not found; trying Enter key.");
      editor.focus();
      ["keydown", "keypress", "keyup"].forEach((type) => {
        editor.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      });
      if (await waitForComposerClear(editor, 2000)) return { success: true };
      console.warn("Quo CRM Extension: Send button not found or is disabled.");
      return { success: false, error: "Send button never became enabled after typing the message." };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Helper to wait for element
function waitForElement(selector, timeout = 10000) {
  return new Promise(resolve => {
    if (document.querySelector(selector)) {
      return resolve(document.querySelector(selector));
    }

    const observer = new MutationObserver(mutations => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve(document.querySelector(selector));
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}
