/**
 * Marshmallow CRM -> Google Sheets mirror.
 *
 * PASTE THIS WHOLE FILE into Extensions > Apps Script, replacing what is
 * there, then Deploy > New deployment > Web app (Execute as: Me, Access:
 * Anyone). The URL does not change if you reuse the same deployment type.
 *
 * ------------------------------------------------------------------
 * WHAT CHANGED AND WHY
 * ------------------------------------------------------------------
 *
 * 1. ROW INDEX (the important one)
 *    The old upsert read the entire sheet and looped to find the row, then
 *    handleUpsert called that three times per lead: All Leads, the status
 *    sheet, and Tagged Leads. At ~4,000 rows that is roughly 12,000 cell
 *    reads for a single edit, and it gets slower as the sheet grows.
 *
 *    Now the first column is read ONCE per sheet per batch and turned into a
 *    lookup map. Every upsert after that is O(1). New rows and deletions
 *    adjust the map instead of forcing another read.
 *
 * 2. NEW "sync_mirror" ACTION
 *    The old "sync_batch" APPENDS rows. That is correct for the one-time
 *    full sync that starts with clear_all, but appending on every change
 *    would create duplicates. sync_mirror performs batched UPSERTS, which is
 *    what a continuously updated mirror needs.
 *
 *    It also accepts deletes in the same call, so a batch is one execution
 *    rather than many.
 *
 * 3. QUOTA
 *    Every action counts as one Apps Script execution, and consumer accounts
 *    allow 500 per day. Syncing one lead per edit needs roughly 600-700
 *    executions a day at current volume, which overruns that. Batching many
 *    leads into one call is the fix: the database outbox coalesces changes and
 *    sends one mirror call instead of one per edit.
 *
 * 4. VERIFIABLE RESULTS
 *    Every action now returns counts. Previously a 200 response was treated
 *    as proof the write happened, so a script that did nothing looked
 *    identical to a successful sync. The server worker compares processedOps
 *    against the batch it sent and retries a mismatch as a failure.
 *
 * All previous actions still work: ping, clear_all, sync_batch, sync_all,
 * upsert, delete. Nothing existing breaks.
 */

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

var ALL_LEADS = "All Leads";
var TAGGED_LEADS = "Tagged Leads";
var MAX_LOCK_WAIT_MS = 25000;
var SCRIPT_VERSION = "2.0.0";


// =============================================================================
// ENTRY POINTS
// =============================================================================

