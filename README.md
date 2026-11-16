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
| Impulse (`impressions-connect` functions, codebase `connect`) | checks every recipient when a mailing is filed; presorts runs of 200+ pieces |

## What's in it

| File | What |
|---|---|
| `src/classify.js` | What a CASS result means: verified, corrected, missing_secondary, vacant, undeliverable. |
| `src/cass.js` | The CASS request row, the POST (at most 20 rows), and the readings of the reply. |
| `src/presort.js` | AccuZIP's cloud presort: the upload file, the settings (permit, IMb, NCOALink with a PAF), the check of a finished job before its billed download, and the mapping back to recipients. |

### Presort options (both off unless the caller asks)

- **`forwardMovers: true`** (since 1.1.0): a mover NCOALink found a new address for mails there, instead of being left out. AccuZIP writes the new address into the standardized address fields, so **the caller must print those fields**, never the address it uploaded. Moves with no address to mail to (left no forwarding address, abroad, unconfirmed, 18-48 months ago) are still left out.
- **`nonprofit: {name, authNumber, address?}`** (since 1.1.0): prices the run as Nonprofit Marketing Mail for an organization USPS has authorized (PS Form 3624). Its name and number go on the postage statement. Pass `{nonprofit: true}` to `presortOutcome` so a finished job priced at the other rate stops before its billed download.

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
