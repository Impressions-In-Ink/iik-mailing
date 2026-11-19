/**
 * eddm.test.js — USPS carrier routes picked on AccuZIP's map
 * (moved from Impulse's functions/test/eddmRoutes.test.js with the code;
 * its order checks stayed there)
 *
 * An EDDM order prints one card per household on the routes picked, so
 * the count decides what the buyer pays for and what the post office
 * gets. Pinned here: AccuZIP's own count wins over the map page's (the
 * page's numbers are whatever the browser saved), the quantity rounds UP
 * to the product's step, the map opens on the business's route, the key
 * never ends up in an error, and the print team's order fields.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EDDM_RETAIL_CENTS,
  cleanGuid,
  pickerUrl,
  countOf,
  mintPicker,
  containsPoint,
  routeAt,
  seedSelection,
  reopenSelection,
  MAP_MARKER,
  parseRoutes,
  parseSaved,
  parseQuote,
  eddmQuantity,
  eddmPostageCents,
  summarizePick,
  readPick,
  eddmRouteFields,
} = require("../src/eddm");

const GUID = "26110897-04e6-4171-bfe6-2ef3db1c0bee";
/** Impulse's EDDM postcard, as eddmQuantity reads it. */
const EDDM = {minQty: 500, qtyStep: 100};

/**
 * A square route outline around a point.
 * @param {number} lat latitude.
 * @param {number} lng longitude.
 * @param {number} d half the side, in degrees.
 * @return {object} a GeoJSON Polygon.
 */
function square(lat, lng, d = 0.002) {
  return {type: "Polygon", coordinates: [[[lng - d, lat - d],
    [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d],
    [lng - d, lat - d]]]};
}

/**
 * A ws_cr_boundaries route.
 * @param {string} cr the route id.
 * @param {number} lat its centre latitude.
 * @param {number} lng its centre longitude.
 * @param {number} res residential deliveries.
 * @param {number} biz business deliveries.
 * @return {object} the route.
 */
function route(cr, lat, lng, res, biz) {
  return {zipcrid: `97202${cr}`, zip: "97202", cr, name: "PORTLAND",
    state: "OR", lat, lon: lng, totrescnt: res, bizcnt: biz,
    st_asgeojson: JSON.stringify(square(lat, lng)), avghhsize: "2.1",
    avghhinc: "88525", medage: "40.09"};
}

/**
 * A fetch that answers from a table of url fragment → body.
 * @param {Array<Array>} table [fragment, body or () => body] pairs.
 * @param {Array<object>} calls receives every request made.
 * @return {Function} the fetch.
 */
function fakeFetch(table, calls = []) {
  return async (url, init) => {
    calls.push({url, init});
    for (const [match, answer] of table) {
      if (url.includes(match)) {
        const body = typeof answer === "function" ? answer() : answer;
        return {ok: true, status: 200, json: async () => body};
      }
    }
    return {ok: false, status: 404, json: async () => ({})};
  };
}

test("picker ids are AccuZIP's UUIDs and the url carries only one", () => {
  assert.equal(cleanGuid(` ${GUID.toUpperCase()} `), GUID);
  assert.equal(cleanGuid("not-a-guid"), "");
  assert.equal(cleanGuid("../ws_save"), "");
  assert.equal(cleanGuid(null), "");
  // The map reads its id as search.split("=")[1]: one parameter only.
  assert.equal(pickerUrl(GUID),
      `https://cloud2.iaccutrace.com/eddm4/?GUID=${GUID}`);
  assert.equal(pickerUrl(GUID).split("=").length, 2);
});

test("counts read the way AccuZIP formats them", () => {
  assert.equal(countOf("1,572"), 1572);
  assert.equal(countOf(703), 703);
  assert.equal(countOf(""), 0);
  assert.equal(countOf(null), 0);
  assert.equal(countOf("-4"), 0);
});

