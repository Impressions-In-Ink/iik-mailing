/**
 * estimate.js — the checkout estimate, from AccuZIP's free quote.
 *
 * Pulse task "Estimate at checkout from AccuZIP's free quote" (Self-serve
 * Direct Mail, Phase 2): when a buyer uploads a list at checkout, show how
 * many pieces mail, what was left out and why, and the approximate
 * postage — without spending anything.
 *
 * WHAT IS FREE, AND WHAT THIS NEVER DOES
 *   - Uploading a job and reading its QUOTE cost nothing. The quote is
 *     ready about 15 seconds after the upload and carries
 *     `Estimated_Postage_{class}_{size}`.
 *   - This NEVER asks AccuZIP to process the job. A processed job that is
 *     never downloaded counts against the account, and AccuZIP bills on
 *     download; both belong after checkout.
 *   - It runs NO address check (CASS). That uses one credit per address,
 *     and at checkout it would spend credits on buyers who never order
 *     (Bradley, 2026-11-13: "Free quote only"). The address check still
 *     runs when the paid order is filed. So the estimate says what it is:
 *     every piece the buyer uploaded, BEFORE the address check, and the
 *     buyer is told some may still be left out.
 *
 * WHAT IS LEFT OUT HERE, FOR FREE: rows that can't be mail at all (no
 * street, or no city/state and no ZIP) and exact duplicates (the same
 * name at the same street and ZIP). Each comes back with its reason.
 *
 * CLASS: Marketing Mail on the shop's permit at 200+ pieces; a smaller run
 * mails First-Class without presort (decided 2026-10-10). The estimate
 * picks the quote line for that class and the piece's size; when AccuZIP
 * quoted no line for it, `estimatedPostage` is null and `reason` says so,
 * rather than a guessed number.
 */

"use strict";

const {presortCsv, PRESORT_MIN_PIECES} = require("./presort");

/** Why a row was left out before the upload. */
const REMOVAL_REASONS = Object.freeze({
  incomplete: "No street, or no city, state and ZIP",
  duplicate: "The same person at the same address, already on the list",
});

/** How long to wait for the quote, and how often to ask. */
const QUOTE_WAIT_MS = 60 * 1000;
const QUOTE_POLL_MS = 3 * 1000;

/**
 * "$1,204.55", "85.31" or 85.31 as a number; null when it isn't one. PURE.
 * @param {*} v the value.
 * @return {?number} the amount.
 */
function moneyNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v == null ? "" : v).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * Every `Estimated_Postage_{class}_{size}` line on a quote. PURE.
 * @param {?object} quote the QUOTE JSON.
 * @return {Object<string, number>} e.g. {Standard_Letter: 85.31}.
 */
function quoteEstimates(quote) {
  const out = {};
  for (const [k, v] of Object.entries(quote || {})) {
    const m = /^Estimated_Postage_([A-Za-z0-9_]+)$/.exec(k);
    const n = moneyNumber(v);
    if (m && n !== null) out[m[1]] = n;
  }
  return out;
}

/**
 * The mail class a run of this many pieces goes as. PURE.
 * @param {number} pieces pieces that will mail.
 * @return {string} "marketing" (presorted, the shop's permit) or
 *   "firstClass" (no presort).
 */
function mailClassFor(pieces) {
  return Number(pieces) >= PRESORT_MIN_PIECES ? "marketing" : "firstClass";
}

/**
 * The quote line for a class and piece size, if AccuZIP gave one. PURE.
 *
 * Marketing Mail lines are `Standard_{Letter|Flat}`. First-Class lines
 * are matched loosely on their class word ("First…") and the size, so a
 * spelling AccuZIP uses that this hasn't seen still matches; a 4×6 card
 * is letter-size for Marketing Mail but may be quoted as a card for
 * First-Class, so CARD and LETTER both match it.
 * @param {Object<string, number>} estimates quoteEstimates().
 * @param {string} mailClass mailClassFor().
 * @param {string} size LETTER | FLAT.
 * @return {?{key: string, amount: number}} the line, or null.
 */
function pickEstimate(estimates, mailClass, size) {
  const want = String(size || "").toUpperCase() === "FLAT" ?
    ["flat"] : ["letter", "card", "postcard"];
  const entries = Object.entries(estimates || {});
  const ofClass = entries.filter(([k]) => mailClass === "marketing" ?
    /^standard_/i.test(k) : /^first/i.test(k));
  for (const w of want) {
    const hit = ofClass.find(([k]) => k.toLowerCase().endsWith(`_${w}`));
    if (hit) return {key: hit[0], amount: hit[1]};
  }
  return null;
}

/**
 * A row's key for spotting duplicates: name, street and 5-digit ZIP,
 * lower case, letters and digits only. PURE.
 * @param {object} r the recipient's data.
 * @return {string} the key.
 */
