/**
 * eddm.js — USPS carrier routes for an EDDM run, picked on a map
 * ---------------------------------------------------------------
 * Every Door Direct Mail goes to every home on a mail carrier ROUTE, so
 * an EDDM order needs a list of routes, not addresses. AccuZIP's route
 * picker is a map the buyer clicks routes on; this module mints one,
 * starts it at the business, and reads back what was picked.
 *
 * Shared by both apps (moved here from Impulse's functions/lib/
 * eddmRoutes.js, 1.4.0): Impulse sells EDDM postcards, the admin app's
 * Mail Prep runs EDDM mailings on a permit. Nothing here knows about
 * either app's jobs or orders, every network call takes its fetch, and
 * everything else is PURE. The map page both apps host is web/
 * eddm_map.html in this package. The presort of a picked run (the permit
 * paperwork) is presort.js: eddmPresortSettings, EDDM_PROCESS.
 *
 * THE FLOW (cloud2.iaccutrace.com; checked live 2026-11-08):
 *   1. mint     POST mod_eddm/ws_auto {API_KEY, EDDM_version: 4} → a guid
 *               and the map url (eddm4/?GUID=…). The ONLY call that needs
 *               the Direct Mail key, so it runs on the server.
 *   2. seed     POST mod_eddm/ws_save/{guid} with one route + a map
 *               position. The map opens there with that route picked.
 *               (The map's own save endpoint; it reloads what it saved.)
 *   3. pick     the buyer clicks routes. Each click saves to ws_save AND
 *               posts {guid, eddmData} to the page around it, so the app
 *               can show the count live.
 *   4. read     GET mod_eddm/ws_save/{guid} → the routes picked, and
 *               GET ws_360/v2_0/job/{guid}/QUOTE/true → AccuZIP's own
 *               household counts. The quote recounts from the route ids
 *               (fake counts saved to ws_save came back as the real ones),
 *               so ITS numbers set the quantity, never the page's. The
 *               recount takes ~14 s, so the caller keeps the last one
 *               (`counts`) and passes it back as `known`: while the saved
 *               routes are the same set, it's reused instead of recounted.
 *
 * THE MARKER. A map that opens with routes already picked compares each
 * change with the routes it opened with, and when they match again it
 * neither saves nor posts (AccuZIP's v4 map, azEddm.js saveRoutes). So
 * "add a route, then take it off" would leave the extra route saved. One
 * extra routes_detail entry (MAP_MARKER) that no click can produce makes
 * that comparison never match; the map's reload only reads routes_detail
 * up to the number of routes, so the entry is otherwise ignored, and the
 * quote counts from the routes (checked live 2026-11-08). The map's own
 * saves drop it, so a map is re-marked whenever it's reopened.
 *
 * Nothing here is billed. AccuZIP bills a job on its first download after
 * processing; picking and quoting are free (credits used stayed 0).
 *
 * TRAP: AccuZIP echoes the API key in some error bodies. Never log or
 * return a response body from the mint call.
 */

"use strict";

const EDDM_HOST = "https://cloud2.iaccutrace.com";
const MOD_EDDM = `${EDDM_HOST}/servoy-service/rest_ws/mod_eddm`;
const QUOTE_BASE = `${EDDM_HOST}/servoy-service/rest_ws/ws_360/v2_0/job`;

/** The map version ws_auto mints (its url is /eddm4/). */
const PICKER_VERSION = 4;

/** USPS EDDM Retail postage per piece, flats (July 2026 prices). */
const EDDM_RETAIL_CENTS = 26;

/** A sane ceiling on routes in one order (a big metro run is ~60). */
const MAX_ROUTES = 200;

/** AccuZIP job ids are UUIDs. */
const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A carrier route id: type letter + 3 digits (C001 city, R rural, H
 * highway contract, B PO box, G general delivery). */
const CRRT_RE = /^[A-Z][0-9]{3}$/;
const ZIP_RE = /^[0-9]{5}$/;

