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
 *   presort.js   AccuZIP's cloud presort for USPS Marketing Mail
 */

"use strict";

const classify = require("./src/classify");
const cass = require("./src/cass");
const presort = require("./src/presort");

module.exports = {
  ...classify,
  ...cass,
  ...presort,
};
