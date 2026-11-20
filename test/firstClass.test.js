/**
 * firstClass.test.js — a mailing presorted as First-Class Mail
 *
 * Marketing Mail stays the default; a caller asks for First-Class with
 * job.mailClass. Pinned here: which USPS shape a piece is priced as in
 * each class (a First-Class postcard is up to 6 x 9 in, Marketing Mail
 * has no postcard price), the settings a First-Class run sends (its
 * class, CARD, the matching First-Class barcode service type, no
 * nonprofit), and the check of a finished First-Class job (its class,
 * its piece size, its 500-piece minimum).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FIRST_CLASS,
  MARKETING_MAIL,
  FIRST_CLASS_MIN_PIECES,
  POSTCARD_PIECE,
  presortMinPieces,
  needsPresort,
  cardProblem,
  pieceShape,
  serviceTypeFor,
  presortSettings,
  eddmPresortSettings,
  presortOutcome,
  tooFewPieces,
} = require("../src/presort");

const SETTINGS = {
  permitNumber: "1234",
  mailerId: "901234",
  crid: "12345678",
  dropZip: "97230",
  serviceTypeId: "301",
  permitHolder: "Example Print Co|123 Main St|Portland OR 97230",
  signerName: "Pat Mailer",
  signerCompany: "Example Print Co",
  signerPhone: "(503) 555-0100",
  signerEmail: "mail@example.com",
};

/** A 5.5 x 8.5 card on 14pt stock. */
const HALF_SHEET = Object.freeze({heightIn: 5.5, lengthIn: 8.5,
  thicknessIn: 0.014, weightOz: 0.35});

const JOB = Object.freeze({pafId: "X01234", mailClass: FIRST_CLASS,
  piece: {...HALF_SHEET, size: "CARD"}});

// ── the shape a piece is priced as ────────────────────────────────────

test("a First-Class postcard runs up to 6 x 9 in, not just 4.25 x 6", () => {
  assert.equal(pieceShape(POSTCARD_PIECE, FIRST_CLASS), "CARD");
  assert.equal(pieceShape(HALF_SHEET, FIRST_CLASS), "CARD",
      "5.5 x 8.5 is a postcard at First-Class prices (DMM 201.1.2.1c)");
  assert.equal(pieceShape({heightIn: 6, lengthIn: 9, thicknessIn: 0.016},
      FIRST_CLASS), "CARD", "the limit itself");
  assert.equal(pieceShape({heightIn: 6, lengthIn: 11, thicknessIn: 0.014},
      FIRST_CLASS), "LETTER", "longer than 9 in is a letter");
  assert.equal(pieceShape({lengthIn: 5.5, heightIn: 8.5,
    thicknessIn: 0.014}, FIRST_CLASS), "CARD", "either way round");
});

test("Marketing Mail has no postcard price: a card is a letter", () => {
  assert.equal(pieceShape(POSTCARD_PIECE, MARKETING_MAIL), "LETTER");
  assert.equal(pieceShape(HALF_SHEET, MARKETING_MAIL), "LETTER");
  assert.equal(pieceShape(HALF_SHEET), "LETTER", "the default class");
  assert.equal(pieceShape({heightIn: 9, lengthIn: 12, thicknessIn: 0.02},
      FIRST_CLASS), "FLAT");
  assert.equal(pieceShape({heightIn: 4, lengthIn: 9, thicknessIn: 0.3},
      MARKETING_MAIL), "FLAT", "thicker than 1/4 in");
  assert.equal(pieceShape({}, FIRST_CLASS), "", "no size, no shape");
});

test("why a card doesn't get the postcard price", () => {
  assert.equal(cardProblem(HALF_SHEET), "");
  assert.match(cardProblem({...HALF_SHEET, thicknessIn: 0.02}),
      /0\.016 in thick/, "a heavy board stock pays the letter price");
  assert.match(cardProblem({...HALF_SHEET, thicknessIn: 0.008}),
      /over 4-1\/4 x 6 in is at least 0\.009/);
  assert.equal(cardProblem({...POSTCARD_PIECE, thicknessIn: 0.008}), "",
      "0.007 is enough up to 4.25 x 6");
  assert.match(cardProblem({heightIn: 3, lengthIn: 5, thicknessIn: 0.01}),
      /at least 3-1\/2 x 5/);
  assert.match(cardProblem({heightIn: 3.5, lengthIn: 9, thicknessIn: 0.01}),
      /1\.3 to 2\.5 times/, "too long for its height");
  assert.equal(cardProblem({heightIn: 4.25, lengthIn: 5.5,
    thicknessIn: 0.01}), "", "a quarter of an 11 x 8.5 sheet, at 1.294");
  assert.match(cardProblem({...HALF_SHEET, weightOz: 4}), /3\.5 oz/);
  assert.equal(cardProblem({...HALF_SHEET, weightOz: undefined}), "",
      "a weight left out isn't held against it");
});

// ── minimums ──────────────────────────────────────────────────────────

test("a First-Class presort needs 500 pieces", () => {
  assert.equal(FIRST_CLASS_MIN_PIECES, 500);
  assert.equal(presortMinPieces(FIRST_CLASS), 500);
  assert.equal(presortMinPieces(MARKETING_MAIL), 200);
  assert.equal(presortMinPieces(), 200);
  assert.equal(needsPresort(499, FIRST_CLASS), false);
  assert.equal(needsPresort(500, FIRST_CLASS), true);
  assert.equal(needsPresort(200), true, "Marketing Mail unchanged");
  assert.match(tooFewPieces(480, FIRST_CLASS),
      /only 480 pieces .* 500-piece First-Class minimum/);
  assert.match(tooFewPieces(150), /200-piece Marketing Mail minimum/);
});

