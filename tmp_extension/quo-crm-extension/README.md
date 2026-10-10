# Quo CRM Lead Capture Extension

This repository contains a Chrome Extension Manifest V3 implementation for capturing explicitly selected text from `quo.com` chats and creating CRM leads without leaving the current page.

## What the extension does

- Runs only on `quo.com` pages through a content script.
- Detects highlighted text with `window.getSelection()`.
- Shows a floating action menu near the selection.
- Lets you assign selected text to lead fields one field at a time.
- Opens a Chrome side panel with an editable lead form.
- Stores draft form data locally so panel state survives closing and reopening.
- Sends the final lead to your CRM only when you click `Create Lead`.
- Checks active CRM leads by customer phone and can replace the selected lead’s schedule requirement without creating a duplicate.

## Files

- `manifest.json`
- `background.js`
- `content.js`
- `crm-bridge.js` (relays `window.postMessage` from the CRM to the background worker)
- `sidepanel.html`
- `sidepanel.js`
- `sidepanel.css`
- `options.html`
- `options.js`
- `options.css`

## Install in Chrome developer mode

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository folder: `C:\Users\Dell\Documents\auto lead adder crm`.
5. Confirm the extension appears in the extensions list.

## Configure CRM API URL and token

1. Open the extension details page in `chrome://extensions`.
2. Open the extension `Options` page.
3. Set:
   - `CRM API Base URL`, for example `https://your-crm-domain.com`
   - `API Token`, your bearer token for the CRM backend
4. Click `Save Settings`.

The extension posts leads to:

`POST {CRM_API_BASE_URL}/api/extension/leads`

## Required CRM endpoint

Your CRM must expose this authenticated endpoint:

`POST /api/extension/leads`

Required headers:

```http
Content-Type: application/json
Authorization: Bearer YOUR_API_TOKEN
```

Expected request body:

```json
{
  "customerName": "Jane Doe",
  "customerNumber": "+1 555 0100",
  "customerAddress": "123 Main St",
  "numberName": "Home",
  "service": "AC repair",
  "referenceName": "Google Ads - Summer Campaign",
  "direction": "incoming",
  "scheduleRequirement": "Tomorrow morning",
  "source": "quo.com",
  "sourceUrl": "https://quo.com/messages/123",
  "capturedAt": "2026-06-24T14:30:00.000Z",
  "createdByExtension": true
}
```

Expected success response:

```json
{
  "success": true,
  "leadId": "lead_123",
  "leadUrl": "https://your-crm-domain.com/leads/lead_123"
}
```

Expected error response example:

```json
{
  "success": false,
  "error": "Invalid token."
}
```

## How to use on quo.com

1. Open a `quo.com` chat page.
2. Highlight only the text you want to capture.
3. Click a floating action button such as `Customer Name` or `Service`.
4. Review and edit the draft in the side panel.
5. Set `direction` to `incoming` or `outgoing`.
6. Click `Create Lead`.

To update an existing lead’s schedule requirement, click `Check Lead`, select the correct matching lead, enter the new Schedule Requirement, and click `Update Schedule Requirement`. The update replaces the previous schedule value and clears the full form after success.

Validation rule:

- At least `customerName` or `customerNumber` must be present before submission.

Important behavior:

- The extension never sends the full chat automatically.
- Only text you explicitly select and assign is added to the draft.

## Bulk photo copy (CRM clipboard)

Lead cards provide one **Copy all N photos** action. It copies the selected lead's
photos as one numbered combined image in one click so the user can paste them into
the intended Quo conversation. Chrome cannot write multiple image clipboard items.

With Donut **1.4.0 and later**, **Send photos to tech** hands all original photos to the
assigned technician's exact conversation on the technician communications line.
It requires the existing Tech Quick Chat permission and technician-detail access.
Review the attachments in Quo, then click **Send** to deliver them. A handoff is
not a delivery confirmation. Existing text drafts are preserved. If Quo's file
input cannot be identified, the batch fails visibly; use combined-image copy.
Reload the extension and refresh both CRM and Quo tabs after upgrading.

Sending a text message remains a separate, user-composed action.

## Technician Intelligence and shared lead review

Admin and Processor users have a native **Technician Intelligence** panel: find
the technician matching the captured phone, confirm the exact record, review chat
evidence and job history, and save reviewed labels. It calls the same authenticated
`technician-chat-assessment` Edge Function as the CRM. **Open full Processing
Workflow** provides map selection, batches up to 8, flag approval and next actions.
CS/OPR roles cannot call this API. AI advice never automatically changes flags.

Find Address, coverage preview and intake coordinates now use the CRM's
`geocode-lead-address` endpoint, including its free Census fallback and unit
preservation. Urgent intake displays corrections and missing-detail flags as well
as contradictions. The saved-lead review remains the authority for applying fixes
and approval. If a lead saved but draft cleanup failed, the panel says so explicitly.
Unknown save outcomes retain the job ID until the draft is cleared.

See `docs/CRM_EXTENSION_PARITY.md` in the CRM repository for API-key setup and the
mandatory parity verification/release checklist.

## Manual ZIP release and update notices

Donut is installed with Chrome's **Load unpacked**, not through the Chrome Web Store.
The side panel and Settings show the actual installed manifest version and the release
date/time in the user's local timezone. Both check the configured CRM's
`/extension-release.json` while open and show a ZIP update notice for newer versions.
The CRM header's **Donut** button shows the latest release, installed version (when
detectable), release date/time, download, and manual-update instructions. CRM users
receive an automatic in-app notice once per release per user/browser. Older releases
that lack the version handshake are shown as **Not detected**, never as up to date.

To update, extract the new ZIP and replace the contents of the existing unpacked
`quo-crm-extension` folder, keeping the same path. Open `chrome://extensions`, enable
Developer mode, click **Reload** on Donut, and refresh CRM and Quo tabs. If you use a
new folder instead, use **Load unpacked** and remove the old duplicate extension.

For every extension change, from the repository root run:

```sh
npm run extension:release -- 1.6.0 "Describe this release"
```

Use a version higher than the last release. This automatically updates the manifest,
UTC release timestamp, bundled metadata, public release metadata and `public/Donut.zip`.
Commit those generated files with the extension changes. Publishing the CRM makes
the release discoverable and automatically triggers notices; generating a ZIP locally
does not notify production users. `npm run extension:check` (also run before builds)
rejects stale source/metadata/ZIP combinations. It does not auto-install ZIP updates.

## Example API test with cURL

```bash
curl -X POST "https://your-crm-domain.com/api/extension/leads" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -d '{
    "customerName": "Jane Doe",
    "customerNumber": "+1 555 0100",
    "customerAddress": "123 Main St",
    "numberName": "Home",
    "service": "AC repair",
    "direction": "incoming",
    "scheduleRequirement": "Tomorrow morning",
    "source": "quo.com",
    "sourceUrl": "https://quo.com/messages/123",
    "capturedAt": "2026-06-24T14:30:00.000Z",
    "createdByExtension": true
  }'
```

## Backend note

This repository currently does not expose an existing backend application structure or committed server code to inspect. Because of that, no CRM API route was added here. The extension is implemented and ready to call an existing backend once that route is available in your CRM stack.
