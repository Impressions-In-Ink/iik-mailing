# iik-mailing

AccuZIP for direct mail: checking addresses against USPS data (CASS),
grading what comes back, and presorting a run for USPS Marketing Mail.

**This package exists so two apps can't disagree about an address.** The
admin app checks mailing lists and ship-to addresses; Impulse checks every
recipient on a paid mailing and presorts the run. Each used to carry its own
copy of the grader, and copies drift. An address one app calls deliverable
must never be one the other refuses.

## Who uses it

| Consumer | What it does with this |
|---|---|
| Admin app (`impressions-admin` functions) | grades mailing lists (`validateAddresses`) and ship-to addresses before a label is bought; standardizes the address the tax resolver looks up |
| Impulse (`impressions-connect` functions, codebase `connect`) | checks every recipient when a mailing is filed; presorts runs of 200+ pieces; estimates postage at checkout (`estimateMailing`) |

## What's in it

| File | What |
|---|---|
| `src/classify.js` | What a CASS result means: verified, corrected, missing_secondary, vacant, undeliverable. |
| `src/cass.js` | The CASS request row, the POST (at most 20 rows), and the readings of the reply. |
| `src/estimate.js` | The checkout estimate: drops rows that can't mail (with reasons), uploads the rest, and reads AccuZIP's free quote. Never processes, never downloads, never checks addresses. |
| `src/presort.js` | AccuZIP's cloud presort: the upload file, the settings (permit, IMb, NCOALink with a PAF), the check of a finished job before its billed download, and the mapping back to recipients. Also EDDM runs (`eddmPresortSettings`, `EDDM_PROCESS`). |
| `src/eddm.js` | EDDM: AccuZIP's carrier-route map (mint, seed, reopen, read the picks, AccuZIP's own household count). Moved from Impulse in 1.4.0. |
| `web/eddm_map.html` | The route-map page both apps host (copy it into each app's `web/`; each has a test that fails when its copy differs). |

### Presort options (all off unless the caller asks)

- **`forwardMovers: true`** (since 1.1.0): a mover NCOALink found a new address for mails there, instead of being left out. AccuZIP writes the new address into the standardized address fields, so **the caller must print those fields**, never the address it uploaded. Moves with no address to mail to (left no forwarding address, abroad, unconfirmed, 18-48 months ago) are still left out.
- **`nonprofit: {name, authNumber, address?}`** (since 1.1.0): prices the run as Nonprofit Marketing Mail for an organization USPS has authorized (PS Form 3624). Its name and number go on the postage statement. Pass `{nonprofit: true}` to `presortOutcome` so a finished job priced at the other rate stops before its billed download.
- **`permit: {number, holderName, holderAddress, crid, dropZip, mailerId?, phone?, nonprofitAuth?}`** (since 1.2.0): mails the run on the CLIENT's own permit. Postage comes out of their permit account, and the mail is entered at the post office that holds the permit (its ZIP replaces the shop's drop ZIP). The shop stays on the statement as the mailing agent, so the agent CRID, the Mailer ID and the barcodes are still ours. `checkClientPermit` is the same check, for a caller that saves permits. Pass `{permitNumber}` to `presortOutcome` (ours or theirs) so a finished job prepared on another permit stops before its billed download.
- **EPS account** (since 1.3.0): `permit.epsAccount`, or `epsAccount` in the shop's settings for its own permit, goes in the postage statement's **EPS Cust. Ref. No.** (`permit_holder_caps`). It labels the charge on the permit holder's USPS Enterprise Payment System history. The account that pays is still the one the permit is linked to.

### EDDM (since 1.4.0)

- **Routes:** `mintPicker` (Direct Mail key) makes an AccuZIP route map; staff or a buyer pick carrier routes on `web/eddm_map.html`; `readPick` reads the picks and AccuZIP's own count (never the page's numbers). Picking and counting are free.
- **Permit (BMEU) presort:** `eddmPresortSettings` + `AccuzipCloud.processEddm` (`EDDM_PROCESS`) run a picked map through AccuZIP's EDDM presort on the same permit, rate and mailing agent as a list run, with carrier-route prices, a flat piece (`eddmPieceProblem`) and no Move Update (no names or addresses, so no PAF). `presortOutcome(q, EDDM_PROCESS, {eddm: true})` checks it before the billed download.
- **Map page options** (in its `#json`): `at: [lat, lng, zoom]` opens a map with nothing saved somewhere (else the whole US), and `geo: 1` makes the page look up searches itself with the Maps geocoder, for a host with no server-side geocoding key.

## Keys stay with the apps

No keys live here. The CASS key (`ACCUZIP_API_KEY`) and the Direct Mail key
(`ACCUZIP_DM_API_KEY`) are Firebase secrets; each app reads its own and
passes it in.

**Never put an AccuZIP response body in an error or a log.** AccuZIP echoes
the API key in its error replies. Every error this package throws names the
status, never the body; keep it that way in callers too.

## Install

Consumers depend on a **tag**, not a branch, so a deploy can never pick up
unreviewed changes. Like `iik-shipping`, use the release tarball URL; Cloud
Build installs it anonymously:

```json
"iik-mailing": "https://github.com/Impressions-In-Ink/iik-mailing/archive/refs/tags/v1.0.0.tar.gz"
```

```js
const {classifyCassRow, callCassBatch, AccuzipCloud} = require("iik-mailing");
```

## Making a change

1. Change `src/`, add or edit a test in `test/`, and run `npm test` and
   `npm run lint`.
2. Bump the version in `package.json`, commit, and tag `vX.Y.Z`.
3. Point both consumers at the new tag, run their tests, and deploy each
   (Impulse: `firebase deploy --only functions:connect:<names>`; admin: its
   own targeted deploy).