test("the map's routes: bad rows dropped, repeats once", () => {
  const routes = parseRoutes([
    {zip: "97202", crrt: "c025", city: " Portland ", state: "or",
      residential: 703, business: "4"},
    {zip: "97202", crrt: "C025", residential: 1, business: 1},
    {zip: "9720", crrt: "C001"},
    {zip: "97202", crrt: "025"},
    {zip: "97202", crrt: "C023", residential: "869", business: 48},
    null, "x",
  ]);
  assert.deepEqual(routes, [
    {zip: "97202", crrt: "C025", city: "Portland", state: "OR",
      residential: 703, business: 4},
    {zip: "97202", crrt: "C023", city: "", state: "",
      residential: 869, business: 48},
  ]);
  assert.deepEqual(parseRoutes(undefined), []);
  assert.deepEqual(parseSaved({success: true, data: null}),
      {routes: [], residentialOnly: false});
});

test("the quote: plain amounts only, AccuZIP's household counts", () => {
  const q = parseQuote({success: true, Total_Residential: "1,572",
    Total_Possible: "1,624", Estimated_Postage_Standard_Flat: "$502",
    Estimated_Postage_Standard_Nonprofit_Flat: "$352",
    Standard_Flat: "$-,502"});
  assert.deepEqual(q, {ready: true, residential: 1572, possible: 1624,
    permitPostageCents: 50200, nonprofitPostageCents: 35200});
  assert.equal(parseQuote({success: false}).ready, false);
  assert.equal(parseQuote({success: true,
    Estimated_Postage_Standard_Flat: "$-,502"}).permitPostageCents, 0);
  assert.equal(parseQuote(null), null);
});

test("the run is every household, rounded up to the step", () => {
  assert.equal(EDDM.minQty, 500);
  assert.equal(EDDM.qtyStep, 100);
  assert.equal(eddmQuantity(1624, EDDM), 1700);
  assert.equal(eddmQuantity(1600, EDDM), 1600);
  assert.equal(eddmQuantity(1601, EDDM), 1700);
  // One small route still prints the smallest run.
  assert.equal(eddmQuantity(212, EDDM), 500);
  assert.equal(eddmQuantity(0, EDDM), 500);
});

test("postage estimate is EDDM Retail per delivery", () => {
  assert.equal(EDDM_RETAIL_CENTS, 26);
  assert.equal(eddmPostageCents(1624), 42224);
  assert.equal(eddmPostageCents(-3), 0);
});

test("AccuZIP's count wins over the numbers the map page saved", () => {
  const picked = {routes: parseRoutes([
    // Fake counts saved through the page's own endpoint.
    {zip: "97202", crrt: "C025", residential: 5, business: 1}]),
  residentialOnly: false};
  const quote = parseQuote({success: true, Total_Residential: "703",
    Total_Possible: "707", Estimated_Postage_Standard_Flat: "$218"});
  const s = summarizePick(picked, quote);
  assert.equal(s.households, 707);
  assert.equal(s.residential, 703);
  assert.equal(s.business, 4);
  assert.equal(s.countedBy, "accuzip");
  assert.equal(s.postageCents, 707 * 26);
  assert.equal(s.permitPostageCents, 21800);

  const homesOnly = summarizePick({...picked, residentialOnly: true}, quote);
  assert.equal(homesOnly.households, 703);
  // AccuZIP's estimate covers every door, so it isn't shown for homes only.
  assert.equal(homesOnly.permitPostageCents, 0);

  // No quote: the page's counts, labelled as such.
  const fromMap = summarizePick(picked, null);
  assert.equal(fromMap.households, 6);
  assert.equal(fromMap.countedBy, "map");
});

