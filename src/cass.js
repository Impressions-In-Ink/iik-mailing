/**
 * cass.js — asking AccuZIP's CASS service about addresses
 * ─────────────────────────────────────────────────────────────────────
 * The request and response halves every caller shares: the row AccuZIP
 * wants for one address, the POST that sends up to 20 of them, and the
 * readings of what comes back. The GRADE of a result (verified, corrected,
 * undeliverable…) is classify.js; this file is only the conversation.
 *
 * Each app keeps what is its own: the secret (ACCUZIP_API_KEY, a Firebase
 * secret the caller reads and passes in), its timeout and retry policy, and
 * how it reports a failure to its user.
 *
 *   POST https://api.cassonline.com/servoy-service/rest_ws/ws_address/ws_validate
 *   {"API_KEY": "<key>", "Address": [row, …]}      (at most 20 rows)
 *   → {"success": true, "Addr_Result": [ {dadl1, dctys, dstaa, zipc,
 *      addon, DPVA, DPVV, iforeignid, …}, … ]}
 *
 * NEVER PUT A RESPONSE BODY IN AN ERROR. AccuZIP echoes the API key in its
 * error replies, so an error message built from the body carries the key
 * into logs and onto staff screens. postCass() throws status-only errors.
 *
 * No firebase, no network of its own (fetch is passed in or the global):
 * `node --test` runs it with no credentials.
 */

"use strict";

const CASS_URL = "https://api.cassonline.com/servoy-service/rest_ws/" +
  "ws_address/ws_validate";

/** AccuZIP's maximum rows per request. */
const CASS_BATCH_SIZE = 20;

/**
 * A safe string.
 * @param {*} v any value.
 * @return {string} trimmed string, "" for anything else.
 */
function str(v) {
  return typeof v === "string" ? v.trim() :
    (typeof v === "number" ? String(v) : "");
}

/**
 * One address as an AccuZIP request row. PURE.
 * @param {object} a {line1, line2?, company?, city, state, zip}.
 * @param {string|number} foreignId echoed back so results map to inputs.
 * @return {object} the request row.
 */
function cassRequestRow(a, foreignId) {
  const rec = a || {};
  return {
    "AZSetQuery_iadl1": str(rec.line1),
    "AZSetQuery_iadl2": str(rec.company),
    "AZSetQuery_iadl3": str(rec.line2),
    "AZSetQuery_ictyi": str(rec.city),
    "AZSetQuery_istai": str(rec.state),
    "AZSetQuery_izipc": str(rec.zip),
    "AZSetQuery_icountry": "US",
    "AZSetQuery_iforeignid": String(foreignId),
    // AccuZIP answers in UPPERCASE unless asked for mixed case.
    "mixedcase": "1",
  };
}

/**
 * Send up to CASS_BATCH_SIZE rows and return AccuZIP's reply.
 *
 * Throws on a non-200, a reply that isn't JSON, `success` not true, or no
 * Addr_Result array, with a message that names the status and never the
 * body (see the header).
 *
 * @param {string} apiKey the CASS key.
 * @param {Array<object>} rows request rows (cassRequestRow, or the
 *   caller's own row shape).
 * @param {object} [o] {fetchImpl?}.
 * @return {Promise<object>} the reply: {success: true, Addr_Result: […]}.
 */
async function postCass(apiKey, rows, o) {
  const fetchImpl = (o && o.fetchImpl) || fetch;
  const resp = await fetchImpl(CASS_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({"API_KEY": apiKey, "Address": rows}),
  });
  if (!resp.ok) {
    throw new Error(`AccuZIP HTTP ${resp.status}`);
  }
  let data;
  try {
    data = await resp.json();
  } catch (_) {
    throw new Error("AccuZIP reply was not JSON");
  }
  if (!data || data.success !== true || !Array.isArray(data.Addr_Result)) {
    throw new Error("AccuZIP returned no results");
  }
  return data;
}

