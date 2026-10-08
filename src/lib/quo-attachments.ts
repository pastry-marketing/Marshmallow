// Bulk-photo sending for Quo (quo.com, formerly OpenPhone).
//
// Why this exists: each lead can carry 10+ job photos, and the only way to get
// them into a Quo chat used to be copying one image to the OS clipboard and
// pasting it into the composer — once per photo. The OS clipboard holds a single
// image, so "copy all / paste once" is impossible through the clipboard.
//
// Instead we hand the photos to the Donut browser extension, which already drives
// the Quo composer (see tmp_extension/quo-crm-extension). The extension fetches
// the signed URLs, builds a DataTransfer of image Files, and drops them into
// Quo's attachment input in one shot. This module is only the CRM -> extension
// transport (window.postMessage, mirroring sendQuoMessageViaExtension in
// quo-dashboard.ts); all DOM work happens inside the extension.

// Quo's documented per-message limits (support.quo.com -> Messaging overview):
//   "Up to 10 images" and a 5MB maximum per message.
export const QUO_MAX_IMAGES_PER_MESSAGE = 10;
export const QUO_MAX_BYTES_PER_MESSAGE = 5 * 1024 * 1024;

export interface QuoAttachmentsResponse {
  success: boolean;
  error?: string;
  /** How many images the extension actually attached + sent. */
  sent?: number;
}

/**
 * Whether a URL belongs to Quo. Recipient resolution is handled separately:
 * job photos must use the technician conversation, never lead.source_url.
 */
export function isQuoChatUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "quo.com" ||
      host.endsWith(".quo.com") ||
      host === "openphone.com" ||
      host.endsWith(".openphone.com")
    );
  } catch {
    return false;
  }
}

/**
 * Split an ordered list of {url,size} into messages that each stay within Quo's
 * 10-image / 5MB limits, preserving photo order. Exported for testing.
 */
export function batchForQuo<T extends { size?: number }>(
  items: T[],
  maxCount = QUO_MAX_IMAGES_PER_MESSAGE,
  maxBytes = QUO_MAX_BYTES_PER_MESSAGE,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const size = Math.max(0, item.size ?? 0);
    const wouldExceedCount = current.length >= maxCount;
    const wouldExceedBytes = current.length > 0 && currentBytes + size > maxBytes;
    if (wouldExceedCount || wouldExceedBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Ask the Donut extension to attach + send images into a resolved technician chat.
 * Resolves when the extension reports back, or after `timeoutMs` if the
 * extension never answers (not installed / CRM page needs a refresh).
 *
 * `imageUrls` must be fully-resolved, fetchable signed URLs in the order the
 * photos should appear. Downloading and injecting several images takes longer
 * than a text send, so the default timeout is generous.
 */
export function sendQuoAttachmentsViaExtension(
  chatUrl: string,
  imageUrls: string[],
  technicianPhone: string,
  timeoutMs = 90000,
): Promise<QuoAttachmentsResponse> {
  return new Promise((resolve) => {
    if (!isQuoChatUrl(chatUrl) || !/\/c\/[^/]+\/?$/.test(new URL(chatUrl).pathname) || !/^\+\d{8,15}$/.test(technicianPhone)) {
      resolve({ success: false, error: "Select a technician with a linked Quo conversation." });
      return;
    }
    if (!imageUrls || imageUrls.length === 0) {
      resolve({ success: false, error: "No photos selected to send." });
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;

    function handleResponse(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.data && event.data.action === "QUO_SEND_ATTACHMENTS_RESPONSE") {
        window.removeEventListener("message", handleResponse);
        if (timer) clearTimeout(timer);
        resolve({
          success: !!event.data.success,
          error: event.data.error,
          sent: typeof event.data.sent === "number" ? event.data.sent : undefined,
        });
      }
    }

    window.addEventListener("message", handleResponse);

    timer = setTimeout(() => {
      window.removeEventListener("message", handleResponse);
      resolve({
        success: false,
        error:
          "Extension not detected. If you just installed it, please refresh this CRM page once.",
      });
    }, timeoutMs);

    try {
      window.postMessage(
        {
          action: "QUO_SEND_ATTACHMENTS",
          chatUrl,
          imageUrls,
          recipientType: "tech",
          technicianPhone,
        },
        "*",
      );
    } catch (err) {
      window.removeEventListener("message", handleResponse);
      if (timer) clearTimeout(timer);
      resolve({
        success: false,
        error: err instanceof Error ? err.message : "Failed to dispatch message to the extension.",
      });
    }
  });
}
