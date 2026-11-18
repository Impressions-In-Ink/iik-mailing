/**
 * accuzipPresort.test.js — a mailing, presorted for USPS Marketing Mail
 *
 * The presort decides the postage rate and the order the shop floor trays
 * cards in, and its barcode is what the USPS machines read. Pinned here:
 * the upload file AccuZIP gets, the settings that claim our permit and
 * NCOALink (only ever with a PAF, never a silent class or meter switch),
 * the check of a finished job before its billed download, the mapping of
 * the presorted file back to each recipient (and who it dropped), and the
 * exact requests the cloud client sends.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PRESORT_MIN_PIECES,
  ID_COLUMN,
  POSTCARD_PIECE,
  NCOA_LEFT_OUT_FORWARDING,
  needsPresort,
  cleanPafId,
  cleanNonprofitAuth,
  cleanPermitNumber,
  checkClientPermit,
  presortCsv,
  presortSettings,
  presortProcess,
  presortOutcome,
  parseCsv,
  presortUpdates,
  AccuzipCloud,
} = require("../src/presort");

const SETTINGS = {
  permitNumber: "1234",
  mailerId: "901234",
  crid: "12345678",
  dropZip: "97230",
  serviceTypeId: "300",
  permitHolder: "Impressions in Ink|123 Main St|Portland OR 97230",
  signerName: "Pat Mailer",
  signerCompany: "Impressions in Ink",
  signerPhone: "(503) 555-0100",
  signerEmail: "mail@impressions.co",
};

test("only runs of 200+ are presorted", () => {
  assert.equal(PRESORT_MIN_PIECES, 200);
  assert.equal(needsPresort(199), false);
  assert.equal(needsPresort(200), true);
});

test("the upload file is AccuZIP's columns plus our id, CRLF", () => {
  const csv = presortCsv([
    {id: "c1", data: {name: "Ann \"Annie\" Lee", company: "Acme, Inc",
      line1: "typed", mailAddress: {line1: "1 A St", line2: "",
        city: "Portland", state: "OR", zip: "97201-1234"}}},
    {id: "c2", data: {name: "Bo", company: "Bo", line1: "2 B St",
      city: "Salem", state: "OR", zip: "97301"}},
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0],
      `"${ID_COLUMN}","first","company","address","address2","city",` +
      "\"st\",\"zip\"");
  assert.equal(lines[1], "\"c1\",\"Ann \"\"Annie\"\" Lee\",\"Acme, Inc\"," +
      "\"1 A St\",\"\",\"Portland\",\"OR\",\"97201-1234\"",
  "the USPS-checked address, quotes and commas safe");
  assert.match(lines[2], /^"c2","Bo","","2 B St",/,
      "a company that's just the name isn't repeated");
  assert.equal(lines[3], "", "every row ends in CRLF");
});

/** A 4x6 postcard job for the list owner with PAF X01234. */
const JOB = Object.freeze({piece: POSTCARD_PIECE, pafId: "X01234"});

test("the settings claim our Marketing Mail permit for a 4x6", () => {
  const s = presortSettings(SETTINGS, {...JOB,
    mailingDate: new Date(Date.UTC(2026, 9, 20)),
    moveUpdateDate: new Date(Date.UTC(2026, 9, 15)),
    jobId: "order_AbC-123xyz", title: "Spring postcard",
    preparedFor: "Rose City Plumbing"});
  assert.equal(s.presort_class, "STANDARD MAIL");
  assert.equal(s.mail_piece_size, "LETTER", "Marketing Mail has no card " +
    "rate; a 4x6 mails as a letter");
  assert.equal(s.piece_height, "4");
  assert.equal(s.piece_length, "6");
  assert.equal(s.mail_pay_method, "IMPRINT");
  assert.equal(s.mail_permit_number, "1234");
  assert.equal(s.imb_default_mid, "901234");
  assert.equal(s.imb_service_type, "300");
  assert.equal(s.agent_or_mailer_phone, "5035550100");
  assert.equal(s.mailing_date, "10/20/2026");
  assert.equal(s.maildat_jobid, "bC123xyz",
      "Mail.dat job ids are 8 alphanumerics at most");
  assert.equal(s.print_imb, "0", "basic IMb unless full-service is set");
  assert.equal(presortSettings({...SETTINGS, fullService: true},
      JOB).print_imb, "1");
});