function doGet(e) {
  return jsonResponse({
    success: true,
    version: SCRIPT_VERSION,
    capabilities: ["ping", "sync_mirror", "clear_all"],
    message: "Marshmallow Sheets mirror is live.",
    hint: "POST JSON with an action of ping, sync_mirror, upsert, delete, sync_batch, sync_all or clear_all."
  });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var hasLock = lock.tryLock(MAX_LOCK_WAIT_MS);
  if (!hasLock) {
    // Reported as a real failure so the client queues the work and retries
    // rather than assuming the write landed.
    return jsonResponse({
      success: false,
      error: "Server busy, another sync is still running. Retry shortly.",
      code: "LOCK_TIMEOUT"
    });
  }

  try {
    var rawData = e.postData ? e.postData.contents : null;
    if (!rawData) {
      return jsonResponse({ success: false, error: "Empty request body", code: "EMPTY_BODY" });
    }

    var payload;
    try {
      payload = JSON.parse(rawData);
    } catch (parseErr) {
      return jsonResponse({ success: false, error: "Body was not valid JSON", code: "BAD_JSON" });
    }

    var action = payload.action || "sync_all";
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var startedAt = new Date().getTime();

    // Connectivity check. Returns the sheet list so a moved or recreated
    // spreadsheet is obvious.
    if (action === "ping") {
      return jsonResponse({
        success: true,
        action: "ping",
        version: SCRIPT_VERSION,
        capabilities: ["ping", "sync_mirror", "clear_all"],
        spreadsheetName: ss.getName(),
        leadRows: countDataRows(getOrCreateSheet(ss, ALL_LEADS)),
        sheets: ss.getSheets().map(function (s) { return s.getName(); })
      });
    }

    // Resets every sheet before a one-time full rebuild.
    if (action === "clear_all") {
      var cleared = handleClearAll(ss);
      return jsonResponse({
        success: true,
        action: "clear_all",
        sheetsCleared: cleared,
        ms: new Date().getTime() - startedAt
      });
    }

    // The continuously updated path. Batched upserts and deletes in one call.
    if (action === "sync_mirror") {
      var mirror = handleSyncMirror(ss, payload.ops || [], payload.source || "unknown");
      return jsonResponse({
        success: true,
        action: "sync_mirror",
        source: payload.source || "unknown",
        received: (payload.ops || []).length,
        // Worker acknowledgement is logical jobs processed, not physical rows:
        // one lead is written to All Leads + its status tab + Tagged Leads.
        processedOps: mirror.processedOps,
        upserted: mirror.upserted,
        deleted: mirror.deleted,
        rowsWritten: mirror.rowsWritten,
        skipped: mirror.skipped,
        sheetsTouched: mirror.sheetsTouched,
        leadRows: countDataRows(getOrCreateSheet(ss, ALL_LEADS)),
        ms: new Date().getTime() - startedAt
      });
    }

    // Single lead, kept for the manual path and for older clients.
    if (action === "upsert") {
      var one = handleUpsert(ss, payload.lead || {}, payload.previousStatus, payload.previousTag);
      return jsonResponse({
        success: true,
        action: "upsert",
        upserted: 1,
        leadId: one.leadId || one.dbId || one.jobId,
        ms: new Date().getTime() - startedAt
      });
    }

    if (action === "delete") {
      var removed = handleDelete(ss, payload.lead_id, payload.db_id, payload.job_id);
      return jsonResponse({
        success: true,
        action: "delete",
        deleted: removed ? 1 : 0,
        ms: new Date().getTime() - startedAt
      });
    }

    // Original append-based batching, unchanged, still used by the one-time
    // full sync that clears first.
    if (action === "sync_batch") {
      var batchResult = handleSyncBatch(
        ss,
        payload.leads || [],
        payload.batchNumber || 1,
        payload.totalBatches || 1,
        payload.isLastBatch !== false
      );
      return jsonResponse({
        success: true,
        action: "sync_batch",
        appended: (payload.leads || []).length,
        sheetsWritten: batchResult,
        ms: new Date().getTime() - startedAt
      });
    }

    if (action === "sync_all") {
      var total = handleSyncAll(ss, payload.leads || []);
      return jsonResponse({
        success: true,
        action: "sync_all",
        appended: total,
        ms: new Date().getTime() - startedAt
      });
    }

    return jsonResponse({
      success: false,
      error: "Unknown action: " + action,
      code: "UNKNOWN_ACTION"
    });
  } catch (err) {
    return jsonResponse({
      success: false,
      error: (err && err.message) ? err.message : String(err),
      code: "SCRIPT_ERROR"
    });
  } finally {
    lock.releaseLock();
  }
}


// =============================================================================
// CONTINUOUS MIRROR
// =============================================================================

/**
 * Applies a batch of upserts and deletes.
 *
 * Sheets are grouped first so each one is indexed exactly once, no matter how
 * many leads in the batch touch it.
 */
