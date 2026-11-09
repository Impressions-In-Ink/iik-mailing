/**
 * presort.js — a mailing, presorted for USPS Marketing Mail
 * ---------------------------------------------------------------
 * The step after the address check (cass.js + classify.js) for runs of
 * 200+ pieces: AccuZIP's cloud presort puts the run in USPS order and
 * gives every piece its Intelligent Mail barcode (IMb) and tray line, plus
 * the USPS paperwork (postage statement, qualification report, tray tags)
 * as a PDF. The print file then comes out in mailing order, so the shop
 * floor prints, trays in order and drops it at the post office.
 *
 * Built against AccuZIP's published REST contract ("AccuZIP REST API
 * Calls", accuzip.com/files/pdf/direct_mail_api.pdf). Driven by the
 * caller (Impulse's lib/mailingPresort.js) with the Direct Mail key
 * ACCUZIP_DM_API_KEY, passed in, never read here — a
 * DIFFERENT key from the CASS-only ACCUZIP_API_KEY, which this service
 * answers "API_KEY not found" for. Uploading and quoting are free; the
 * process step is the billed one (checked 2026-10-12: a 200-row upload +
 * quote left credits_used at 0).
 *
 * THE FLOW (all on cloud2.iaccutrace.com; checked against AccuZIP's
 * Postman collection at docs.accuzip.com, 2026-11-02):
 *   1. upload   POST /ws_360_webapps/v2_0/uploadProcess.jsp — a CSV of
 *               the run (200-row minimum), returns a job guid
 *   2. quote    GET  .../job/{guid}/QUOTE — wait for it to be ready
 *   3. settings PUT  .../job/{guid}/QUOTE — class, piece, permit, IMb,
 *               and the list owner's PAF for NCOALink
 *   4. process  GET  .../job/{guid}/CASS-NCOA-PRESORT — async; AccuZIP
 *               calls our callback URL, or poll QUOTE for FINISHED
 *   5. download GET  /ws_360_webapps/v2_0/download.jsp?guid=&ftype=csv
 *               | pdf | maildat.zip — AccuZIP bills the job on its FIRST
 *               download, so everything before this step is free
 *
 * MOVE UPDATE. Presorted Marketing Mail must meet the USPS Move Update
 * standard, and the postage statement says how. We claim NCOALink, which
 * needs the list owner's PAF (Processing Acknowledgement Form) on file
 * with AccuZIP — so there is no presort without a PAF id: no settings
 * (presortSettings throws) and no process (presortProcess throws). Every
 * mover NCOALink finds is left out of the run rather than mailed at an
 * address they've left.
 *
 * NO SILENT SWITCH. Below USPS minimums AccuZIP would quietly prepare the
 * run as First-Class, or move it to metered postage; the settings force
 * our class and payment, and presortOutcome() checks the finished job is
 * the one we asked for before anything is downloaded.
 *
 * The presorted CSV carries our own `impulse_id` column through, so each
 * row maps back to its recipient: sequence (mail order), endorse (the
 * tray line printed above the address), imbarcode (the 65-letter string
 * the USPS IMb font prints as bars), and the cleaned address.
 */

const PRESORT_BASE = "https://cloud2.iaccutrace.com";

/** USPS minimum for a presorted Marketing Mail run (and AccuZIP's
 * minimum upload). Below it, a mailing goes First-Class single piece. */
const PRESORT_MIN_PIECES = 200;

/** Our id column, carried through AccuZIP untouched. */
const ID_COLUMN = "impulse_id";

/** The 4×6 postcard as USPS measures it. Marketing Mail has no card rate;
 * a 4×6 is letter-size. Thickness/weight are a 14pt card's. */
const POSTCARD_PIECE = Object.freeze({
  size: "LETTER",
  heightIn: 4,
  lengthIn: 6,
  thicknessIn: 0.014,
  weightOz: 0.16,
});

/** Marketing Mail piece sizes AccuZIP can presort. CARD is First-Class
 * only, so it never appears here. */
const PIECE_SIZES = Object.freeze(["LETTER", "FLAT"]);