/** See THE MARKER above. */
const MAP_MARKER = Object.freeze({id: 0, zipcrid: "impulse", geoJson: null});

/** The zoom a map reopens at (the map saves only [lat, lng]). */
const MAP_ZOOM = 15;

/** How often QUOTE/true may answer "not ready" before we give up. Each
 * recount itself takes ~14 s (AccuZIP recomputes it on every call; the
 * plain QUOTE is only the last recount, cached). */
const QUOTE_TRIES = 2;
const QUOTE_WAIT_MS = 2000;

/**
 * A picker id as AccuZIP issues it, or "" when it isn't one. PURE.
 * @param {*} v the id.
 * @return {string} the id, or "".
 */
function cleanGuid(v) {
  const s = String(v == null ? "" : v).trim();
  return GUID_RE.test(s) ? s.toLowerCase() : "";
}

/**
 * The map page for a picker. The page reads its id with
 * `search.split("=")[1]`, so the url must carry exactly one parameter.
 * PURE.
 * @param {string} guid the picker id.
 * @return {string} the url.
 */
function pickerUrl(guid) {
  return `${EDDM_HOST}/eddm${PICKER_VERSION}/?GUID=${guid}`;
}

/**
 * A count AccuZIP formats for people ("1,572") as a number. PURE.
 * @param {*} v the value.
 * @return {number} the whole number, or 0.
 */
function countOf(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : 0;
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Ask AccuZIP for a new route-picker map. Never puts the response body in
 * an error: it can carry the key.
 * @param {object} p params.
 * @param {string} p.apiKey the Direct Mail key (ACCUZIP_DM_API_KEY).
 * @param {string} p.callbackUrl where the map may send the browser after
 *   (unused by the v4 map, which posts messages instead; required anyway).
 * @param {Function} p.fetchFn fetch.
 * @return {Promise<{guid: string, url: string}>} the new picker.
 */
async function mintPicker({apiKey, callbackUrl, fetchFn}) {
  if (!apiKey) throw new Error("No AccuZIP Direct Mail key.");
  let resp;
  try {
    resp = await fetchFn(`${MOD_EDDM}/ws_auto`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({callback_url: callbackUrl, API_KEY: apiKey,
        EDDM_version: PICKER_VERSION}),
    });
  } catch (err) {
    throw new Error("AccuZIP route map unreachable.");
  }
  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    data = null;
  }
  const guid = cleanGuid(data && data.guid);
  if (!resp.ok || !guid) {
    throw new Error(`AccuZIP route map refused (HTTP ${resp.status}).`);
  }
  return {guid, url: pickerUrl(guid)};
}

/**
 * The route-boundary query for a box around a point: four "lng lat"
 * corners (NW, NE, SE, SW) and the map version. PURE.
 * @param {number} lat latitude.
 * @param {number} lng longitude.
 * @param {number} span half the box side, in degrees.
 * @return {string} the path after ws_cr_boundaries/.
 */
function boundsPath(lat, lng, span) {
  const pt = (x, y) => encodeURIComponent(`${x} ${y}`);
  return [pt(lng - span, lat + span), pt(lng + span, lat + span),
    pt(lng + span, lat - span), pt(lng - span, lat - span),
    PICKER_VERSION].join("/");
}

/**
 * The carrier routes in a small box around a point, as the map draws
 * them (counts, centre, GeoJSON outline).
 * @param {object} p params.
 * @param {number} p.lat latitude.
 * @param {number} p.lng longitude.
 * @param {Function} p.fetchFn fetch.
 * @param {number} [p.span] half the box side in degrees (~400 m).
 * @return {Promise<Array<object>>} the routes ([] when none).
 */