function dupKey(r) {
  const k = (v) => String(v == null ? "" : v).toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  return [k(r.name), k(r.line1), k(r.zip).slice(0, 5)].join("|");
}

/**
 * Which rows can go to the quote, and which are left out and why. PURE.
 * @param {Array<{id: string, data: object}>} recipients the uploaded list
 *   (data: {name, company, line1, line2, city, state, zip}).
 * @return {{keep: Array<object>, removed: Array<{id: string,
 *   reason: string}>, removals: Object<string, number>}} removals: the
 *   count per reason key (REMOVAL_REASONS).
 */
function prepareRows(recipients) {
  const keep = [];
  const removed = [];
  const removals = {incomplete: 0, duplicate: 0};
  const seen = new Set();
  for (const rec of recipients || []) {
    const r = (rec && rec.data) || {};
    const has = (v) => String(v == null ? "" : v).trim().length > 0;
    const zip5 = String(r.zip == null ? "" : r.zip).replace(/\D/g, "");
    if (!has(r.line1) || !((has(r.city) && has(r.state)) || zip5.length >= 5)) {
      removals.incomplete++;
      removed.push({id: String((rec && rec.id) || ""), reason: "incomplete"});
      continue;
    }
    const key = dupKey(r);
    if (seen.has(key)) {
      removals.duplicate++;
      removed.push({id: String(rec.id || ""), reason: "duplicate"});
      continue;
    }
    seen.add(key);
    keep.push(rec);
  }
  return {keep, removed, removals};
}

/**
 * The checkout estimate. Uploads to AccuZIP and reads the free quote; never
 * processes, never downloads, never checks addresses.
 * @param {object} o the request.
 * @param {Array<{id: string, data: object}>} o.recipients the list.
 * @param {string} o.size the product's piece size: LETTER | FLAT.
 * @param {object} o.cloud an AccuzipCloud (keys already in it), or a fake
 *   with upload() and quoteIfReady().
 * @param {string=} o.fileName the upload's name (must end in .csv).
 * @param {number=} o.waitMs how long to wait for the quote.
 * @param {number=} o.pollMs how often to ask.
 * @param {function(number): Promise=} o.sleep a waiter (tests).
 * @param {function(): number=} o.now a clock (tests).
 * @return {Promise<object>} {
 *     uploaded: rows the buyer gave,
 *     pieces: rows quoted (after the free removals),
 *     removals: {incomplete, duplicate}, removed: [{id, reason}],
 *     mailClass: "marketing" | "firstClass",
 *     estimatedPostage: number | null, perPiece: number | null,
 *     quoteLine: the Estimated_Postage key used, or "",
 *     estimates: every line AccuZIP quoted,
 *     beforeAddressCheck: true,
 *     reason: "" or why there is no postage figure,
 *     guid: the AccuZIP job (uploaded, never processed) }.
 */
async function estimateMailing(o) {
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || Date.now;
  const uploaded = (o.recipients || []).length;
  const {keep, removed, removals} = prepareRows(o.recipients);
  const pieces = keep.length;
  const mailClass = mailClassFor(pieces);
  const base = {uploaded, pieces, removals, removed, mailClass,
    estimatedPostage: null, perPiece: null, quoteLine: "", estimates: {},
    beforeAddressCheck: true, reason: "", guid: ""};
  if (!pieces) return {...base, reason: "No rows can be mailed."};

  const guid = await o.cloud.upload(presortCsv(keep),
      o.fileName || "estimate.csv", "");
  const deadline = now() + (o.waitMs || QUOTE_WAIT_MS);
  let quote = null;
  for (;;) {
    quote = await o.cloud.quoteIfReady(guid);
    if (quote || now() >= deadline) break;
    await sleep(o.pollMs || QUOTE_POLL_MS);
  }
  if (!quote) {
    return {...base, guid, reason: "AccuZIP's quote wasn't ready in time."};
  }
  const estimates = quoteEstimates(quote);
  const line = pickEstimate(estimates, mailClass, o.size);
  if (!line) {
    return {...base, guid, estimates, reason: mailClass === "marketing" ?
      "AccuZIP quoted no Marketing Mail postage for this piece size." :
      "Under 200 pieces mails First-Class without presort, and AccuZIP " +
        "quoted no First-Class postage for it."};
  }
  return {...base, guid, estimates, quoteLine: line.key,
    estimatedPostage: line.amount,
    perPiece: Math.round((line.amount / pieces) * 10000) / 10000};
}

module.exports = {
  REMOVAL_REASONS,
  QUOTE_WAIT_MS,
  moneyNumber,
  quoteEstimates,
  mailClassFor,
  pickEstimate,
  prepareRows,
  estimateMailing,
};
