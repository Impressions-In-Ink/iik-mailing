/**
 * estimate.test.js — the checkout estimate from AccuZIP's free quote.
 *
 * Pins what must never go wrong at checkout: it never processes a job or
 * checks addresses (both cost money), it says the count is before the
 * address check, it leaves out what can't mail with a reason, and it
 * reads the right quote line for the class and size — or says it has none
 * instead of guessing.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../index");

/**
 * A recipient.
 * @param {string} id the id.
 * @param {object} over overrides.
 * @return {object} the recipient.
 */
function rec(id, over) {
  return {id, data: {name: `Person ${id}`, line1: `${id} Main St`,
    city: "Portland", state: "OR", zip: "97205", ...over}};
}

/**
 * A fake AccuZIP cloud: records calls; the quote is ready on the Nth ask.
 * @param {object} quote the QUOTE JSON.
 * @param {number} readyOn which ask returns it.
 * @return {object} the fake.
 */
function cloud(quote, readyOn = 2) {
  const calls = [];
  let asks = 0;
  return {
    calls,
    async upload(csv, name) {
      calls.push(["upload", csv, name]);
      return "guid-1";
    },
    async quoteIfReady(guid) {
      calls.push(["quote", guid]);
      return ++asks >= readyOn ? quote : null;
    },
    async process() {
      calls.push(["process"]);
      throw new Error("the estimate must never process a job");
    },
    async download() {
      calls.push(["download"]);
      throw new Error("the estimate must never download");
    },
  };
}

const list = (n) => Array.from({length: n}, (_, i) => rec(String(i + 1)));
const fast = {sleep: async () => {}, pollMs: 1};

test("200+ pieces: Marketing Mail estimate from the free quote", async () => {
  const c = cloud({Estimated_Postage_Standard_Letter: "$85.31",
    Estimated_Postage_Standard_Flat: "$140.00"});
  const r = await m.estimateMailing({recipients: list(250), size: "LETTER",
    cloud: c, ...fast});
  assert.equal(r.pieces, 250);
  assert.equal(r.mailClass, "marketing");
  assert.equal(r.estimatedPostage, 85.31);
  assert.equal(r.quoteLine, "Standard_Letter");
  assert.equal(r.perPiece, 0.3412);
  assert.equal(r.beforeAddressCheck, true);
  assert.equal(r.guid, "guid-1");
});

test("it only uploads and reads the quote: no process, no download",
    async () => {
      const c = cloud({Estimated_Postage_Standard_Flat: "10"});
      await m.estimateMailing({recipients: list(300), size: "FLAT", cloud: c,
        ...fast});
      const kinds = new Set(c.calls.map((x) => x[0]));
      assert.deepEqual([...kinds].sort(), ["quote", "upload"]);
    });

test("rows that can't be mail are left out, each with its reason",
    async () => {
      const c = cloud({Estimated_Postage_Standard_Letter: "1"});
      const r = await m.estimateMailing({recipients: [
        ...list(200),
        rec("x", {line1: ""}),
        rec("y", {city: "", state: "", zip: ""}),
        rec("1"), // the same person at the same address as row 1
      ], size: "LETTER", cloud: c, ...fast});
      assert.equal(r.uploaded, 203);
      assert.equal(r.pieces, 200);
      assert.deepEqual(r.removals, {incomplete: 2, duplicate: 1});
      assert.deepEqual(r.removed.map((x) => x.reason),
          ["incomplete", "incomplete", "duplicate"]);
      // Only the kept rows were uploaded (header + 200).
      const csv = c.calls.find((x) => x[0] === "upload")[1];
      assert.equal(csv.trim().split("\r\n").length, 201);
    });

test("a ZIP alone is enough to keep a row; a city without a state isn't",
    () => {
      const p = m.prepareRows([rec("a", {city: "", state: ""}),
        rec("b", {state: "", zip: ""})]);
      assert.deepEqual(p.keep.map((x) => x.id), ["a"]);
    });

test("under 200 pieces is First-Class; its line is used when quoted",
    async () => {
      const c = cloud({Estimated_Postage_Standard_Letter: "5",
        Estimated_Postage_First_Class_Card: "$32.40"});
      const r = await m.estimateMailing({recipients: list(60),
        size: "LETTER", cloud: c, ...fast});
      assert.equal(r.mailClass, "firstClass");
      assert.equal(r.estimatedPostage, 32.4);
      assert.equal(r.quoteLine, "First_Class_Card");
    });

test("no quote line for the class: no number, and it says why", async () => {
  const c = cloud({Estimated_Postage_Standard_Letter: "5"});
  const r = await m.estimateMailing({recipients: list(60), size: "LETTER",
    cloud: c, ...fast});
  assert.equal(r.estimatedPostage, null);
  assert.match(r.reason, /First-Class/);
  assert.deepEqual(r.estimates, {Standard_Letter: 5});
});

test("a quote that never comes back times out cleanly", async () => {
  let t = 0;
  const c = cloud({}, Infinity);
  const r = await m.estimateMailing({recipients: list(250), size: "LETTER",
    cloud: c, waitMs: 10, pollMs: 5, sleep: async (ms) => {
      t += ms;
    }, now: () => t});
  assert.equal(r.estimatedPostage, null);
  assert.match(r.reason, /wasn't ready/);
});

test("nothing mailable: no upload at all", async () => {
  const c = cloud({});
  const r = await m.estimateMailing({recipients: [rec("a", {line1: ""})],
    size: "LETTER", cloud: c, ...fast});
  assert.equal(r.pieces, 0);
  assert.equal(c.calls.length, 0);
});

test("quote money reads the ways AccuZIP writes it", () => {
  assert.equal(m.moneyNumber("$1,204.55"), 1204.55);
  assert.equal(m.moneyNumber(85.31), 85.31);
  assert.equal(m.moneyNumber("n/a"), null);
  assert.deepEqual(m.quoteEstimates({Estimated_Postage_Standard_Flat: "$2",
    task_state: "QUOTE"}), {Standard_Flat: 2});
});

test("a flat never picks a letter line", () => {
  assert.equal(m.pickEstimate({Standard_Letter: 1}, "marketing", "FLAT"),
      null);
});