/**
 * Each result row keyed by the foreign id it was sent with. AccuZIP
 * echoes the id as `iforeignid` (sometimes `foreignid`); a row that
 * echoes neither falls back to the request row in the same position.
 * PURE.
 * @param {object} data a postCass reply.
 * @param {Array<object>} rows the request rows that were sent.
 * @return {Map<string, object>} foreign id → result row.
 */
function resultsByForeignId(data, rows) {
  const byId = new Map();
  const results = (data && Array.isArray(data.Addr_Result)) ?
    data.Addr_Result : [];
  results.forEach((row, i) => {
    const id = str(row && (row.iforeignid || row.foreignid)) ||
      str(rows && rows[i] && rows[i]["AZSetQuery_iforeignid"]);
    if (id) byId.set(id, row);
  });
  return byId;
}

/**
 * postCass, then resultsByForeignId.
 * @param {string} apiKey the CASS key.
 * @param {Array<object>} rows request rows.
 * @param {function} [fetchImpl] fetch.
 * @return {Promise<Map<string, object>>} foreign id → result row.
 */
async function callCassBatch(apiKey, rows, fetchImpl) {
  const data = await postCass(apiKey, rows, {fetchImpl});
  return resultsByForeignId(data, rows);
}

/**
 * The first result row as a standardized address. PURE. For callers that
 * check one address at a time (the admin app's tax resolver).
 * @param {object} json a CASS reply.
 * @return {object} {ok: true, standardized: {street, city, state, zip5,
 *   zip4, county}, dpv: {code, vacant}}, or {ok: false, error}.
 */
function parseCassResult(json) {
  if (!json || typeof json !== "object") {
    return {ok: false, error: "CASS: empty/non-object response"};
  }
  if (json.success !== true) {
    return {ok: false, error: "CASS success:false"};
  }
  const arr = Array.isArray(json.Addr_Result) ? json.Addr_Result : null;
  if (!arr || arr.length === 0) {
    return {ok: false, error: "CASS: no Addr_Result rows"};
  }
  const r = arr[0] || {};
  const text = (v) => v == null ? "" : String(v).trim();
  const street = text(r.dadl1);
  // The standardized city `dctys`, else the abbreviated `dctya`.
  const city = text(r.dctys) || text(r.dctya);
  const zip5 = text(r.zipc);
  // No street AND no ZIP is not an address anyone can use.
  if (!street && !zip5) {
    return {ok: false, error: "CASS: row has neither street nor ZIP"};
  }
  return {
    ok: true,
    standardized: {
      street,
      city,
      state: text(r.dstaa),
      zip5,
      zip4: text(r.addon),
      county: text(r.county_name),
    },
    dpv: {
      code: text(r.DPVA),
      vacant: text(r.DPVV) === "Y",
    },
  };
}

/**
 * Does a standardized delivery line already carry the unit that was
 * typed? CASS folds "STE 200" into `dadl1` when it recognises it; when it
 * doesn't, the typed unit must survive, or the piece goes to the building
 * and not the suite. "Suite 200" and "STE 200" are the same place: only
 * the unit number has to match. PURE.
 * @param {string} deliveryLine standardized `dadl1`.
 * @param {string} secondary the typed unit line.
 * @return {boolean} true when nothing would be lost.
 */
function deliveryLineCarries(deliveryLine, secondary) {
  const sec = String(secondary || "").trim();
  if (!sec) return true;
  const line = String(deliveryLine || "").toUpperCase();
  const unit = (sec.match(/[A-Za-z0-9-]+$/) || [""])[0].toUpperCase();
  return unit !== "" && line.split(/\s+/).includes(unit);
}

module.exports = {
  CASS_URL,
  CASS_BATCH_SIZE,
  cassRequestRow,
  postCass,
  resultsByForeignId,
  callCassBatch,
  parseCassResult,
  deliveryLineCarries,
};