async function routesNear({lat, lng, fetchFn, span = 0.004}) {
  const resp = await fetchFn(
      `${MOD_EDDM}/ws_cr_boundaries/${boundsPath(lat, lng, span)}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  const routes = data && data.data && data.data.routes;
  return Array.isArray(routes) ? routes : [];
}

/**
 * A route's outline as a GeoJSON object (the map sends it as an object
 * or a string). PURE.
 * @param {object} route a ws_cr_boundaries route.
 * @return {?object} the geometry, or null.
 */
function outlineOf(route) {
  const g = route && route.st_asgeojson;
  if (g && typeof g === "object") return g;
  if (typeof g !== "string") return null;
  try {
    return JSON.parse(g);
  } catch (_) {
    return null;
  }
}

/**
 * Whether a point is inside a GeoJSON Polygon / MultiPolygon (outer rings,
 * ray casting). PURE.
 * @param {?object} geom the geometry.
 * @param {number} lat latitude.
 * @param {number} lng longitude.
 * @return {boolean} true when inside.
 */
function containsPoint(geom, lat, lng) {
  if (!geom || !Array.isArray(geom.coordinates)) return false;
  const polys = geom.type === "MultiPolygon" ? geom.coordinates :
    geom.type === "Polygon" ? [geom.coordinates] : [];
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) &&
          lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
  return polys.some((p) => Array.isArray(p) && Array.isArray(p[0]) &&
    inRing(p[0]));
}

/**
 * The route a point (the business) sits on: the one whose outline holds
 * it, else the one whose centre is nearest. PURE.
 * @param {Array<object>} routes ws_cr_boundaries routes.
 * @param {number} lat latitude.
 * @param {number} lng longitude.
 * @return {?object} the route, or null when there are none.
 */
function routeAt(routes, lat, lng) {
  const usable = (routes || []).filter((r) => r && r.zip && r.cr &&
    outlineOf(r));
  const hit = usable.find((r) => containsPoint(outlineOf(r), lat, lng));
  if (hit) return hit;
  let best = null;
  let bestD = Infinity;
  for (const r of usable) {
    const d = Math.pow(Number(r.lat) - lat, 2) +
      Math.pow(Number(r.lon) - lng, 2);
    if (Number.isFinite(d) && d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}

/**
 * What the map saves for itself, holding one picked route and where to
 * look: the map reloads this and opens there. PURE.
 * @param {object} route a ws_cr_boundaries route.
 * @param {{lat: number, lng: number}} at the map centre.
 * @param {number} [zoom] the map zoom.
 * @return {object} the ws_save body.
 */
function seedSelection(route, at, zoom = MAP_ZOOM) {
  return {
    residential_only: "0",
    download_type: "",
    EDDM: [{
      id: 1,
      zip: route.zip,
      crrt: route.cr,
      city: route.name,
      state: route.state,
      residential: countOf(route.totrescnt),
      business: countOf(route.bizcnt),
      avghhsize: route.avghhsize,
      avghhinc: route.avghhinc,
      medage: route.medage,
    }],
    EDDM_MAP_INFO: {
      // [lat, lng, zoom]: the map pans to the first two and zooms to the
      // third when it reloads a saved selection.
      map_position: [at.lat, at.lng, zoom],
      routes_detail: [{id: 1, zipcrid: `${route.zip}${route.cr}`,
        geoJson: outlineOf(route)}, {...MAP_MARKER}],
    },
  };
}

/**
 * What a map saved, ready to reopen: re-marked (see THE MARKER) and with
 * a zoom. Null when it has no routes: a map with none reopens on
 * AccuZIP's default view, far from the business, so a new one is better.
 * PURE.
 * @param {*} json GET ws_save/{guid}'s body.
 * @return {?object} the ws_save body, or null.
 */
function reopenSelection(json) {
  const d = json && json.data;
  const routes = d && Array.isArray(d.routes) ? d.routes : [];
  const info = d && d.map_info && typeof d.map_info === "object" ?
    d.map_info : null;
  const detail = info && Array.isArray(info.routes_detail) ?
    info.routes_detail.filter((r) => r && r.zipcrid !== MAP_MARKER.zipcrid) :
    [];
  if (routes.length === 0 || detail.length < routes.length) return null;
  const pos = Array.isArray(info.map_position) ? info.map_position : [];
  return {
    residential_only: "0",
    download_type: "",
    EDDM: routes,
    EDDM_MAP_INFO: {
      ...info,
      map_position: pos.length >= 2 ?
        [pos[0], pos[1], Number(pos[2]) > 0 ? pos[2] : MAP_ZOOM] : pos,
      routes_detail: [...detail, {...MAP_MARKER}],
    },
  };
}

/**
 * Get an earlier map ready to reopen (see reopenSelection).
 * @param {object} p params.
 * @param {string} p.guid the picker id.
 * @param {Function} p.fetchFn fetch.
 * @return {Promise<boolean>} false when it should be replaced instead.
 */
async function prepareReopen({guid, fetchFn}) {
  const resp = await fetchFn(`${MOD_EDDM}/ws_save/${guid}`);
  if (!resp.ok) return false;
  const body = reopenSelection(await resp.json().catch(() => null));
  if (!body) return false;
  return seedPicker({guid, body, fetchFn});
}

/**
 * Save a starting selection into a fresh picker.
 * @param {object} p params.
 * @param {string} p.guid the picker id.
 * @param {object} p.body seedSelection's result.
 * @param {Function} p.fetchFn fetch.
 * @return {Promise<boolean>} true when AccuZIP took it.
 */
async function seedPicker({guid, body, fetchFn}) {
  const resp = await fetchFn(`${MOD_EDDM}/ws_save/${guid}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  if (!resp.ok) return false;
  const data = await resp.json().catch(() => null);
  return !!(data && data.success);
}

/**
 * The routes in what the map saved (ws_save's `data.routes`) or posted
 * (`eddmData.EDDM`): ZIP + route id, place, and the map's own counts.
 * Bad rows are dropped, repeats kept once. PURE.
 * @param {*} rows the route rows.
 * @return {Array<{zip: string, crrt: string, city: string, state: string,
 *   residential: number, business: number}>} the routes.
 */
function parseRoutes(rows) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object") continue;
    const zip = String(r.zip == null ? "" : r.zip).trim();
    const crrt = String(r.crrt == null ? "" : r.crrt).trim().toUpperCase();
    if (!ZIP_RE.test(zip) || !CRRT_RE.test(crrt)) continue;
    const key = zip + crrt;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      zip, crrt,
      city: String(r.city || "").trim().slice(0, 60),
      state: String(r.state || "").trim().slice(0, 2).toUpperCase(),
      residential: countOf(r.residential),
      business: countOf(r.business),
    });
    if (out.length >= MAX_ROUTES) break;
  }
  return out;
}