/** NCOALink results left out of the run (AccuZIP's filter_ncoa_NN): moved
 * with a new address (01), new address unconfirmed (02), moved left no
 * address (03), moved abroad (04), moved to a new state (05), and moved
 * 18-48 months ago (77). With coa_flag_only the address of every piece
 * that does mail stays the one we uploaded, so its barcode matches the
 * address printed on it. */
const NCOA_LEFT_OUT = Object.freeze(["01", "02", "03", "04", "05", "77"]);

/** Settings the shop must supply before a presort can run. */
const REQUIRED_SETTINGS = Object.freeze([
  "permitNumber", "mailerId", "crid", "dropZip", "serviceTypeId",
  "permitHolder", "signerName", "signerCompany", "signerPhone",
  "signerEmail",
]);

/**
 * Whether a run is big enough to presort. PURE.
 * @param {number} mailable pieces that will mail.
 * @return {boolean} true at 200+.
 */
function needsPresort(mailable) {
  return Number(mailable) >= PRESORT_MIN_PIECES;
}

/**
 * One CSV field, always quoted (AccuZIP's guidance for comma files).
 * @param {*} v the value.
 * @return {string} the quoted field.
 */
function csvField(v) {
  return `"${String(v == null ? "" : v).replace(/"/g, "\"\"")}"`;
}

/**
 * The run as AccuZIP's upload file: quoted CSV, CRLF rows, a header row
 * of AccuZIP's own column names plus our id. Uses the USPS-checked
 * address when there is one. PURE.
 * @param {Array<{id: string, data: object}>} recipients the pieces that
 *   mail (left-out recipients already removed).
 * @return {string} the file.
 */