test("the map opens on the route the business is on", () => {
  const a = route("C025", 45.4812, -122.6413, 703, 4);
  const b = route("C023", 45.4900, -122.6300, 869, 48);
  assert.equal(containsPoint(square(45.48, -122.64), 45.48, -122.64), true);
  assert.equal(containsPoint(square(45.48, -122.64), 45.5, -122.64), false);
  assert.equal(routeAt([b, a], 45.4813, -122.6412).cr, "C025");
  // Outside every outline: the nearest centre.
  assert.equal(routeAt([a, b], 45.4880, -122.6310).cr, "C023");
  assert.equal(routeAt([], 45, -122), null);

  const body = seedSelection(a, {lat: 45.4812, lng: -122.6413});
  assert.deepEqual(body.EDDM_MAP_INFO.map_position, [45.4812, -122.6413, 15]);
  assert.equal(body.EDDM.length, 1);
  assert.equal(body.EDDM[0].crrt, "C025");
  assert.equal(body.EDDM[0].residential, 703);
  assert.equal(body.EDDM_MAP_INFO.routes_detail[0].zipcrid, "97202C025");
  assert.equal(body.EDDM_MAP_INFO.routes_detail[0].geoJson.type, "Polygon");
  // The marker rides along so every later click is saved and posted.
  assert.equal(body.EDDM_MAP_INFO.routes_detail.length, 2);
  assert.equal(body.EDDM_MAP_INFO.routes_detail[1].zipcrid,
      MAP_MARKER.zipcrid);
});

test("a reopened map is re-marked, zoomed, or replaced when empty", () => {
  const saved = {success: true, data: {
    routes: [{id: 1, zip: "97202", crrt: "C025", residential: 703}],
    map_info: {map_position: [45.48, -122.64],
      routes_detail: [{id: 1, zipcrid: "97202C025", geoJson: {}}]}}};
  const body = reopenSelection(saved);
  assert.deepEqual(body.EDDM_MAP_INFO.map_position, [45.48, -122.64, 15]);
  assert.deepEqual(body.EDDM_MAP_INFO.routes_detail.map((r) => r.zipcrid),
      ["97202C025", MAP_MARKER.zipcrid]);
  assert.equal(body.EDDM.length, 1);
  // Marked once, however often it's reopened.
  const again = reopenSelection({data: {routes: body.EDDM,
    map_info: body.EDDM_MAP_INFO}});
  assert.equal(again.EDDM_MAP_INFO.routes_detail.filter(
      (r) => r.zipcrid === MAP_MARKER.zipcrid).length, 1);
  // Nothing picked: a fresh map at the business beats AccuZIP's default.
  assert.equal(reopenSelection({success: true, data: {routes: [],
    map_info: {routes_detail: []}}}), null);
  assert.equal(reopenSelection({success: true, data: null}), null);
});

test("minting sends the key and never repeats AccuZIP's body", async () => {
  const calls = [];
  const ok = await mintPicker({apiKey: "SECRET-KEY", callbackUrl: "https://x/",
    fetchFn: fakeFetch([["ws_auto", {guid: GUID,
      eddm_url: `https://cloud2.iaccutrace.com/eddm4/?GUID=${GUID}`}]], calls)});
  assert.deepEqual(ok, {guid: GUID, url: pickerUrl(GUID)});
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.API_KEY, "SECRET-KEY");
  assert.equal(sent.EDDM_version, 4);

  const refused = async () => ({ok: false, status: 401,
    json: async () => ({message: "bad key SECRET-KEY"})});
  await assert.rejects(
      mintPicker({apiKey: "SECRET-KEY", callbackUrl: "x", fetchFn: refused}),
      (err) => !err.message.includes("SECRET-KEY") &&
        /HTTP 401/.test(err.message));
  await assert.rejects(
      mintPicker({apiKey: "", callbackUrl: "x", fetchFn: refused}));
});

test("reading a pick waits out a not-ready quote", async () => {
  let tries = 0;
  const fetchFn = fakeFetch([
    ["ws_save", {success: true, data: {routes: [
      {zip: "97202", crrt: "C025", residential: 703, business: 4},
      {zip: "97202", crrt: "C023", residential: 869, business: 48}]}}],
    ["QUOTE/true", () => (++tries < 2 ? {success: false} :
      {success: true, Total_Residential: "1,572", Total_Possible: "1,624"})],
  ]);
  const s = await readPick({guid: GUID, residentialOnly: false, fetchFn,
    sleep: async () => {}});
  assert.equal(tries, 2);
  assert.equal(s.routeCount, 2);
  assert.equal(s.households, 1624);

  const never = fakeFetch([
    ["ws_save", {success: true, data: {routes: [
      {zip: "97202", crrt: "C025"}]}}],
    ["QUOTE/true", {success: false}],
  ]);
  await assert.rejects(readPick({guid: GUID, fetchFn: never,
    sleep: async () => {}}));

  // Nothing picked: no quote needed, zero households.
  const empty = await readPick({guid: GUID, sleep: async () => {},
    fetchFn: fakeFetch([["ws_save", {success: true, data: null}]])});
  assert.equal(empty.households, 0);
  assert.equal(empty.counts, null);
});

