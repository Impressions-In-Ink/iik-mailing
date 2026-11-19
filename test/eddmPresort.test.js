/**
 * eddmPresort.test.js — the presort of an EDDM run picked on the map
 *
 * An EDDM run on a permit (BMEU) goes through AccuZIP's EDDM presort for
 * its postage statement, bundles and Mail.dat, like a list run, with
 * AccuZIP's EDDM class and carrier-route prices, a flat piece, and no
 * Move Update (no names, no addresses, so no PAF). Every value here is
 * made up.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EDDM_PROCESS,
  EDDM_CLASS,
  eddmPresortSettings,
  eddmPieceProblem,
  presortSettings,
  presortOutcome,
  AccuzipCloud,
} = require("../index");

const SETTINGS = {
  permitNumber: "1234",
  mailerId: "901234",
  crid: "12345678",
  dropZip: "97230",
  serviceTypeId: "300",
  permitHolder: "Example Print Shop|123 Main St|Portland OR 97230",
  signerName: "Pat Mailer",
  signerCompany: "Example Print Shop",
  signerPhone: "(503) 555-0100",
  signerEmail: "mail@example.com",
};

/** A 6.5 x 9 in EDDM postcard, 14pt. */
const FLAT = Object.freeze({size: "FLAT", heightIn: 6.5, lengthIn: 9,
  thicknessIn: 0.014, weightOz: 0.4});

test("EDDM pieces are flats within USPS limits", () => {
  assert.equal(eddmPieceProblem(FLAT), "");
  // Taller than 6.125 is enough; so is longer than 11.5 or thicker.
  assert.equal(eddmPieceProblem({...FLAT, heightIn: 4, lengthIn: 12}), "");
  assert.match(eddmPieceProblem({...FLAT, heightIn: 4.25, lengthIn: 6}),
      /flats: longer than 11.5 in, taller than 6.125 in/);
  assert.match(eddmPieceProblem({...FLAT, lengthIn: 16}),
      /at most 15 x 12 in/);
  assert.match(eddmPieceProblem({...FLAT, weightOz: 0}),
      /size, thickness and weight/);
});

test("the EDDM settings: EDDM class, carrier routes, no Move Update", () => {
  const s = eddmPresortSettings(SETTINGS, {piece: FLAT,
    mailingDate: new Date(Date.UTC(2026, 11, 3)), jobId: "job_8f2a91c4",
    title: "Spring EDDM", preparedFor: "Example Bakery"});
  assert.equal(s.presort_class, EDDM_CLASS);
  assert.equal(s.include_crrt, "1");
  assert.equal(s.include_non_zip4, "1");
  assert.equal(s.mail_piece_size, "FLAT");
  assert.equal(s.mail_pay_method, "IMPRINT");
  assert.equal(s.mail_permit_number, "1234");
  assert.equal(s.mailing_date, "12/03/2026");
  assert.equal(s.ncoalink_off, "1");
  for (const k of ["list_owner_paf_id", "move_update_method",
    "coa_flag_only", "filter_ncoa_01"]) {
    assert.equal(k in s, false, `${k} is for list runs`);
  }
  // Everything else is the list run's: same agent, same paperwork.
  const list = presortSettings(SETTINGS, {piece: FLAT, pafId: "X01234",
    mailingDate: new Date(Date.UTC(2026, 11, 3))});
  for (const k of ["mailing_agent_crid", "imb_service_type",
    "agent_or_mailer_email", "drop_zip", "tray_type"]) {
    assert.equal(s[k], list[k], k);
  }
  assert.equal(list.presort_class, "STANDARD MAIL");
  assert.equal(list.ncoalink_off, "0");
});

test("EDDM runs nonprofit and on a client's permit like a list run",
    () => {
      const s = eddmPresortSettings(SETTINGS, {piece: FLAT,
        nonprofit: {name: "Example Food Pantry", authNumber: "1234567"},
        permit: {number: "88", holderName: "Example Food Pantry",
          holderAddress: "1 Example Way, Salem OR 97301", crid: "55555",
          dropZip: "97301"}});
      assert.equal(s.mail_permit_type, "NONPROFIT");
      assert.equal(s.mail_permit_number, "88");
      assert.equal(s.drop_zip, "97301");
    });

test("an EDDM piece that isn't a flat never reaches AccuZIP", () => {
  assert.throws(() => eddmPresortSettings(SETTINGS,
      {piece: {...FLAT, size: "LETTER"}}), /EDDM pieces are flats/);
  assert.throws(() => eddmPresortSettings(SETTINGS,
      {piece: {...FLAT, heightIn: 4, lengthIn: 6}}), /flats: longer/);
  assert.throws(() => eddmPresortSettings({}, {piece: FLAT}),
      /Mailing settings missing/);
});

test("a finished EDDM job is checked for the EDDM class", () => {
  const ok = {task_process: EDDM_PROCESS, presort_class: EDDM_CLASS,
    mail_pay_method: "IMPRINT", mail_permit_type: "PROFIT",
    total_presort_records: "1,624", mail_permit_number: "1234"};
  assert.deepEqual(presortOutcome(ok, EDDM_PROCESS,
      {eddm: true, permitNumber: "1234"}), {pieces: 1624, problem: ""});
  assert.match(presortOutcome({...ok, presort_class: "STANDARD MAIL"},
      EDDM_PROCESS, {eddm: true}).problem, /not EDDM/);
  assert.match(presortOutcome(ok, "CASS-NCOA-PRESORT").problem,
      /ran CASS-NCOA-DUPS_01-PRESORT/);
  // A list run still expects Marketing Mail.
  assert.match(presortOutcome({...ok, task_process: "CASS-NCOA-PRESORT"},
      "CASS-NCOA-PRESORT").problem, /not Marketing Mail/);
});

test("the EDDM process uses AccuZIP's documented path", async () => {
  const calls = [];
  const cloud = new AccuzipCloud({apiKey: "k", fetchImpl: async (url) => {
    calls.push(url);
    return {ok: true, status: 200, json: async () => ({success: true})};
  }});
  await cloud.processEddm("26110897-04e6-4171-bfe6-2ef3db1c0bee");
  assert.equal(calls[0], "https://cloud2.iaccutrace.com/servoy-service/" +
    "rest_ws/ws_360/job/26110897-04e6-4171-bfe6-2ef3db1c0bee/" +
    "CASS-NCOA-DUPS_01-PRESORT");
});