/**
 * What the map saved: the routes and whether businesses are left out.
 * PURE.
 * @param {*} json GET ws_save/{guid}'s body.
 * @return {{routes: Array<object>, residentialOnly: boolean}} the pick.
 */
function parseSaved(json) {
  const d = json && json.data;
  return {
    routes: parseRoutes(d && d.routes),
    // The saved map info doesn't keep the residential-only switch; the
    // posted message does (see parsePosted). Default: every door.
    residentialOnly: false,
  };
}

/**
 * AccuZIP's quote for the picked routes: its household counts and its
 * own postage estimate at permit (BMEU) rates. PURE.
 * @param {*} json GET QUOTE/true's body.
 * @return {?{ready: boolean, residential: number, possible: number,
 *   permitPostageCents: number}} the counts, or null for no body.
 */
function parseQuote(json) {
  if (!json || typeof json !== "object") return null;
  const dollars = (v) => {
    const s = String(v == null ? "" : v);
    // "$-,502" turns up in the savings fields; only plain amounts count.
    if (!/^\$?[0-9][0-9,]*(\.[0-9]+)?$/.test(s.trim())) return 0;
    return Math.round(Number(s.replace(/[$,]/g, "")) * 100);
  };
  return {
    ready: json.success === true,
    residential: countOf(json.Total_Residential),
    possible: countOf(json.Total_Possible),
    permitPostageCents: dollars(json.Estimated_Postage_Standard_Flat),
  };
}