test("a recount is reused only while the routes are the same", async () => {
  // AccuZIP's recount takes ~14 s, so Pay reuses the one from "Use these
  // routes" — but never for a different set of routes or switch.
  let recounts = 0;
  const saved = (routes) => fakeFetch([
    ["ws_save", {success: true, data: {routes}}],
    ["QUOTE/true", () => {
      recounts++;
      return {success: true, Total_Residential: "1,572",
        Total_Possible: "1,624", Estimated_Postage_Standard_Flat: "$502"};
    }],
  ]);
  const two = [
    {zip: "97202", crrt: "C023", residential: 1, business: 1},
    {zip: "97202", crrt: "C025", residential: 1, business: 1}];
  const first = await readPick({guid: GUID, residentialOnly: false,
    fetchFn: saved(two)});
  assert.equal(recounts, 1);
  assert.deepEqual(first.counts, {routeKeys: ["97202C023", "97202C025"],
    residentialOnly: false, residential: 1572, possible: 1624,
    permitPostageCents: 50200, nonprofitPostageCents: 0});

  // Same routes in another order: reused, no recount.
  const again = await readPick({guid: GUID, residentialOnly: false,
    fetchFn: saved([...two].reverse()), known: first.counts});
  assert.equal(recounts, 1);
  assert.equal(again.households, 1624);
  assert.equal(again.countedBy, "accuzip");

  // A route added, or businesses left out: recounted.
  await readPick({guid: GUID, residentialOnly: false, known: first.counts,
    fetchFn: saved([...two,
      {zip: "97202", crrt: "C014", residential: 1, business: 1}])});
  assert.equal(recounts, 2);
  await readPick({guid: GUID, residentialOnly: true, known: first.counts,
    fetchFn: saved(two)});
  assert.equal(recounts, 3);
  // A stored count with no number in it is never trusted.
  await readPick({guid: GUID, residentialOnly: false,
    known: {...first.counts, possible: 0}, fetchFn: saved(two)});
  assert.equal(recounts, 4);
});

test("the print team gets the routes, deliveries, postage and map", () => {
  const area = {pickerId: GUID, residentialOnly: false, households: 1624,
    postageCents: 42224, note: "skip apartments",
    routes: [
      {zip: "97202", crrt: "C025", residential: 703, business: 4},
      {zip: "97202", crrt: "C023", residential: 869, business: 48}]};
  const fields = eddmRouteFields(area);
  const by = Object.fromEntries(fields.map((f) => [f.id, f]));
  assert.equal(by.eddm_routes.label, "EDDM routes (2)");
  assert.equal(by.eddm_routes.value,
      "97202 C025 (703 res, 4 bus); 97202 C023 (869 res, 48 bus)");
  assert.equal(by.eddm_households.value, "1,624 (every home and business)");
  assert.equal(by.eddm_postage.value, "$422.24 at 26¢ each");
  assert.equal(by.eddm_map.value, pickerUrl(GUID));
  assert.equal(eddmRouteFields({...area, residentialOnly: true})
      .find((f) => f.id === "eddm_households").value,
  "1,624 (residential only)");
  assert.deepEqual(eddmRouteFields(null), []);
});

test("the shared map page re-marks with the server's marker", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "web",
      "eddm_map.html"), "utf8");
  assert.ok(html.includes(`var MARKER = '${MAP_MARKER.zipcrid}';`),
      "web/eddm_map.html and src/eddm.js must name the same marker");
  assert.ok(html.includes(`var MAX_ROUTES = 200;`));
});
