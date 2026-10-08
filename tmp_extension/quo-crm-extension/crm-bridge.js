// crm-bridge.js
// Injected into the CRM to bridge window.postMessage to chrome.runtime.sendMessage

window.addEventListener("message", (event) => {
  // Only accept messages from the same window
  if (event.source !== window) return;

  const data = event.data;
  if (data?.action === "QUO_PREPARE_CHAT" && data.chatUrl) {
    chrome.runtime.sendMessage({
      type: "QUO_PREPARE_CHAT",
      chatUrl: data.chatUrl
    }).catch(() => {
      // Preparation is optional; the normal Send path remains the fallback.
    });
    return;
  }

  if (data?.action === "QUO_SEND_ATTACHMENTS" && Array.isArray(data.imageUrls)) {
    console.log("Quo CRM Extension: Received QUO_SEND_ATTACHMENTS from CRM page", {
      chatUrl: data.chatUrl,
      count: data.imageUrls.length
    });

    chrome.runtime.sendMessage({
      type: "QUO_SEND_ATTACHMENTS",
      chatUrl: data.chatUrl,
      imageUrls: data.imageUrls,
      recipientType: data.recipientType,
      technicianPhone: data.technicianPhone
    }, (response) => {
      window.postMessage({
        action: "QUO_SEND_ATTACHMENTS_RESPONSE",
        success: response && response.success,
        sent: response && response.sent,
        error: (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message)
      }, "*");
    });
    return;
  }

  if (data && (data.action === "QUO_SEND_MESSAGE" || data.action === "QUO_SCHEDULE_MESSAGE")) {
    console.log(`Quo CRM Extension: Received ${data.action} from CRM page`, data);
    
    // Add confirmation if it's a schedule request
    if (data.action === "QUO_SCHEDULE_MESSAGE") {
      const scheduleTime = data.scheduleTime || "later";
      const confirmed = window.confirm(`Are you sure you want to schedule this message for ${scheduleTime}?`);
      if (!confirmed) {
        window.postMessage({
          action: "QUO_SEND_MESSAGE_RESPONSE",
          success: false,
          error: "User cancelled the scheduling confirmation."
        }, "*");
        return;
      }
    }
    
    // Forward to the extension background
    chrome.runtime.sendMessage({
      type: "QUO_SEND_MESSAGE", // Re-using the same background message type
      chatUrl: data.chatUrl,
      message: data.message,
      scheduleTime: data.scheduleTime // Optional
    }, (response) => {
      // Send a response back to the page if needed
      window.postMessage({
        action: "QUO_SEND_MESSAGE_RESPONSE",
        success: response && response.success,
        error: response && response.error
      }, "*");
    });
  }
});