test("never a silent switch to First-Class or metered postage", () => {
  const s = presortSettings(SETTINGS, JOB);
  assert.equal(s.force_presort_class, "1",
      "under the minimums AccuZIP would quietly go First-Class");
  assert.equal(s.mail_pay_method_override, "1",
      "and DMM 604.5.1.2 would quietly move it to a meter");
});

test("Move Update is claimed as NCOALink, under the list owner's PAF",
    () => {
      const s = presortSettings(SETTINGS, {...JOB,
        moveUpdateDate: new Date(Date.UTC(2026, 10, 2))});
      assert.equal(s.move_update_method, "NCOALink");
      assert.equal(s.move_update_method_date, "11/02/2026",
          "the day NCOALink runs, as AccuZIP writes dates");
      assert.equal(s.list_owner_paf_id, "X01234");
      assert.equal(s.ncoalink_off, "0");
      assert.equal(s.coa_flag_only, "1",
          "a piece that mails keeps the address it prints with");
      for (const n of ["01", "02", "03", "04", "05", "77"]) {
        assert.equal(s[`filter_ncoa_${n}`], "1",
            `NCOALink result ${n} (a mover) is left out`);
      }
      assert.equal("filter_ncoa_06" in s, false,
          "match TYPES aren't result filters");
      assert.equal("moveUpdateMethod" in SETTINGS, false);
      assert.equal(presortSettings({...SETTINGS, moveUpdateMethod: "ACS"},
          JOB).move_update_method, "NCOALink",
      "no setting claims a Move Update method this job doesn't run");
    });

test("forwarding movers: a new address mails there, the rest stay out",
    () => {
      const s = presortSettings(SETTINGS, {...JOB, forwardMovers: true});
      assert.equal(s.coa_flag_only, "0",
          "AccuZIP writes the new address into the address fields");
      assert.equal(s.filter_ncoa_01, "0", "a mover with a new address mails");
      assert.equal(s.filter_ncoa_05, "0", "a move to a new state too");
      for (const n of ["02", "03", "04", "77"]) {
        assert.equal(s[`filter_ncoa_${n}`], "1",
            `NCOALink result ${n} has no address to mail to`);
      }
      assert.deepEqual([...NCOA_LEFT_OUT_FORWARDING],
          ["02", "03", "04", "77"]);
      assert.equal(s.move_update_method, "NCOALink",
          "still the same Move Update claim");
      assert.equal(presortSettings(SETTINGS, {...JOB, forwardMovers: "yes"})
          .coa_flag_only, "1", "only a real true turns it on");
    });

test("nonprofit prices only for a named, authorized organization", () => {
  const np = {name: "  Helping   Hands ", authNumber: " 12-3456 ",
    address: "100 Main St, Portland OR 97202"};
  const s = presortSettings(SETTINGS, {...JOB, preparedFor: "Shop",
    nonprofit: np});
  assert.equal(s.mail_permit_type, "NONPROFIT");
  assert.equal(s.prepared_for_nonprofit_authorization_number, "123456");
  assert.equal(s.prepared_for_name_address,
      "Helping Hands | 100 Main St, Portland OR 97202",
      "the statement names the organization the mailing is prepared for");
  assert.equal(presortSettings(SETTINGS, {...JOB, nonprofit: {
    name: "Helping Hands", authNumber: "123456"}}).prepared_for_name_address,
  "Helping Hands", "the address is optional");

  const c = presortSettings(SETTINGS, {...JOB, preparedFor: "Shop"});
  assert.equal(c.mail_permit_type, "PROFIT", "commercial unless asked");
  assert.equal(c.prepared_for_name_address, "Shop");
  assert.equal("prepared_for_nonprofit_authorization_number" in c, false);

  for (const bad of [{name: "Helping Hands"}, {authNumber: "123456"},
    {name: "Helping Hands", authNumber: "12345678901"},
    {name: " ", authNumber: "123456"}]) {
    assert.throws(() => presortSettings(SETTINGS, {...JOB, nonprofit: bad}),
        /nonprofit/, JSON.stringify(bad));
  }
  assert.equal(cleanNonprofitAuth(" ab 12-34 "), "AB1234");
  assert.equal(cleanNonprofitAuth("12.34"), "");
  assert.equal(cleanNonprofitAuth(undefined), "");
});