/**
 * The pieces an EDDM run prints: one per household, rounded UP to the
 * product's step, and never under its minimum. PURE.
 * @param {number} households deliveries on the picked routes.
 * @param {{minQty: number, qtyStep: number}} product the catalog entry.
 * @return {number} the print quantity.
 */
function eddmQuantity(households, product) {
  const step = Math.max(1, product.qtyStep || 1);
  const n = Math.ceil(Math.max(0, households) / step) * step;
  return Math.max(product.minQty || 0, n);
}

/**
 * USPS EDDM Retail postage for a run, paid at the post office. PURE.
 * @param {number} households deliveries.
 * @return {number} cents.
 */
function eddmPostageCents(households) {
  return Math.max(0, households) * EDDM_RETAIL_CENTS;
}

/**
 * The picked area, counted: AccuZIP's quote sets the households (never
 * the page's numbers), the saved map sets the routes. PURE.
 * @param {{routes: Array<object>, residentialOnly: boolean}} picked
 *   parseSaved's result (with residentialOnly from the app).
 * @param {?object} quote parseQuote's result.
 * @return {object} {routes, routeCount, residentialOnly, residential,
 *   business, households, postageCents, permitPostageCents}.
 */
function summarizePick(picked, quote) {
  const routes = (picked && picked.routes) || [];
  const residentialOnly = !!(picked && picked.residentialOnly);
  const sum = (k) => routes.reduce((t, r) => t + (r[k] || 0), 0);
  const counted = !!(quote && quote.ready && quote.possible > 0);
  const residential = counted ? quote.residential : sum("residential");
  const possible = counted ? quote.possible :
    sum("residential") + sum("business");
  const households = residentialOnly ? residential : possible;
  return {
    routes,
    routeCount: routes.length,
    residentialOnly,
    residential,
    business: Math.max(0, possible - residential),
    households,
    countedBy: counted ? "accuzip" : "map",
    postageCents: eddmPostageCents(households),
    permitPostageCents: counted && !residentialOnly ?
      quote.permitPostageCents : 0,
  };
}

/**
 * The routes as one comparable key list ("97202C025", sorted). PURE.
 * @param {Array<{zip: string, crrt: string}>} routes the routes.
 * @return {Array<string>} the keys.
 */
function routeKeys(routes) {
  return (routes || []).map((r) => `${r.zip}${r.crrt}`).sort();
}

/**
 * Whether an earlier recount still counts these routes: the same set,
 * the same homes-only switch, and real numbers. PURE.
 * @param {?object} known an earlier readPick's `counts`.
 * @param {Array<string>} keys routeKeys of the routes now.
 * @param {boolean} residentialOnly businesses left out now.
 * @return {boolean} true when it can be reused.
 */
function countsStillHold(known, keys, residentialOnly) {
  if (!known || typeof known !== "object" ||
      !Array.isArray(known.routeKeys) || !(countOf(known.possible) > 0)) {
    return false;
  }
  return !!known.residentialOnly === !!residentialOnly &&
    known.routeKeys.length === keys.length &&
    known.routeKeys.every((k, i) => k === keys[i]);
}

/**
 * Read back what was picked on a map: the saved routes, counted by
 * AccuZIP's quote (retried while it says it isn't ready), or by [known]
 * when that recount is of the same routes.
 * @param {object} p params.
 * @param {string} p.guid the picker id.
 * @param {boolean} p.residentialOnly businesses left out (from the app).
 * @param {Function} p.fetchFn fetch.
 * @param {?object} [p.known] an earlier readPick's `counts`.
 * @param {Function} [p.sleep] waits between quote tries, for tests.
 * @return {Promise<object>} summarizePick's result plus `counts` (keep it
 *   and pass it back as `known`; null when nothing is picked).
 */
