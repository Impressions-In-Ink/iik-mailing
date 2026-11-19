/**
 * Public surface of the mailing package.
 *
 * Consumers import from here rather than reaching into `src/`, so the
 * internal file layout can change without breaking either Cloud Functions
 * codebase:
 *
 *   const {classifyCassRow, callCassBatch, AccuzipCloud} =
 *     require("iik-mailing");
 *
 *   classify.js  what a CASS result means (verified, corrected, vacant…)
 *   cass.js      the CASS request and reply, keys passed in
 *   presort.js   AccuZIP's cloud presort for USPS Marketing Mail (and EDDM)
 *   eddm.js      EDDM carrier routes picked on AccuZIP's map
 *   estimate.js  the checkout estimate from AccuZIP's free quote
 */

"use strict";

const classify = require("./src/classify");
const cass = require("./src/cass");
const presort = require("./src/presort");
const eddm = require("./src/eddm");
const estimate = require("./src/estimate");

module.exports = {
  ...classify,
  ...cass,
  ...presort,
  ...eddm,
  ...estimate,
};