/** A client's own permit, as staff typed it (made-up values). */
const THEIR_PERMIT = Object.freeze({number: " Permit #  567 ",
  holderName: "  Helping Hands ", holderAddress: "100 Main St,  Salem OR",
  crid: "8765-4321", dropZip: "97301", mailerId: "", phone: "",
  nonprofitAuth: ""});

test("a client's permit pays and is entered where it's held", () => {
  const s = presortSettings(SETTINGS, {...JOB, permit: THEIR_PERMIT});
  assert.equal(s.mail_permit_number, "567");
  assert.equal(s.permit_holder_name_address,
      "Helping Hands|100 Main St, Salem OR");
  assert.equal(s.permit_holder_crid, "87654321");
  assert.equal(s.permit_holder_mailer_id, "", "no Mailer ID is no claim");
  assert.equal(s.drop_zip, "97301",
      "a permit imprint account lives at one post office");
  assert.equal(s.mail_pay_method, "IMPRINT");
  assert.equal("permit_holder_phone" in s, false);
  assert.equal("permit_holder_nonprofit_authorization_number" in s, false);
  // The shop still prepares it: the agent and the barcodes stay ours.
  assert.equal(s.mailing_agent_crid, "12345678");
  assert.equal(s.mailing_agent_mailer_id, "901234");
  assert.equal(s.mailing_agent_edoc_sender_crid, "12345678");
  assert.equal(s.imb_default_mid, "901234");

  const full = presortSettings(SETTINGS, {...JOB, permit: {...THEIR_PERMIT,
    mailerId: "902 345", phone: "1 (503) 555-0199", nonprofitAuth: "12-34"},
  nonprofit: {name: "Helping Hands", authNumber: "1234"}});
  assert.equal(full.permit_holder_mailer_id, "902345");
  assert.equal(full.permit_holder_phone, "5035550199");
  assert.equal(full.permit_holder_nonprofit_authorization_number, "1234");
  assert.equal(full.mail_permit_type, "NONPROFIT");

  const ours = presortSettings(SETTINGS, JOB);
  assert.equal(ours.mail_permit_number, "1234", "ours unless asked");
  assert.equal(ours.drop_zip, "97230");
  assert.equal(ours.permit_holder_crid, "12345678");
  assert.equal(ours.permit_holder_name_address, SETTINGS.permitHolder);
});

