/**
 * Grading a CASS row.
 *
 * This logic graded mailing lists for months without a test of its own,
 * reachable only through the validateAddresses callable. Now that the
 * shipping station refuses to buy a label for an address it grades
 * undeliverable, the buckets are load-bearing for real money and get
 * pinned: the two mistakes that matter are calling a good address bad
 * (a parcel that never ships) and calling a bad one good (a parcel that
 * comes back).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCorrectionsAndSubstantive,
  buildWarnings,
  deriveStatus,
  classifyCassRow,
} = require("../src/classify");

const CLEAN = {
  dadl1: "3181 SW Sam Jackson Park Rd", dctys: "Portland", dstaa: "OR",
  zipc: "97239", addon: "3011", DPVA: "Y", DPVV: "N", N: "N",
};
const INPUT = {city: "Portland", zip: "97239"};

test("a confirmed address with only footnote N is verified", () => {
  const r = classifyCassRow(CLEAN, INPUT);
  assert.equal(r.status, "verified");
  // N is shown, since it happened, but it did not change the grade.
  assert.deepEqual(r.corrections, ["Address standardized"]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.dpvCode, "Y");
  assert.equal(r.vacant, false);
});

test("a ZIP+4 on the input is not a ZIP correction", () => {
  const {substantive} =
    buildCorrectionsAndSubstantive(CLEAN, {city: "Portland",
      zip: "97239-3011"});
  assert.deepEqual(substantive, []);
});

test("a changed five-digit ZIP is a correction and grades corrected", () => {
  const row = {...CLEAN, zipc: "97201"};
  const {display, substantive} =
    buildCorrectionsAndSubstantive(row, INPUT);
  assert.ok(display.includes("ZIP corrected: 97239 → 97201"));
  assert.ok(substantive.includes("ZIP corrected: 97239 → 97201"));
  assert.equal(deriveStatus(row, substantive), "corrected");
});

test("USPS preferred city without footnote B is display-only", () => {
  const row = {...CLEAN, dctys: "Portland"};
  const {display, substantive} =
    buildCorrectionsAndSubstantive(row, {city: "Tigard", zip: "97239"});
  assert.deepEqual(display.filter((d) => /city/i.test(d)),
      ["USPS preferred city: Tigard → Portland"]);
  assert.equal(substantive.some((d) => /city/i.test(d)), false);
  assert.equal(deriveStatus(row, substantive), "verified");
});

test("a city change WITH footnote B is a real correction", () => {
  const row = {...CLEAN, B: "B"};
  const {substantive} =
    buildCorrectionsAndSubstantive(row, {city: "Portlnd", zip: "97239"});
  assert.ok(substantive.includes("City corrected: Portlnd → Portland"));
  assert.equal(deriveStatus(row, substantive), "corrected");
});

test("undeliverable wins over everything", () => {
  assert.equal(deriveStatus({...CLEAN, DPVA: "N"}, []), "undeliverable");
  // No DPV code at all reads as unconfirmed, not as fine.
  assert.equal(deriveStatus({...CLEAN, DPVA: ""}, []), "undeliverable");
  assert.equal(deriveStatus({...CLEAN, DPVA: "N", DPVV: "Y"}, ["x"]),
      "undeliverable");
  // Footnotes C, D and F each mean USPS could not place it.
  for (const flag of ["C", "D", "F"]) {
    assert.equal(deriveStatus({...CLEAN, [flag]: flag}, []),
        "undeliverable", flag);
  }
});

test("vacant beats missing secondary, which beats corrected", () => {
  assert.equal(deriveStatus({...CLEAN, DPVV: "Y", DPVA: "D"}, ["x"]),
      "vacant");
  assert.equal(deriveStatus({...CLEAN, DPVA: "D"}, ["x"]),
      "missing_secondary");
  assert.equal(deriveStatus({...CLEAN, H: "H"}, []), "missing_secondary");
  assert.equal(deriveStatus(CLEAN, ["x"]), "corrected");
});

test("warnings name the delivery problem in words", () => {
  assert.deepEqual(buildWarnings({DPVA: "D"}),
      ["Secondary address (apt/suite) is missing"]);
  assert.deepEqual(buildWarnings({DPVA: "S"}),
      ["Secondary address could not be confirmed"]);
  assert.deepEqual(buildWarnings({DPVA: "Y", DPVV: "Y"}),
      ["Address is flagged as vacant"]);
  assert.deepEqual(buildWarnings({DPVA: "Y"}), []);
});

test("non-string fields are read as empty, never thrown on", () => {
  const r = classifyCassRow({DPVA: 7, zipc: null, dctys: undefined}, {});
  assert.equal(r.status, "undeliverable");
  assert.deepEqual(r.corrections, []);
});
