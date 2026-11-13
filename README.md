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
| `src/presort.js` | AccuZIP's cloud presort: the upload file, the settings (permit, IMb, NCOALink with a PAF), the check of a finished job before its billed download, and the mapping back to recipients. |

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