function handleSyncMirror(ss, ops, source) {
  var upserts = [];
  var deletes = [];
  var processedOps = 0;

  ops.forEach(function (op) {
    if (!op || typeof op !== "object") {
      throw new Error("Every sync_mirror operation must be an object.");
    }
    if (op.op === "delete") {
      if (!collectIds({}, op).length) throw new Error("Delete operation is missing all lead identifiers.");
      deletes.push(op);
      processedOps++;
    } else if (op.op === "upsert" && op.lead && typeof op.lead === "object") {
      if (!collectIds(op.lead, op).length) throw new Error("Upsert operation is missing all lead identifiers.");
      upserts.push(op);
      processedOps++;
    } else {
      throw new Error("Unsupported sync_mirror operation: " + String(op.op));
    }
  });

  // Map each target sheet to the upserts that belong on it.
  var bySheet = {};
  function addTo(sheetName, op) {
    if (!sheetName) return;
    if (!bySheet[sheetName]) bySheet[sheetName] = [];
    bySheet[sheetName].push(op);
  }

  upserts.forEach(function (op) {
    var lead = op.lead;
    addTo(ALL_LEADS, op);

    var statusName = sanitizeSheetName((lead["Status"] || "").trim());
    if (statusName) addTo(statusName, op);

    // A lead only belongs on Tagged Leads while it has a tag, so clearing the
    // tag is a delete from that sheet rather than an update.
    if ((lead["Tag"] || "").trim()) {
      addTo(TAGGED_LEADS, op);
    } else {
      deletes.push({ op: "delete", db_id: op.db_id, job_id: op.job_id, lead_id: op.lead_id, _onlySheet: TAGGED_LEADS });
    }
  });

  // The database outbox retains each previous status while edits coalesce.
  // Remove only from those former tabs rather than scanning every status sheet
  // for every batch (which scaled as the full workbook grew).
  var staleStatusIds = Object.create(null);
  upserts.forEach(function (op) {
    var currentStatus = sanitizeSheetName((op.lead["Status"] || "").trim());
    var oldStatuses = Array.isArray(op.previousStatuses)
      ? op.previousStatuses
      : (op.previousStatus ? [op.previousStatus] : []);
    oldStatuses.forEach(function (oldStatusValue) {
      var oldStatus = sanitizeSheetName(String(oldStatusValue || "").trim());
      if (!oldStatus || oldStatus === currentStatus || oldStatus === ALL_LEADS || oldStatus === TAGGED_LEADS) return;
      if (!staleStatusIds[oldStatus]) staleStatusIds[oldStatus] = [];
      staleStatusIds[oldStatus] = staleStatusIds[oldStatus].concat(collectIds(op.lead, op));
    });
  });
  Object.keys(staleStatusIds).forEach(function (sheetName) {
    var oldSheet = ss.getSheetByName(sheetName);
    if (oldSheet) deleteIdsFromSheet(oldSheet, staleStatusIds[sheetName]);
  });

  var upserted = 0;
  var deleted = 0;
  var skipped = 0;
  var rowsWritten = 0;
  var sheetsTouched = 0;

  Object.keys(bySheet).forEach(function (sheetName) {
    var sheet = getOrCreateSheet(ss, sheetName);
    setupSheetHeaders(sheet);
    var outcome = applyUpsertsToSheet(sheet, bySheet[sheetName]);
    upserted += outcome.upserted;
    rowsWritten += outcome.rowsWritten;
    sheetsTouched++;
  });

  deletes.forEach(function (op) {
    var targetSheets = op._onlySheet
      ? [getOrCreateSheet(ss, op._onlySheet)]
      : ss.getSheets();
    var removed = deleteIdFromSheets(targetSheets, op.db_id, op.lead_id, op.job_id);
    if (removed > 0) {
      deleted += removed;
      rowsWritten += removed;
    } else {
      skipped++;
    }
  });

  if (typeof console !== "undefined") {
    console.log("mirror " + source + ": upserted=" + upserted + " deleted=" + deleted +
      " skipped=" + skipped + " sheets=" + sheetsTouched);
  }

  return {
    upserted: upserted,
    deleted: deleted,
    skipped: skipped,
    rowsWritten: rowsWritten,
    sheetsTouched: sheetsTouched,
    processedOps: processedOps
  };
}

/** Remove a batch of identifiers from one sheet with one column read. */
function deleteIdsFromSheet(sheet, identifiers) {
  if (sheet.getLastRow() < 2) return 0;
  var targets = Object.create(null);
  identifiers.forEach(function (id) {
    var normalized = normalizeId(id);
    if (normalized) targets[normalized] = true;
  });
  if (!Object.keys(targets).length) return 0;

  var range = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1);
  var values = range.getValues();
  var display = range.getDisplayValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === "" && display[i][0] === "") continue;
    var key = normalizeId(values[i][0]);
    if (targets[key]) rows.push(i + 2);
  }
  rows.sort(function (a, b) { return b - a; });
  rows.forEach(function (row) {
    if (row >= 2 && row <= sheet.getLastRow()) sheet.deleteRow(row);
  });
  return rows.length;
}

/**
 * Writes every upsert for one sheet, reading the index only once.
 *
 * Order matters. Existing rows are updated first because that does not move
 * anything, so the index stays valid. New rows are inserted afterwards and
 * the index is adjusted, rather than re-reading after every insert.
 */
