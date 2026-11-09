/**
 * classify.js — what a CASS response row MEANS for an operator
 * ─────────────────────────────────────────────────────────────────────
 * One grader for every address check we run: the admin app's mailing-list
 * screen and shipping station, and Impulse's check of every recipient on a
 * paid mailing. It began inside the admin app's validateAddresses.js and was
 * hand-copied into Impulse; it lives here now so the copies can't drift. An
 * address one screen calls deliverable must never be one another refuses.
 *
 * Buckets, in priority order:
 *   undeliverable > vacant > missing_secondary > corrected > verified
 *
 * WHAT COUNTS AS A CORRECTION. CASS standardizes every input (case,
 * spacing, footnote N) and substitutes USPS's preferred city name for a ZIP
 * even when the input city was valid — Tigard and Portland share ZIPs. Only
 * changes that mean "USPS fixed something wrong" flip an address into
 * `corrected`; the rest are shown but do not change the grade. See
 * buildCorrectionsAndSubstantive.
 *
 * No firebase, no network: `node --test` runs it with no credentials.
 */

"use strict";

// Footnote flag → human-readable correction description. These are the
// flags Accuzip populates when USPS made a change OR flagged a delivery
// problem. Only the ones that mean something to an operator are surfaced —
// there are dozens more that are purely informational for a postal
// workflow.
const CORRECTION_FLAGS = Object.freeze({
  A: "ZIP code corrected",
  B: "City/state spelling corrected",
  H: "Missing apartment or suite number",
  K: "Directional changed (N/S/E/W)",
  L: "Address component added or changed",
  M: "Street name spelling corrected",
  N: "Address standardized",
  S: "Invalid secondary number (apt/suite)",
});

// Footnote flags that produce DISPLAY text but DO NOT mean USPS actually
// changed the address in a meaningful way. CASS runs every input through a
// standardization pass (case normalization, spacing, etc.) — flagging those
// as "corrected" would push every clean address into the corrections
// bucket. Keep the flag displayed for transparency, but don't let it flip
// status from "verified" to "corrected."
const INFORMATIONAL_FLAGS = new Set(["N"]);

/**
 * Coerce any value to a safe string. Lets the response parser read every
 * field without null checks.
 *
 * @param {*} v Value.
 * @return {string}
 */
function str(v) {
  return typeof v === "string" ? v : "";
}

/**
 * Build two correction lists for a response row:
 *   display:     every change/standardization the operator may want to
 *                see, for the review UI
 *   substantive: only the changes that actually mean "USPS fixed something
 *                wrong with the input" — used for status classification so
 *                cosmetic standardizations and USPS preferred-city
 *                substitutions don't flip a clean address into "corrected"
 *
 * Non-substantive cases filtered out:
 *   - Footnote N ("address standardized") — CASS runs this on every input.
 *     It signals formatting normalization, not a data change.
 *   - Input vs output ZIP diffs where the 5-digit part matches (a ZIP+4
 *     suffix added on the output side is routing metadata, not a
 *     correction of the input).
 *   - Input vs output city where footnote B is NOT set. USPS assigns a
 *     preferred city name to each ZIP, and multiple city names can all be
 *     valid. B is the signal for a genuine spelling fix; without it, the
 *     change is a preferred-name substitution.
 *
 * @param {object} resp One Addr_Result entry.
 * @param {object} input The original request row (`zip`, `city`).
 * @return {{display: string[], substantive: string[]}}
 */