test("a client permit that doesn't check out never presorts", () => {
  for (const [bad, why] of [
    [{number: ""}, /permit number/],
    [{number: "12345678901"}, /permit number/],
    [{holderName: " "}, /permit holder's name/],
    [{holderAddress: ""}, /mailing address/],
    [{crid: "12"}, /CRID/],
    [{dropZip: "9730"}, /5-digit ZIP/],
    [{mailerId: "1234567"}, /Mailer ID/],
    [{phone: "555-0100"}, /phone/],
    [{nonprofitAuth: "12.34"}, /nonprofit authorization/],
  ]) {
    const p = {...THEIR_PERMIT, ...bad};
    assert.match(checkClientPermit(p).problem, why, JSON.stringify(bad));
    assert.throws(() => presortSettings(SETTINGS, {...JOB, permit: p}),
        /Client permit/, JSON.stringify(bad));
  }
  assert.equal(checkClientPermit(null).problem,
      "Enter the client's permit number.");
  assert.equal(cleanPermitNumber("No. 1891"), "1891");
  assert.equal(cleanPermitNumber("#1891"), "1891");
  assert.equal(cleanPermitNumber("PERMIT NO 77"), "77");
  assert.equal(cleanPermitNumber("12.5"), "");
});

test("no PAF on file, no NCOALink claim and no process", () => {
  // Not a PAF id: nothing, words, punctuation, longer than the USPS id's
  // six licensee characters (the AccuZIP account number, the whole
  // 18-character USPS id).
  for (const pafId of [null, "", "  ", "not a paf", "X01234X", "AB-123",
    "AB 123", "1234567890", "ACZ1561499520AB123"]) {
    assert.throws(() => presortSettings(SETTINGS, {...JOB, pafId}),
        /PAF/, `PAF ${JSON.stringify(pafId)}`);
    assert.throws(() => presortProcess(pafId), /PAF/,
        "and never a quiet CASS-PRESORT without NCOALink");
  }
  assert.equal(presortProcess("X01234"), "CASS-NCOA-PRESORT");
  assert.equal(presortProcess(" e00001 "), "CASS-NCOA-PRESORT");
  assert.equal(cleanPafId(" e00001 "), "E00001");
  assert.equal(cleanPafId(undefined), "");
});

test("AccuZIP's PAF ids aren't padded to six: five characters is one", () => {
  // AccuZIP has issued ids of five and of six characters (2026-11).
  assert.equal(cleanPafId(" ab123 "), "AB123");
  assert.equal(cleanPafId("CD4567"), "CD4567");
  assert.equal(presortProcess("AB123"), "CASS-NCOA-PRESORT");
  assert.equal(presortSettings(SETTINGS, {...JOB, pafId: "ab123"})
      .list_owner_paf_id, "AB123");
});

test("the piece comes from the product, as a Marketing Mail size", () => {
  const flat = {size: "FLAT", heightIn: 9, lengthIn: 12, thicknessIn: 0.02,
    weightOz: 1.1};
  const s = presortSettings(SETTINGS, {...JOB, piece: flat});
  assert.equal(s.mail_piece_size, "FLAT");
  assert.equal(s.piece_height, "9");
  assert.equal(s.weight_value, "1.1");
  assert.throws(() => presortSettings(SETTINGS, {...JOB, piece: null}),
      /piece size/, "no default to the 4x6");
  assert.throws(() => presortSettings(SETTINGS, {...JOB,
    piece: {...POSTCARD_PIECE, size: "CARD"}}), /piece size/,
  "CARD is First-Class only");
  assert.throws(() => presortSettings(SETTINGS, {...JOB,
    piece: {...POSTCARD_PIECE, weightOz: 0}}), /piece size/);
});

test("a presort never runs on half-filled settings", () => {
  assert.throws(() => presortSettings({...SETTINGS, permitNumber: "",
    mailerId: " "}, JOB), /permitNumber, mailerId/);
});

// ── the finished job, before its billed download ──────────────────────

test("a finished job is checked before anything is downloaded", () => {
  const ok = {task_state: "FINISHED", task_process: "CASS-NCOA-PRESORT",
    presort_class: "STANDARD MAIL", mail_pay_method: "IMPRINT",
    total_presort_records: "1,204"};
  assert.deepEqual(presortOutcome(ok, "CASS-NCOA-PRESORT"),
      {pieces: 1204, problem: ""});
  assert.deepEqual(presortOutcome({task_state: "FINISHED"},
      "CASS-NCOA-PRESORT"), {pieces: null, problem: ""},
  "fields AccuZIP leaves out don't stop it");

  const at200 = presortOutcome({...ok, total_presort_records: "200"},
      "CASS-NCOA-PRESORT");
  assert.equal(at200.problem, "");
  const under = presortOutcome({...ok, total_presort_records: "199"},
      "CASS-NCOA-PRESORT");
  assert.equal(under.pieces, 199);
  assert.match(under.problem, /only 199 pieces .* 200-piece Marketing Mail/);

  assert.match(presortOutcome({...ok, presort_class: "FIRST CLASS"},
      "CASS-NCOA-PRESORT").problem, /as FIRST CLASS, not Marketing Mail/);
  assert.match(presortOutcome({...ok, mail_pay_method: "METER"},
      "CASS-NCOA-PRESORT").problem, /postage to METER/);
  assert.match(presortOutcome({...ok, task_process: "CASS-PRESORT"},
      "CASS-NCOA-PRESORT").problem, /ran CASS-PRESORT, not CASS-NCOA/,
  "a run without NCOALink never mails on an NCOALink claim");
  assert.equal(presortOutcome({...ok, presort_class: "standard mail"},
      "cass-ncoa-presort").problem, "", "case doesn't matter");
});

test("the finished job is priced at the rate we asked for", () => {
  const done = {task_state: "FINISHED", task_process: "CASS-NCOA-PRESORT",
    presort_class: "STANDARD MAIL", mail_pay_method: "IMPRINT",
    mail_permit_type: "PROFIT", total_presort_records: "500"};
  assert.equal(presortOutcome(done, "CASS-NCOA-PRESORT").problem, "");
  assert.match(presortOutcome(done, "CASS-NCOA-PRESORT",
      {nonprofit: true}).problem,
  /as commercial Marketing Mail, not nonprofit/);
  const np = {...done, mail_permit_type: "NONPROFIT"};
  assert.equal(presortOutcome(np, "CASS-NCOA-PRESORT", {nonprofit: true})
      .problem, "");
  assert.match(presortOutcome(np, "CASS-NCOA-PRESORT").problem,
      /as nonprofit Marketing Mail, not commercial/,
  "never a quiet switch to nonprofit prices either");
});

test("the finished job mails on the permit we asked for", () => {
  const done = {task_state: "FINISHED", task_process: "CASS-NCOA-PRESORT",
    presort_class: "STANDARD MAIL", mail_pay_method: "IMPRINT",
    mail_permit_number: "567", total_presort_records: "500"};
  assert.equal(presortOutcome(done, "CASS-NCOA-PRESORT",
      {permitNumber: "#567"}).problem, "");
  assert.equal(presortOutcome(done, "CASS-NCOA-PRESORT").problem, "",
      "no permit asked about, none checked");
  assert.match(presortOutcome(done, "CASS-NCOA-PRESORT",
      {permitNumber: "1234"}).problem, /on permit 567, not 1234/);
  assert.equal(presortOutcome({...done, mail_permit_number: ""},
      "CASS-NCOA-PRESORT", {permitNumber: "1234"}).problem, "",
  "a field AccuZIP leaves out doesn't stop it");
});

test("CSV parsing survives quotes, commas, CRLF and blank lines", () => {
  const rows = parseCsv("\"A\",\"B\"\r\n\"x, y\",\"say \"\"hi\"\"\"\r\n\r\n" +
    "plain,\n");
  assert.deepEqual(rows, [{a: "x, y", b: "say \"hi\""},
    {a: "plain", b: ""}]);
  assert.deepEqual(parseCsv(""), []);
});

test("the presorted file maps back to each recipient, in mail order", () => {
  const out = parseCsv([
    `"${ID_COLUMN}","address","address2","city","st","zip","zip4",` +
      "\"sequence\",\"endorse\",\"imbarcode\",\"traymark_\",\"cont_id\"",
    "\"c2\",\"2 B ST\",\"\",\"SALEM\",\"OR\",\"97301\",\"0001\",\"1\"," +
      "\"AUTO**ECRLOT**C001\",\"ADFT\",\"**\",\"1\"",
    "\"c1\",\"1 A ST\",\"APT 4\",\"PORTLAND\",\"OR\",\"97201\",\"1234\"," +
      "\"2\",\"AUTO**5-DIGIT 97201\",\"TFDA\",\"\",\"1\"",
  ].join("\r\n"));
  const {updates, dropped} = presortUpdates(out, ["c1", "c2", "c3"]);
  assert.equal(updates.get("c2").sequence, 1);
  assert.equal(updates.get("c2").trayBreak, true);
  assert.equal(updates.get("c1").endorse, "AUTO**5-DIGIT 97201");
  assert.equal(updates.get("c1").imb, "TFDA");
  assert.deepEqual(updates.get("c1").mailAddress, {line1: "1 A ST",
    line2: "APT 4", city: "PORTLAND", state: "OR", zip: "97201-1234"});
  assert.deepEqual(dropped, ["c3"], "missing from the file = not mailed");
});

// ── the cloud client's requests ───────────────────────────────────────

/**
 * A fetch that records every call and answers from a script.
 * @param {Array<object>} replies responses, in order.
 * @return {object} {fetchImpl, calls}.
 */
function scripted(replies) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({url, init: init || {}});
    const r = replies[i++] || {json: {success: true}};
    return {ok: r.status ? r.status < 400 : true, status: r.status || 200,
      json: async () => r.json,
      arrayBuffer: async () => new TextEncoder().encode(r.text || "")
          .buffer};
  };
  return {fetchImpl, calls};
}