// ── the settings ──────────────────────────────────────────────────────

test("a First-Class run asks AccuZIP for First-Class and a card", () => {
  const s = presortSettings(SETTINGS, JOB);
  assert.equal(s.presort_class, "FIRST CLASS");
  assert.equal(s.mail_piece_size, "CARD");
  assert.equal(s.piece_length, "8.5");
  assert.equal(s.force_presort_class, "1", "never a quiet switch");
  assert.equal(s.mail_permit_type, "PROFIT");
  assert.equal(s.tray_type, "MMM");
  assert.equal(s.list_owner_paf_id, "X01234", "Move Update still applies");
});

test("its barcodes carry the First-Class service type", () => {
  assert.equal(presortSettings(SETTINGS, JOB).imb_service_type, "300");
  assert.equal(presortSettings(SETTINGS, {...JOB, mailClass: undefined,
    piece: {...HALF_SHEET, size: "LETTER"}}).imb_service_type, "301",
  "Marketing Mail keeps the shop's setting");
  assert.equal(serviceTypeFor("301", FIRST_CLASS), "300");
  assert.equal(serviceTypeFor("311", FIRST_CLASS), "310");
  assert.equal(serviceTypeFor("261", FIRST_CLASS), "260");
  assert.equal(serviceTypeFor("271", FIRST_CLASS), "270");
  assert.equal(serviceTypeFor("300", FIRST_CLASS), "300",
      "a First-Class one already");
  assert.equal(serviceTypeFor(" 301 ", MARKETING_MAIL), "301");
  assert.throws(() => serviceTypeFor("090", FIRST_CLASS),
      /090 has no First-Class match/,
      "an address-correction service type isn't guessed at");
  assert.throws(() => presortSettings({...SETTINGS, serviceTypeId: "090"},
      JOB), /no First-Class match/);
});

test("a First-Class run takes letters and flats too", () => {
  const letter = presortSettings(SETTINGS, {...JOB,
    piece: {heightIn: 4.125, lengthIn: 9.5, thicknessIn: 0.05, weightOz: 1,
      size: "LETTER"}});
  assert.equal(letter.mail_piece_size, "LETTER");
  const flat = presortSettings(SETTINGS, {...JOB,
    piece: {heightIn: 9, lengthIn: 12, thicknessIn: 0.02, weightOz: 1.1,
      size: "FLAT"}});
  assert.equal(flat.mail_piece_size, "FLAT");
  assert.equal(flat.tray_type, "0MM", "AccuZIP's First-Class flat tray");
});

test("what a First-Class run refuses", () => {
  assert.throws(() => presortSettings(SETTINGS, {...JOB,
    piece: {...HALF_SHEET, thicknessIn: 0.02, size: "CARD"}}),
  /0\.016 in thick/, "a card that isn't a postcard isn't sent as CARD");
  assert.throws(() => presortSettings(SETTINGS, {...JOB,
    nonprofit: {name: "Example Org", authNumber: "123456"}}),
  /Marketing Mail only/);
  assert.throws(() => presortSettings(SETTINGS, {...JOB,
    mailClass: "PRIORITY"}), /No such mail class: PRIORITY/);
  assert.throws(() => presortSettings(SETTINGS, {...JOB,
    mailClass: MARKETING_MAIL}), /No Marketing Mail piece size/,
  "CARD stays First-Class only");
  assert.throws(() => eddmPresortSettings(SETTINGS, {mailClass: FIRST_CLASS,
    piece: {heightIn: 9, lengthIn: 12, thicknessIn: 0.02, weightOz: 1,
      size: "FLAT"}}), /EDDM is Marketing Mail/);
});

// ── the finished job ──────────────────────────────────────────────────

test("a finished First-Class job is checked as First-Class", () => {
  const ok = {task_state: "FINISHED", task_process: "CASS-NCOA-PRESORT",
    presort_class: "FIRST CLASS", mail_pay_method: "IMPRINT",
    mail_permit_type: "PROFIT", mail_piece_size: "CARD",
    total_presort_records: "4,412"};
  const opts = {mailClass: FIRST_CLASS, pieceSize: "CARD"};
  assert.deepEqual(presortOutcome(ok, "CASS-NCOA-PRESORT", opts),
      {pieces: 4412, problem: ""});
  assert.match(presortOutcome({...ok, presort_class: "STANDARD MAIL"},
      "CASS-NCOA-PRESORT", opts).problem,
  /as STANDARD MAIL, not First-Class Mail/);
  assert.match(presortOutcome(ok, "CASS-NCOA-PRESORT").problem,
      /as FIRST CLASS, not Marketing Mail/,
      "a Marketing Mail run AccuZIP switched still stops");
  assert.match(presortOutcome({...ok, mail_piece_size: "LETTER"},
      "CASS-NCOA-PRESORT", opts).problem,
  /as LETTER pieces, not CARD/, "never a quiet move off the card price");
  assert.equal(presortOutcome({...ok, mail_piece_size: ""},
      "CASS-NCOA-PRESORT", opts).problem, "",
  "a field AccuZIP leaves out doesn't stop it");
  assert.match(presortOutcome({...ok, total_presort_records: "499"},
      "CASS-NCOA-PRESORT", opts).problem,
  /only 499 pieces .* 500-piece First-Class minimum/);
  assert.equal(presortOutcome({...ok, presort_class: "STANDARD MAIL",
    total_presort_records: "499"}, "CASS-NCOA-PRESORT",
  {pieceSize: "CARD", mailClass: ""}).problem.includes("not CARD"), false,
  "the class is checked before the size");
});