async function readPick({guid, residentialOnly, fetchFn, known = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))}) {
  const savedResp = await fetchFn(`${MOD_EDDM}/ws_save/${guid}`);
  if (!savedResp.ok) {
    throw new Error(`AccuZIP map unreadable (HTTP ${savedResp.status}).`);
  }
  const picked = parseSaved(await savedResp.json());
  picked.residentialOnly = !!residentialOnly;
  if (picked.routes.length === 0) {
    return {...summarizePick(picked, null), counts: null};
  }
  const keys = routeKeys(picked.routes);
  if (countsStillHold(known, keys, picked.residentialOnly)) {
    const counts = {...known, routeKeys: keys};
    return {...summarizePick(picked, {ready: true,
      residential: countOf(known.residential),
      possible: countOf(known.possible),
      permitPostageCents: countOf(known.permitPostageCents)}), counts};
  }
  let quote = null;
  for (let i = 0; i < QUOTE_TRIES; i++) {
    const resp = await fetchFn(`${QUOTE_BASE}/${guid}/QUOTE/true`);
    quote = resp.ok ? parseQuote(await resp.json().catch(() => null)) :
      null;
    if (quote && quote.ready && quote.possible > 0) break;
    if (i < QUOTE_TRIES - 1) await sleep(QUOTE_WAIT_MS);
  }
  if (!quote || !quote.ready || quote.possible <= 0) {
    throw new Error("AccuZIP couldn't count the picked routes yet.");
  }
  return {...summarizePick(picked, quote), counts: {
    routeKeys: keys,
    residentialOnly: picked.residentialOnly,
    residential: quote.residential,
    possible: quote.possible,
    permitPostageCents: quote.permitPostageCents,
  }};
}

/**
 * "97202 C025" — a route as the print team and the post office say it.
 * PURE.
 * @param {{zip: string, crrt: string}} r the route.
 * @return {string} the label.
 */
function routeLabel(r) {
  return `${r.zip} ${r.crrt}`;
}

/**
 * A count for people ("1,572"). PURE.
 * @param {number} n the count.
 * @return {string} the label.
 */
function grouped(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The picked routes as the print team's order fields: the route list
 * they bundle by, the households, the postage, and the map. PURE.
 * @param {object} area the order's resolved routeArea (routes, households,
 *   residentialOnly, postageCents, pickerId).
 * @return {Array<{id: string, label: string, value: string}>} the fields.
 */
function eddmRouteFields(area) {
  if (!area || !Array.isArray(area.routes) || area.routes.length === 0) {
    return [];
  }
  const each = area.routes.map((r) => `${routeLabel(r)} ` +
    `(${grouped(r.residential)} res, ${grouped(r.business)} bus)`);
  const who = area.residentialOnly ? "residential only" :
    "every home and business";
  const out = [
    {id: "eddm_routes", label: `EDDM routes (${area.routes.length})`,
      value: each.join("; ")},
    {id: "eddm_households", label: "EDDM deliveries",
      value: `${grouped(area.households)} (${who})`},
    {id: "eddm_postage", label: "EDDM postage (Retail estimate)",
      value: `$${(area.postageCents / 100).toFixed(2)} at ` +
        `${EDDM_RETAIL_CENTS}¢ each`},
  ];
  if (area.pickerId) {
    out.push({id: "eddm_map", label: "EDDM route map",
      value: pickerUrl(area.pickerId)});
  }
  return out;
}

module.exports = {
  EDDM_HOST,
  EDDM_RETAIL_CENTS,
  PICKER_VERSION,
  MAX_ROUTES,
  cleanGuid,
  pickerUrl,
  countOf,
  mintPicker,
  boundsPath,
  routesNear,
  outlineOf,
  containsPoint,
  routeAt,
  MAP_MARKER,
  seedSelection,
  seedPicker,
  reopenSelection,
  prepareReopen,
  parseRoutes,
  parseSaved,
  parseQuote,
  eddmQuantity,
  eddmPostageCents,
  summarizePick,
  routeKeys,
  countsStillHold,
  readPick,
  routeLabel,
  eddmRouteFields,
};