function buildCorrectionsAndSubstantive(resp, input) {
  const display = [];
  const substantive = [];

  for (const [flag, description] of Object.entries(CORRECTION_FLAGS)) {
    if (str(resp[flag]).length === 0) continue;
    display.push(description);
    if (!INFORMATIONAL_FLAGS.has(flag)) substantive.push(description);
  }

  // ZIP diff — compare 5-digit forms only. The input may carry a ZIP+4
  // suffix ("97223-0602") and the response field `zipc` is always 5-digit
  // (the +4 lives in `addon`), so a raw string compare produces false
  // positives on every ZIP+4 input.
  const inputZipRaw = str(input.zip).trim();
  const inputZip5 = inputZipRaw.split("-")[0].trim();
  const outputZip5 = str(resp.zipc).trim();
  if (outputZip5 && inputZip5 && outputZip5 !== inputZip5) {
    const msg = `ZIP corrected: ${inputZip5} → ${outputZip5}`;
    display.push(msg);
    substantive.push(msg);
  }

  // City diff — footnote B is the authoritative signal that a spelling fix
  // happened. Without it, a city change is a USPS preferred-name
  // substitution (same ZIP, different deliverable city name), which should
  // be informational only.
  const stdCity = str(resp.dctys);
  const inputCity = str(input.city);
  if (
    stdCity &&
    inputCity &&
    stdCity.toLowerCase() !== inputCity.toLowerCase()
  ) {
    const isPreferred = str(resp.B).length === 0;
    const msg = isPreferred ?
      `USPS preferred city: ${inputCity} → ${stdCity}` :
      `City corrected: ${inputCity} → ${stdCity}`;
    display.push(msg);
    if (!isPreferred) substantive.push(msg);
  }

  return {
    display: [...new Set(display)],
    substantive: [...new Set(substantive)],
  };
}

/**
 * Derive the warnings list from DPV / DPVV codes. Warnings are "the mail
 * may still be delivered, but the operator should know" — distinct from
 * footnote corrections (what USPS actually fixed).
 *
 * @param {object} resp One Addr_Result entry.
 * @return {string[]}
 */
function buildWarnings(resp) {
  const out = [];
  const dpva = str(resp.DPVA);
  if (dpva === "D") out.push("Secondary address (apt/suite) is missing");
  if (dpva === "S") out.push("Secondary address could not be confirmed");
  if (str(resp.DPVV) === "Y") out.push("Address is flagged as vacant");
  return out;
}

/**
 * Collapse DPV codes + footnote flags + vacant flag into one of five
 * operator-facing buckets. Priority order:
 *   undeliverable > vacant > missing_secondary > corrected > verified
 *
 * The `substantiveCorrections` argument is the filtered list — see
 * buildCorrectionsAndSubstantive. Cosmetic standardizations and
 * preferred-name substitutions do NOT count, so an address that was found
 * and confirmed but written with USPS's preferred city stays in
 * "verified", not "corrected".
 *
 * @param {object} resp One Addr_Result entry.
 * @param {string[]} substantiveCorrections Filtered corrections.
 * @return {string}
 */
function deriveStatus(resp, substantiveCorrections) {
  const dpva = str(resp.DPVA);
  const hasFlag = (k) => str(resp[k]).length > 0;

  const undeliverable =
    dpva === "N" || dpva === "" ||
    hasFlag("C") || hasFlag("D") || hasFlag("F");
  if (undeliverable) return "undeliverable";
  if (str(resp.DPVV) === "Y") return "vacant";
  if (dpva === "D" || hasFlag("H")) return "missing_secondary";
  if (substantiveCorrections.length > 0) return "corrected";
  return "verified";
}

/**
 * Grade one response row against the input it answered.
 *
 * The one-call face of the three functions above, for callers that want
 * the verdict and the reasons together.
 *
 * @param {object} resp One Addr_Result entry.
 * @param {object} input The original request row (`zip`, `city`).
 * @return {{status: string, corrections: string[], warnings: string[],
 *   dpvCode: string, vacant: boolean}}
 */
function classifyCassRow(resp, input) {
  const {display, substantive} =
    buildCorrectionsAndSubstantive(resp, input || {});
  return {
    status: deriveStatus(resp, substantive),
    corrections: display,
    warnings: buildWarnings(resp),
    dpvCode: str(resp.DPVA),
    vacant: str(resp.DPVV) === "Y",
  };
}

module.exports = {
  CORRECTION_FLAGS,
  INFORMATIONAL_FLAGS,
  buildCorrectionsAndSubstantive,
  buildWarnings,
  deriveStatus,
  classifyCassRow,
};