function presortCsv(recipients) {
  const header = [ID_COLUMN, "first", "company", "address", "address2",
    "city", "st", "zip"];
  const rows = [header.map(csvField).join(",")];
  for (const {id, data} of recipients || []) {
    const r = data || {};
    const m = r.mailAddress && typeof r.mailAddress === "object" ?
      r.mailAddress : r;
    rows.push([id, r.name, r.company === r.name ? "" : r.company,
      m.line1, m.line2, m.city, m.state, m.zip].map(csvField).join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

/**
 * A list owner's AccuZIP PAF id in AccuZIP's form (six letters/digits,
 * e.g. X00001), or "" when it isn't one. PURE.
 * @param {*} v the stored id.
 * @return {string} the id, upper case, or "".
 */
function cleanPafId(v) {
  const id = String(v == null ? "" : v).trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(id) ? id : "";
}

/**
 * A date as AccuZIP writes it. PURE.
 * @param {Date} d the date (its UTC day).
 * @return {string} MM/DD/YYYY.
 */
function mmddyyyy(d) {
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/` +
    `${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

/**
 * The QUOTE settings for a run on the shop's Marketing Mail permit. PURE.
 * @param {object} s the shop's mailing settings (REQUIRED_SETTINGS).
 * @param {object} job {piece: the product's mail piece (see
 *   POSTCARD_PIECE), pafId: the list owner's PAF id, mailingDate: Date,
 *   moveUpdateDate: Date NCOALink runs (today), jobId, title,
 *   preparedFor}.
 * @return {object} the JSON to PUT.
 * @throws {Error} naming every missing setting, or when the piece or the
 *   PAF is missing: no presort claims NCOALink without one.
 */
function presortSettings(s, job) {
  const cfg = s || {};
  const missing = REQUIRED_SETTINGS.filter((k) => !String(cfg[k] || "")
      .trim());
  if (missing.length) {
    throw new Error(`Mailing settings missing: ${missing.join(", ")}`);
  }
  const piece = job.piece || {};
  const dims = ["heightIn", "lengthIn", "thicknessIn", "weightOz"];
  if (!PIECE_SIZES.includes(piece.size) ||
      !dims.every((k) => Number(piece[k]) > 0)) {
    throw new Error("No Marketing Mail piece size for this product");
  }
  const pafId = cleanPafId(job.pafId);
  if (!pafId) {
    throw new Error("No NCOALink PAF on file for the list owner");
  }
  const d = job.mailingDate instanceof Date ? job.mailingDate : new Date();
  const moved = job.moveUpdateDate instanceof Date ?
    job.moveUpdateDate : new Date();
  const digits = (v) => String(v).replace(/\D/g, "");
  return {
    "presort_class": "STANDARD MAIL",
    // Prepare it as Marketing Mail on our permit even under the minimums
    // (the runner stops for staff instead): never a quiet First-Class or
    // meter switch.
    "force_presort_class": "1",
    "mail_pay_method_override": "1",
    "drop_zip": digits(cfg.dropZip).slice(0, 5),
    "mail_piece_size": piece.size,
    "piece_height": String(piece.heightIn),
    "piece_length": String(piece.lengthIn),
    "thickness_value": String(piece.thicknessIn),
    "weight_value": String(piece.weightOz),
    "weight_unit": "OUNCES",
    "machinability": "MACHINABLE",
    "tray_type": "MMM",
    "calculate_container_volume": "1",
    "print_barcode": "1",
    "print_imb": cfg.fullService ? "1" : "0",
    "include_non_zip4": "0",
    "include_crrt": "1",
    "mail_permit_type": "PROFIT",
    "mail_pay_method": "IMPRINT",
    "mail_permit_number": String(cfg.permitNumber),
    "permit_holder_name_address": String(cfg.permitHolder),
    "permit_holder_mailer_id": digits(cfg.mailerId),
    "permit_holder_crid": digits(cfg.crid),
    "mailing_agent_mailer_id": digits(cfg.mailerId),
    "mailing_agent_crid": digits(cfg.crid),
    "mailing_agent_edoc_sender_crid": digits(cfg.crid),
    "imb_default_mid": digits(cfg.mailerId),
    "imb_service_type": digits(cfg.serviceTypeId),
    "agent_or_mailer_signing_statement": String(cfg.signerName),
    "agent_or_mailer_company": String(cfg.signerCompany),
    "agent_or_mailer_phone": digits(cfg.signerPhone).slice(-10),
    "agent_or_mailer_email": String(cfg.signerEmail),
    "prepared_for_name_address": String(job.preparedFor || ""),
    "statement_number": "1",
    "mailing_date": mmddyyyy(d),
    // Move Update by NCOALink, run by this very job (presortProcess).
    "move_update_method": "NCOALink",
    "move_update_method_date": mmddyyyy(moved),
    "list_owner_paf_id": pafId,
    "ncoalink_off": "0",
    "coa_flag_only": "1",
    ...Object.fromEntries(NCOA_LEFT_OUT.map((n) => [`filter_ncoa_${n}`,
      "1"])),
    "maildat_jobid": String(job.jobId || "").replace(/[^A-Za-z0-9]/g, "")
        .slice(-8),
    "maildat_jobtitle": String(job.title || "").slice(0, 30),
    "presort_output_type": "csv",
    "presort_include_tags": "1",
    "pdf_embed_fonts": "1",
    "format": "UPPER",
  };
}

/**
 * The AccuZIP process to run: CASS, NCOALink (people who moved), then the
 * presort. NCOALink legally needs the list owner's PAF on file with
 * AccuZIP, and Move Update needs NCOALink, so without a PAF there is no
 * process to run. PURE.
 * @param {?string} pafId the list owner's AccuZIP PAF id.
 * @return {string} the process path segment.
 * @throws {Error} without a PAF id.
 */
function presortProcess(pafId) {
  if (!cleanPafId(pafId)) {
    throw new Error("No NCOALink PAF on file for the list owner");
  }
  return "CASS-NCOA-PRESORT";
}

/**
 * Whether a finished job is the one we asked for, read from its QUOTE
 * BEFORE anything is downloaded (the download is what AccuZIP bills).
 * PURE.
 * @param {object} q the finished QUOTE JSON.
 * @param {string} process the process we started (presortProcess()).
 * @return {{pieces: ?number, problem: string}} pieces: how many made the
 *   presort (null when AccuZIP didn't say); problem: why staff must
 *   decide how this mails, or "" when it's good to download.
 */
function presortOutcome(q, process) {
  const r = q || {};
  const up = (v) => String(v == null ? "" : v).trim().toUpperCase();
  const n = parseInt(String(r.total_presort_records || "")
      .replace(/,/g, ""), 10);
  const pieces = Number.isFinite(n) ? n : null;
  let problem = "";
  if (up(r.task_process) && up(r.task_process) !== up(process)) {
    problem = `AccuZIP ran ${up(r.task_process)}, not ${up(process)}`;
  } else if (up(r.presort_class) && up(r.presort_class) !== "STANDARD MAIL") {
    problem = `AccuZIP prepared it as ${up(r.presort_class)}, not ` +
      "Marketing Mail";
  } else if (up(r.mail_pay_method) && up(r.mail_pay_method) !== "IMPRINT") {
    problem = `AccuZIP moved its postage to ${up(r.mail_pay_method)}, ` +
      "not our permit imprint";
  } else if (pieces !== null && pieces < PRESORT_MIN_PIECES) {
    problem = tooFewPieces(pieces);
  }
  return {pieces, problem};
}

/**
 * Why a run that's under the minimum stops. PURE.
 * @param {number} pieces how many would mail.
 * @return {string} the reason.
 */
function tooFewPieces(pieces) {
  return `only ${pieces} pieces made the presort once bad and moved ` +
    `addresses were left out, under the ${PRESORT_MIN_PIECES}-piece ` +
    "Marketing Mail minimum";
}

/**
 * Parse a CSV file (quoted fields, "" escapes, CRLF or LF rows). PURE.
 * @param {string} text the file.
 * @return {Array<object>} one object per data row, keyed by the header
 *   row in lower case.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text || "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === "\"") {
        if (src[i + 1] === "\"") {
          field += "\"";
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => {
      o[h] = (r[i] || "").trim();
    });
    return o;
  });
}

/**
 * What the presorted file says about each recipient. PURE.
 *
 * A recipient missing from the file was dropped by the presort (no ZIP+4,
 * or NCOALink found they moved): it doesn't mail.
 * @param {Array<object>} rows parseCsv() of AccuZIP's print-ready CSV.
 * @param {Array<string>} sentIds every id that was uploaded.
 * @return {{updates: Map<string, object>, dropped: Array<string>}}
 *   updates: id → {sequence, endorse, imb, trayBreak, containerId,
 *   mailAddress}.
 */
function presortUpdates(rows, sentIds) {
  const updates = new Map();
  for (const r of rows || []) {
    const id = r[ID_COLUMN];
    if (!id) continue;
    const seq = parseInt(r.sequence, 10);
    const zip = r.zip4 && r.zip && !r.zip.includes("-") ?
      `${r.zip}-${r.zip4}` : r.zip;
    updates.set(id, {
      sequence: Number.isFinite(seq) ? seq : null,
      endorse: r.endorse || "",
      imb: r.imbarcode || "",
      trayBreak: Boolean(r.traymark_),
      containerId: r.cont_id || "",
      mailAddress: {
        line1: r.address || "",
        line2: r.address2 || "",
        city: r.city || "",
        state: r.st || "",
        zip: zip || "",
      },
    });
  }
  const dropped = (sentIds || []).filter((id) => !updates.has(id));
  return {updates, dropped};
}

/**
 * A thin AccuZIP Direct Mail (ws_360) client. Every call goes through
 * the injected fetch, so the request shapes are tested without a network.
 */
class AccuzipCloud {
  /**
   * @param {object} o {apiKey, fetchImpl?, base?}.
   */
  constructor(o) {
    this.apiKey = String((o && o.apiKey) || "");
    this.fetch = (o && o.fetchImpl) || fetch;
    this.base = (o && o.base) || PRESORT_BASE;
  }

  /**
   * The job URL for a step.
   * @param {string} guid the job.
   * @param {string} step e.g. QUOTE.
   * @return {string} the URL.
   */
  jobUrl(guid, step) {
    return `${this.base}/servoy-service/rest_ws/ws_360/v2_0/job/` +
      `${encodeURIComponent(guid)}/${step}`;
  }

  /**
   * JSON from a response, or a clear error (never the body: AccuZIP
   * echoes the API key in its error messages).
   * @param {object} res the fetch response.
   * @param {string} what the call, for the error.
   * @return {Promise<object>} the JSON.
   */
  async json(res, what) {
    if (!res.ok) throw new Error(`AccuZIP ${what}: HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.success === false) {
      throw new Error(`AccuZIP ${what} refused`);
    }
    return data || {};
  }

  /**
   * Upload the run; the field order matters to AccuZIP.
   * @param {string} csv presortCsv().
   * @param {string} fileName must end in .csv.
   * @param {string} callbackUrl AccuZIP GETs it with ?guid= when done.
   * @return {Promise<string>} the job guid.
   */
  async upload(csv, fileName, callbackUrl) {
    const form = new FormData();
    form.append("backOfficeOption", "json");
    form.append("apiKey", this.apiKey);
    form.append("callbackURL", callbackUrl || "");
    form.append("guid", "");
    form.append("file", new Blob([csv], {type: "text/csv"}),
        String(fileName).endsWith(".csv") ? fileName : `${fileName}.csv`);
    const res = await this.fetch(`${this.base}/ws_360_webapps/v2_0/` +
      "uploadProcess.jsp?manual_submit=false", {method: "POST", body: form});
    const data = await this.json(res, "upload");
    if (!data.guid) throw new Error("AccuZIP upload: no job id");
    return String(data.guid);
  }

  /**
   * The job's quote/status.
   * @param {string} guid the job.
   * @return {Promise<object>} the QUOTE JSON (task_state FINISHED when a
   *   process is done).
   */
  async quote(guid) {
    return this.json(await this.fetch(this.jobUrl(guid, "QUOTE")), "quote");
  }

  /**
   * The quote, or null while AccuZIP is still building it. For the first
   * ~15s after an upload QUOTE answers {success: false, message: "QUOTE
   * is still processing."} — not a failure, just not ready.
   * @param {string} guid the job.
   * @return {Promise<?object>} the QUOTE JSON, or null when not ready.
   */
  async quoteIfReady(guid) {
    const res = await this.fetch(this.jobUrl(guid, "QUOTE"));
    if (!res.ok) throw new Error(`AccuZIP quote: HTTP ${res.status}`);
    const data = await res.json();
    return data && data.success === false ? null : (data || {});
  }

  /**
   * Set the presort settings.
   * @param {string} guid the job.
   * @param {object} settings presortSettings().
   * @return {Promise<void>}
   */
  async updateQuote(guid, settings) {
    const res = await this.fetch(this.jobUrl(guid, "QUOTE"), {
      method: "PUT",
      headers: {"Content-Type": "application/json",
        "Accept": "application/json"},
      body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error(`AccuZIP settings: HTTP ${res.status}`);
  }

  /**
   * Start a process (async: AccuZIP calls back when it's done).
   * @param {string} guid the job.
   * @param {string} process presortProcess().
   * @return {Promise<object>} AccuZIP's reply.
   */
  async process(guid, process) {
    return this.json(await this.fetch(this.jobUrl(guid, process)),
        process);
  }

  /**
   * Download a finished file. The first download of a job is what
   * AccuZIP bills.
   * @param {string} guid the job.
   * @param {string} ftype csv | pdf | maildat.zip.
   * @return {Promise<Buffer>} the file.
   */
  async download(guid, ftype) {
    const res = await this.fetch(`${this.base}/ws_360_webapps/v2_0/` +
      `download.jsp?guid=${encodeURIComponent(guid)}` +
      `&ftype=${encodeURIComponent(ftype)}`);
    if (!res.ok) throw new Error(`AccuZIP download ${ftype}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // A missing file comes back as HTTP 200 with a JSON error body.
    if (buf.subarray(0, 40).toString("utf8").replace(/\s/g, "")
        .startsWith("{\"success\":false")) {
      throw new Error(`AccuZIP download ${ftype}: not available`);
    }
    return buf;
  }
}

module.exports = {
  PRESORT_BASE,
  PRESORT_MIN_PIECES,
  ID_COLUMN,
  POSTCARD_PIECE,
  PIECE_SIZES,
  NCOA_LEFT_OUT,
  REQUIRED_SETTINGS,
  needsPresort,
  cleanPafId,
  presortCsv,
  presortSettings,
  presortProcess,
  presortOutcome,
  tooFewPieces,
  parseCsv,
  presortUpdates,
  AccuzipCloud,
};