function applyUpsertsToSheet(sheet, ops) {
  var index = buildRowIndex(sheet);
  var updated = [];
  var inserts = [];

  ops.forEach(function (op) {
    var lead = op.lead;
    var ids = collectIds(lead, op);
    var hit = lookupRow(index, ids);
    if (hit !== null) {
      updated.push({ hit: hit, rowData: leadToRow(lead), ids: ids });
    } else {
      inserts.push({ lead: lead, ids: ids, rowData: leadToRow(lead) });
    }
  });

  var rowsWritten = 0;

  // Pass 1: update in place. No structural change, so the index survives.
  updated.forEach(function (item) {
    sheet.getRange(item.hit, 1, 1, item.rowData.length).setValues([item.rowData]);
    rowsWritten++;
  });

  // Pass 2: insert the new ones. Each insertRowBefore(2) pushes the whole
  // sheet down, so the count of inserts is added to every index entry once
  // rather than rewriting the map per row.
  var inserted = 0;
  inserts.forEach(function (item) {
    sheet.insertRowBefore(2);
    sheet.getRange(2, 1, 1, item.rowData.length).setValues([item.rowData]);
    sheet.getRange(2, 1, 1, item.rowData.length)
      .setFontFamily("Arial")
      .setFontSize(10)
      .setVerticalAlignment("middle");
    inserted++;
    rowsWritten++;
  });

  if (inserted > 0) {
    // The k inserted rows now occupy 2..k+1 in the order they were inserted.
    var keys = Object.keys(index);
    for (var i = 0; i < keys.length; i++) {
      index[keys[i]] = index[keys[i]] + inserted;
    }
    for (var j = 0; j < inserts.length; j++) {
      var newKeys = inserts[j].ids;
      for (var m = 0; m < newKeys.length; m++) {
        if (newKeys[m]) index[newKeys[m]] = 2 + j;
      }
    }
  }

  return { upserted: updated.length + inserts.length, rowsWritten: rowsWritten };
}

/**
 * Reads the first column once and returns normalizedId -> row number.
 *
 * Only one bulk read per sheet per batch, instead of one read per lead.
 */
function buildRowIndex(sheet) {
  var index = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return index;

  var range = sheet.getRange(2, 1, lastRow - 1, 1);
  var values = range.getValues();
  var display = range.getDisplayValues();

  for (var i = 0; i < values.length; i++) {
    var raw = values[i][0];
    var shown = display[i][0];
    if (raw === "" && shown === "") continue;
    var key = normalizeId(raw);
    if (!key) continue;
    // First occurrence wins, matching the original behaviour of finding the
    // topmost matching row.
    if (index[key] === undefined) index[key] = i + 2;
  }

  return index;
}

/** Every identifier form that could identify this lead row. */
function collectIds(lead, op) {
  var ids = [];
  function push(value) {
    var key = normalizeId(value);
    if (key && ids.indexOf(key) === -1) ids.push(key);
  }
  push(lead["_id"]);
  push(lead["_job_id"]);
  push(lead["id"]);
  push(lead["job_id"]);
  push(lead["Lead ID"]);
  push(lead["Lead Id"]);
  push(op.db_id);
  push(op.job_id);
  push(op.lead_id);
  return ids;
}

/** First index hit across the candidate identifiers, or null. */
function lookupRow(index, ids) {
  for (var i = 0; i < ids.length; i++) {
    if (index[ids[i]] !== undefined) return index[ids[i]];
  }
  return null;
}


// =============================================================================
// DELETES
// =============================================================================

/**
 * Removes a lead from every sheet that holds it.
 *
 * Rows are gathered first and then deleted from the bottom up. Deleting the
 * lowest row first means the rows above it keep their numbers, so a single
 * pass never has to re-check positions it has already visited.
 */
function deleteIdFromSheets(sheets, dbId, leadId, jobId) {
  var targets = [normalizeId(dbId), normalizeId(leadId), normalizeId(jobId)].filter(Boolean);
  if (!targets.length) return 0;

  var pending = [];

  sheets.forEach(function (sheet) {
    if (sheet.getLastRow() < 2) return;
    var range = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1);
    var values = range.getValues();
    var display = range.getDisplayValues();
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === "" && display[i][0] === "") continue;
      var key = normalizeId(values[i][0]);
      if (key && targets.indexOf(key) !== -1) pending.push({ sheet: sheet, row: i + 2 });
    }
  });

  // Bottom-up per sheet so earlier deletions do not shift later ones.
  pending.sort(function (a, b) { return b.row - a.row; });
  var removed = 0;
  pending.forEach(function (item) {
    if (item.row >= 2 && item.row <= item.sheet.getLastRow()) {
      item.sheet.deleteRow(item.row);
      removed++;
    }
  });

  return removed;
}