test("upload sends AccuZIP's fields in order and returns the job", async () => {
  const {fetchImpl, calls} = scripted([{json: {success360Import: true,
    guid: "g-1"}}]);
  const az = new AccuzipCloud({apiKey: "KEY", fetchImpl});
  const guid = await az.upload("\"a\"\r\n", "order_1",
      "https://impulse.impressions.co/api/accuzip");
  assert.equal(guid, "g-1");
  assert.match(calls[0].url,
      /ws_360_webapps\/v2_0\/uploadProcess\.jsp\?manual_submit=false$/);
  const keys = [...calls[0].init.body.keys()];
  assert.deepEqual(keys, ["backOfficeOption", "apiKey", "callbackURL",
    "guid", "file"]);
  assert.equal(calls[0].init.body.get("file").name, "order_1.csv",
      "AccuZIP ignores any file not named .csv");
});

test("settings, process and download hit the job's URLs", async () => {
  const {fetchImpl, calls} = scripted([{json: {}}, {json: {success: true}},
    {json: {task_state: "FINISHED"}}, {text: "pdf"}]);
  const az = new AccuzipCloud({apiKey: "KEY", fetchImpl});
  await az.updateQuote("g 1", {presort_class: "STANDARD MAIL"});
  await az.process("g 1", "CASS-NCOA-PRESORT");
  const q = await az.quote("g 1");
  const pdf = await az.download("g 1", "pdf");
  assert.equal(calls[0].init.method, "PUT");
  assert.match(calls[0].url, /\/job\/g%201\/QUOTE$/);
  assert.match(calls[1].url, /\/job\/g%201\/CASS-NCOA-PRESORT$/);
  assert.equal(q.task_state, "FINISHED");
  assert.equal(calls[3].url, "https://cloud2.iaccutrace.com/ws_360_webapps/" +
    "v2_0/download.jsp?guid=g%201&ftype=pdf",
  "downloads sit under v2_0, like the upload (docs.accuzip.com)");
  assert.equal(pdf.toString(), "pdf");
});

test("an AccuZIP refusal never leaks its body (it echoes the key)",
    async () => {
      const {fetchImpl} = scripted([{json: {success: false,
        message: "submitted API_KEY not found SECRET-KEY"}}]);
      const az = new AccuzipCloud({apiKey: "SECRET-KEY", fetchImpl});
      await assert.rejects(az.quote("g"), (err) => {
        assert.doesNotMatch(err.message, /SECRET/);
        return true;
      });
    });
