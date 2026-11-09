/**
 * cass.test.js — the CASS conversation every address check shares
 *
 * Pinned: the row AccuZIP gets for one address, the request that carries
 * them, the mapping of replies back to inputs, the one-address reading,
 * the suite rule, and above all that no error ever carries a response
 * body (AccuZIP echoes the API key in its error replies).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CASS_URL,
  CASS_BATCH_SIZE,
  cassRequestRow,
  postCass,
  resultsByForeignId,
  callCassBatch,
  parseCassResult,
  deliveryLineCarries,
} = require("../src/cass");

const KEY = "11111111-2222-3333-4444-555555555555";

/** A fetch that answers once with `status` and `body`, and records the
 * request it was given. */
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, init});
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  fn.calls = calls;
  return fn;
}

test("a request row carries every field, mixed case, and the id", () => {
  assert.deepEqual(
      cassRequestRow({company: "Summit Comfort", line1: " 123 Main St ",
        line2: "Ste 200", city: "Portland", state: "OR", zip: 97230}, 7),
      {
        "AZSetQuery_iadl1": "123 Main St",
        "AZSetQuery_iadl2": "Summit Comfort",
        "AZSetQuery_iadl3": "Ste 200",
        "AZSetQuery_ictyi": "Portland",
        "AZSetQuery_istai": "OR",
        "AZSetQuery_izipc": "97230",
        "AZSetQuery_icountry": "US",
        "AZSetQuery_iforeignid": "7",
        "mixedcase": "1",
      });
  const empty = cassRequestRow(null, "a");
  assert.equal(empty["AZSetQuery_iadl1"], "");
  assert.equal(empty["AZSetQuery_iforeignid"], "a");
  assert.equal(CASS_BATCH_SIZE, 20);
});

test("postCass sends the key and rows to the CASS endpoint", async () => {
  const reply = {success: true, Addr_Result: [{dadl1: "123 Main St"}]};
  const f = fakeFetch(200, reply);
  const rows = [cassRequestRow({line1: "123 Main"}, 1)];
  assert.deepEqual(await postCass(KEY, rows, {fetchImpl: f}), reply);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, CASS_URL);
  assert.equal(f.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(f.calls[0].init.body),
      {"API_KEY": KEY, "Address": rows});
});

test("no error ever carries the reply, so the key can't leak", async () => {
  const echo = `Invalid request for API_KEY ${KEY}`;
  const cases = [
    fakeFetch(500, echo),
    fakeFetch(200, {success: false, message: echo}),
    fakeFetch(200, `<html>${echo}</html>`),
    fakeFetch(200, {success: true}),
  ];
  for (const f of cases) {
    await assert.rejects(postCass(KEY, [], {fetchImpl: f}), (e) => {
      assert.ok(!e.message.includes(KEY), e.message);
      assert.match(e.message, /^AccuZIP /);
      return true;
    });
  }
});

test("results map back by echoed id, else by position", () => {
  const rows = [cassRequestRow({}, "a"), cassRequestRow({}, "b"),
    cassRequestRow({}, "c")];
  const byId = resultsByForeignId({success: true, Addr_Result: [
    {iforeignid: "b", n: 1},
    {foreignid: "a", n: 2},
    {n: 3},
  ]}, rows);
  assert.equal(byId.get("b").n, 1);
  assert.equal(byId.get("a").n, 2);
  assert.equal(byId.get("c").n, 3, "no echo: the row in the same place");
  assert.equal(resultsByForeignId(null, rows).size, 0);
});

test("callCassBatch returns the keyed map", async () => {
  const f = fakeFetch(200, {success: true,
    Addr_Result: [{iforeignid: "9", dadl1: "1 A St"}]});
  const byId = await callCassBatch(KEY, [cassRequestRow({}, 9)], f);
  assert.equal(byId.get("9").dadl1, "1 A St");
});

test("one address reads as a standardized address", () => {
  assert.deepEqual(parseCassResult({success: true, Addr_Result: [{
    dadl1: " 3181 SW Sam Jackson Park Rd ", dctya: "Portland",
    dstaa: "OR", zipc: "97239", addon: "3011", county_name: "Multnomah",
    DPVA: "Y", DPVV: "N",
  }]}), {
    ok: true,
    standardized: {street: "3181 SW Sam Jackson Park Rd", city: "Portland",
      state: "OR", zip5: "97239", zip4: "3011", county: "Multnomah"},
    dpv: {code: "Y", vacant: false},
  });
  assert.equal(parseCassResult({success: true,
    Addr_Result: [{dadl1: "x", dctys: "Tigard", dctya: "Portland",
      DPVV: "Y"}]}).standardized.city, "Tigard");
  assert.equal(parseCassResult(null).ok, false);
  assert.equal(parseCassResult({success: false}).ok, false);
  assert.equal(parseCassResult({success: true, Addr_Result: []}).ok, false);
  assert.equal(parseCassResult({success: true,
    Addr_Result: [{dctys: "Portland"}]}).ok, false,
  "no street and no ZIP is no address");
});

test("a typed suite survives unless the delivery line carries it", () => {
  assert.equal(deliveryLineCarries("123 Main St Ste 200", "Suite 200"), true);
  assert.equal(deliveryLineCarries("123 Main St", "Suite 200"), false);
  assert.equal(deliveryLineCarries("123 Main St", ""), true);
  assert.equal(deliveryLineCarries("123 MAIN ST APT 4B", "apt 4b"), true);
});