// =============================================================================
// LEGACY PER-LEAD PATH
// =============================================================================

/**
 * Single-lead upsert, kept for the manual path and older clients.
 *
 * The mirror path above is what the client uses for ongoing sync; this stays
 * correct rather than fast.
 */
function handleUpsert(ss, lead, previousStatus, previousTag) {
  var leadId = String(lead["Lead ID"] || lead["Lead Id"] || lead["_job_id"] || lead["job_id"] || "").trim();
  var dbId = String(lead["_id"] || lead["id"] || "").trim();
  var jobId = String(lead["_job_id"] || lead["job_id"] || "").trim();
  var rowData = leadToRow(lead);

  var allLeadsSheet = getOrCreateSheet(ss, ALL_LEADS);
  setupSheetHeaders(allLeadsSheet);
  var updatedRow = upsertRowInSheet(allLeadsSheet, leadId, rowData, dbId, jobId);

  var currentStatus = (lead["Status"] || "").trim();
  var sanitizedCurrentStatus = sanitizeSheetName(currentStatus);

  // Remove the lead from every sheet it no longer belongs on.
  ss.getSheets().forEach(function (s) {
    var sName = s.getName();
    if (sName !== ALL_LEADS && sName !== TAGGED_LEADS && sName !== sanitizedCurrentStatus) {
      deleteRowById(s, leadId, dbId, jobId);
    }
  });

  if (currentStatus) {
    var newStatusSheet = getOrCreateSheet(ss, sanitizedCurrentStatus);
    setupSheetHeaders(newStatusSheet);
    upsertRowInSheet(newStatusSheet, leadId, rowData, dbId, jobId);
  }

  var currentTag = (lead["Tag"] || "").trim();
  var taggedSheet = getOrCreateSheet(ss, TAGGED_LEADS);
  if (currentTag) {
    setupSheetHeaders(taggedSheet);
    upsertRowInSheet(taggedSheet, leadId, rowData, dbId, jobId);
  } else {
    deleteRowById(taggedSheet, leadId, dbId, jobId);
  }

  return { leadId: leadId, dbId: dbId, jobId: jobId, updatedRow: updatedRow };
}

function handleDelete(ss, id1, id2, id3) {
  var removed = deleteIdFromSheets(ss.getSheets(), id2, id1, id3);
  return removed > 0;
}

/**
 * Original full-column upsert, kept for the legacy single-lead path.
 * Reads the whole first column, so it is only used when a caller still sends
 * the old "upsert" action.
 */
function upsertRowInSheet(sheet, leadId, rowData, dbId, jobId) {
  var lastRow = sheet.getLastRow();
  var foundRow = -1;
  var targetIds = [leadId, dbId, jobId].filter(Boolean);

  if (lastRow > 1) {
    var range = sheet.getRange(2, 1, lastRow - 1, 1);
    var values = range.getValues();
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
  }

  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, rowData.length).setValues([rowData]);
  sheet.getRange(2, 1, 1, rowData.length)
    .setFontFamily("Arial")
    .setFontSize(10)
    .setVerticalAlignment("middle");
  return 2;
}

function matchesAnyId(cellVal, dispVal, targetIds) {
  var raw = normalizeId(cellVal);
  var shown = normalizeId(dispVal);
  for (var i = 0; i < targetIds.length; i++) {
    var target = normalizeId(targetIds[i]);
    if (!target) continue;
    if (raw === target || shown === target) return true;
  }
  return false;
}

function deleteRowById(sheet, id1, id2, id3) {
  var targetIds = [id1, id2, id3].filter(Boolean);
  if (!targetIds.length) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  var range = sheet.getRange(2, 1, lastRow - 1, 1);
  var values = range.getValues();
  var displayValues = range.getDisplayValues();
  var hits = [];

  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === "" && displayValues[i][0] === "") continue;
    if (matchesAnyId(values[i][0], displayValues[i][0], targetIds)) hits.push(i + 2);
  }

  hits.sort(function (a, b) { return b - a; });
  hits.forEach(function (row) {
    if (row >= 2 && row <= sheet.getLastRow()) sheet.deleteRow(row);
  });
  return hits.length > 0;
}


// =============================================================================
// ONE-TIME FULL SYNC (append based, unchanged)
// =============================================================================

function handleClearAll(ss) {
  var cleared = 0;
  ss.getSheets().forEach(function (sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
      sheet.deleteRows(2, lastRow - 1);
    }
    cleared++;
  });
  return cleared;
}

function handleSyncBatch(ss, leads, batchNumber, totalBatches, isLastBatch) {
  var sheetsWritten = [];

  if (batchNumber === 1) {
    setupSheetHeaders(getOrCreateSheet(ss, ALL_LEADS));
    setupSheetHeaders(getOrCreateSheet(ss, TAGGED_LEADS));
  }

  var allLeadsSheet = getOrCreateSheet(ss, ALL_LEADS);
  appendRowsToSheet(allLeadsSheet, leads);
  sheetsWritten.push(ALL_LEADS);

  var leadsByStatus = {};
  leads.forEach(function (l) {
    var status = sanitizeSheetName((l["Status"] || "No Status").trim());
    if (!leadsByStatus[status]) leadsByStatus[status] = [];
    leadsByStatus[status].push(l);
  });

  Object.keys(leadsByStatus).forEach(function (statusName) {
    var statusSheet = getOrCreateSheet(ss, statusName);
    setupSheetHeaders(statusSheet);
    appendRowsToSheet(statusSheet, leadsByStatus[statusName]);
    sheetsWritten.push(statusName);
  });

  var tagged = leads.filter(function (l) { return (l["Tag"] || "").trim(); });
  if (tagged.length) {
    var taggedSheet = getOrCreateSheet(ss, TAGGED_LEADS);
    appendRowsToSheet(taggedSheet, tagged);
    sheetsWritten.push(TAGGED_LEADS);
  }

  if (isLastBatch) {
    ss.getSheets().forEach(function (sheet) { autoFitColumns(sheet); });
  }

  return sheetsWritten;
}

function handleSyncAll(ss, leads) {
  handleClearAll(ss);
  return handleSyncBatch(ss, leads, 1, 1, true).appended || leads.length;
}

function appendRowsToSheet(sheet, leads) {
  if (!leads.length) return 0;
  var rows = leads.map(function (l) { return leadToRow(l); });
  var startRow = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(startRow, 1, rows.length, HEADERS.length).setValues(rows);
  sheet.getRange(startRow, 1, rows.length, HEADERS.length)
    .setFontFamily("Arial")
    .setFontSize(10)
    .setVerticalAlignment("middle");
  return rows.length;
}

function setupSheetHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }
}


// =============================================================================
// HELPERS
// =============================================================================

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

/**
 * Canonical form of an identifier.
 *
 * Case and punctuation vary for the same value: J-1, j1 and J_1 all mean the
 * same job. They are reduced to letters and digits and lowercased so one index
 * entry serves every spelling instead of needing one entry per variant.
 *
 * Note the prefix is significant: J-77 and job-77 are genuinely different
 * values and stay different. A sheet written by an older build with a
 * different prefix would therefore look like a new lead, which is why the
 * client runs one clear_and_rebuild after the script is replaced.
 */
function normalizeId(id) {
  if (id === null || id === undefined) return "";
  var text = String(id).trim();
  if (!text) return "";
  var cleaned = text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

  // Postgres uses the all-zero uuid as a "no value" sentinel. The previous
  // guard tested for a "0000-" prefix, which an all-zero uuid never has, so
  // the sentinel was indexed as if it were a real lead id and could shadow a
  // genuine row. Testing the stripped value catches every all-zero form.
  if (/^0+$/.test(cleaned)) return "";

  return cleaned;
}

function countDataRows(sheet) {
  var lastRow = sheet.getLastRow();
  return lastRow > 1 ? lastRow - 1 : 0;
}

function getOrCreateSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

function sanitizeSheetName(name) {
  if (!name) return "";
  var cleaned = String(name).replace(/[\\/?*[\]:]/g, " ").trim();
  return cleaned;
}

function autoFitColumns(sheet) {
  for (var col = 1; col <= HEADERS.length; col++) {
    sheet.autoResizeColumn(col);
    var width = sheet.getColumnWidth(col);
    if (width < 120) sheet.setColumnWidth(col, 120);
    if (width > 350) sheet.setColumnWidth(col, 350);
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
