# Pick & Ride Auto — landing pages

State of both paid-traffic landing pages as of **4 September 2026**.

Written in English to match the code comments; every inline comment in
`index.html`, the Worker and the Apps Script is English too.

---

## 1. The two pages

| | Used cars | Fleet |
|---|---|---|
| Repo | `TeamFeyth/picknride_usedcars` | `TeamFeyth/fleet_picknride` |
| Live | `call.picknrideauto.com` | `fleet.picknrideauto.com` |
| Branch | `main` | `master` |
| Also live at | `picknride-usedcars-lp.pages.dev` | `picknride-fleet-lp.pages.dev` |
| Audience | Retail pre-owned buyers | Commercial vans and trucks |
| Extra pages | `thank-you.html` | none — inline success |
| Language toggle | EN / ES | EN / ES |

Both are static Cloudflare Pages sites. Neither has a build step: `index.html`
is a single self-contained file, fonts and images under `assets/`.

The `.pages.dev` URLs still work and still accept form submissions. They are in
`ALLOWED_ORIGINS` on the Worker. Decide whether to keep them — they are two more
surfaces to maintain and two more URLs Google can index.

---

## 2. What is on each page

| | Used cars | Fleet |
|---|---|---|
| GTM | `GTM-N98QJB5R` | `GTM-5ZKFQV77` |
| GA4 | `G-V6NVR31EHE` | `G-FQZ10ZDQ2G` |
| Google Ads tag | `AW-18369471184` **base tag only** | `AW-18369471184` **base tag only** |
| CallRail swap | yes | yes |
| Turnstile | yes | yes |

**Neither page fires a browser-side Google Ads conversion, and neither should.**

Both pages report conversions through one mechanism only: the offline import
that reads the gclid out of the `PNR_GoogleAds_Conversions` feed. That is the
mechanism that covers both pages, and it carries the click id, which a browser
tag does not. The import's conversion action (`Form Capture`) is **Primary**, so
anything fired from a browser lands on top of it.

On 17 Sep 2026 the Ads **base tag** was added back to both pages, at the
client's request, because the Ads account reported no Google tag detected. It is
one `gtag('config', 'AW-18369471184')` line on the `gtag.js` loader each page
already had for GA4 — not a second loader, and not a conversion snippet. It buys
Ads-side pageview data and remarketing audiences, and changes nothing about how
conversions are counted.

That distinction is the whole point, because both of the things removed on
31 Aug 2026 were the other kind:

- Used cars carried a second `gtag.js` loader for `AW-18369471184`, pasted in by
  hand and undocumented. It redefined `gtag()` and fired a second `gtag('js')`
  on every pageview while never reporting a conversion — nothing on the page
  ever called one. Pure duplication.
- Fleet configured `AW-18369471184` and fired a conversion event from its submit
  handler. That would have double counted every fleet lead once the import
  started working: once from the browser, once from the sheet.

So: **do not paste a conversion snippet back into either page**, and do not add a
conversion tag inside either GTM container. If the base tag is not wanted either,
delete the `AW-` config line from both `index.html` files and put this row back
to "none, by design".

---

## 3. How a lead travels

```
Visitor (Google ad → gclid in the URL)
    │
    ▼
Landing page
    ├── captures gclid/gbraid/wbraid/utm_* → sessionStorage (pnr_attr)
    ├── CallRail swap.js → replaces the visible number
    └── form → POST JSON to window.PNR.leadEndpoint
            │
            ▼
    Worker  pnr-lead-relay  (Cloudflare)
            ├── Turnstile, rate limit, honeypot, junk-phone checks
            ├── → DealerCenter Prospect API (XML)
            └── → Apps Script /exec
                        │
                        ▼
            Google Sheet «PNR_Leads»  (the lead database)
                ├── PNR_Leads              ← frozen history
                ├── PNR_Leads_UsedCars
                ├── PNR_Leads_Fleet
                └── PNR_Leads_Unrouted
                        │
                        ▼
            Google Sheet «PNR_Ads_Conversions_FEED»  (separate file)
                └── PNR_GoogleAds_Conversions
                        │
                        ▼
            Google Ads Data Manager → Form Capture
```

Conversions live in a **separate spreadsheet** so whoever runs the Ads account
gets conversion rows and not names, emails and message bodies.

**Phone calls do not travel this path.** CallRail captures them and reports to
Google Ads through its own native integration. Nothing about calls touches the
Worker or either sheet.

---

## 4. Identifiers

| What | Value |
|---|---|
| Worker | `pnr-lead-relay.team-efd.workers.dev` (source in the fleet repo) |
| Google Ads account | `479-890-0905` · `team@feythmarketing.com` |
| Manager account above it | `220-…` — exists, unexplored |
| Google Ads tag on the account | `AW-18369471184` (not on either page) |
| Conversion action | `Form Capture` — Primary, in the "Submit lead form" goal |
| CallRail company | `929436290`, swap key `ee5c10fe11aff979d2f0` — shared by both pages |
| Business phone | `(832) 205-4321` · `tel:+18322054321` — hardcoded on both pages |
| Turnstile site key | `0x4AAAAAAEhNswCm2-B0jwik` (public; secret lives only on the Worker) |
| Lead database | Google Sheet `PNR_Leads` |
| Conversion feed | Google Sheet `PNR_Ads_Conversions_FEED` |

Both pages deliberately share one CallRail company so the campaign can compare
which page drives more calls. Google Ads attributes by click, not by conversion
name, so sharing mixes nothing up.

---

## 5. The `window.PNR` block

The only block you edit to go live. It sits near the top of `index.html`:

```js
window.PNR = {
  leadEndpoint: 'https://pnr-lead-relay.team-efd.workers.dev/lead',
  callRailSrc:  'https://cdn.callrail.com/companies/929436290/…/swap.js'
};
```

**If `leadEndpoint` is missing, both forms stop delivering.** They do not fail
visibly — the handler tells the visitor to call instead. On 31 Aug 2026 this
block was deleted from both repos in a commit called *"Remove PNR configuration
scripts from index.html"*, which meant deploying from the repo would have
silently killed lead capture on both pages. Never remove it.

**If `callRailSrc` is missing, CallRail silently does not load.** It used to
`return` without a word; it now logs a console warning, because a missing value
otherwise looks exactly like a working install.

`thank-you.html` has no `window.PNR` block — it has no form and needs no
endpoint — so its CallRail URL is hardcoded and must be kept in step by hand.

---

## 6. Deploying

Cloudflare Pages, connected to GitHub. Push to `main` (used cars) or `master`
(fleet) and Pages builds.

**The Worker is different: it is deployed from the Cloudflare editor, not with
`wrangler deploy`.** `worker/wrangler.jsonc` in the fleet repo is documentation,
not effective configuration. If anyone ever runs `wrangler deploy`, the plain
text variables in the dashboard are replaced by whatever is in that file.
Secrets survive.

The Apps Script is published with **Deploy → Manage deployments → pencil →
Version: New version**. Never *New deployment* — that mints a new URL and the
Worker keeps posting to the old one, which stays alive and answering.

---

## 7. Rules that break things

1. **Never apply `UPPER`, `LOWER`, `PROPER` or `TRIM` to a `gclid` column.**
   Click ids are case sensitive.
2. **Never move or delete a column in the lead tabs.** The script validates 38
   headers by position and stops writing. Hide them instead.
3. **Never use *New deployment* in Apps Script.** It changes the URL.
4. **Never put a phone number inside a translation dictionary string.** The
   language toggle rewrites whole text nodes, so it would overwrite the number
   CallRail inserted. Numbers live in their own elements with `data-i18n-skip`.
   This has broken call attribution once already.
5. **Do not enable Bot Fight Mode in Cloudflare.** It blocks legitimate
   crawlers including CallRail's verifier. *Note: the generic `/lp-build`
   playbook lists Bot Fight Mode as bot-defence layer 3. This project overrides
   that. The three remaining layers — honeypot, Turnstile, junk-phone
   heuristics — are all server-side and enough.*
6. **Assigning a conversion action to a Data Manager connection needs Admin
   access in Google Ads.** Standard access shows a greyed-out button with no
   explanation. This blocked the project for over two weeks.
7. **`ALLOWED_ORIGINS` on the Worker must list an origin exactly**, scheme and
   all, or the browser's preflight blocks the POST and no lead is ever sent.

---

## 8. Verification

**Worker health, one request, answers almost everything:**

```
curl -s "https://pnr-lead-relay.team-efd.workers.dev/health?deep=1"
```

Expect `configured`, `sheets_backup`, `sheets_secret`, `turnstile_secret`,
`turnstile_enforced`, `lead_source` all `true`, and under `apps_script` a
`min_gclid_length` of **17**. Any other value there means the Worker is talking
to a stale Apps Script deployment.

**gclid capture** — incognito, `sessionStorage.clear()`, open
`https://call.picknrideauto.com/?gclid=TeStCaSe-_123%3D`, then in the console:

```js
JSON.parse(sessionStorage.pnr_attr)
```

`gclid` must read exactly `TeStCaSe-_123=`. `sessionStorage` is per domain, so
testing on used cars proves nothing about fleet.

**CallRail swap** — load either page with `?utm_source=facebook` and watch the
displayed number change. If it does not, check the console for the
`[PNR] CallRail not loaded` warning.

**Turnstile blocks direct POSTs:**

```
curl -i -X POST https://pnr-lead-relay.team-efd.workers.dev/lead -H "Content-Type: application/json" -d "{\"name\":\"Bot Test\",\"phone\":\"8322054321\",\"form_name\":\"curl_test\"}"
```

Expect `403` with `turnstile_failed` / `missing_token`.

**Two invisible limits when testing.** Five submissions per IP per ten minutes
returns `429`. The same phone on the same form inside ten minutes is treated as
a double click and answers `200` with **no row written** — the page shows
success. Vary the phone number between test submissions.

**Duplicate detector.** Run `auditAdsFeed()` in the Apps Script. The baseline
for `leads appearing in >1 tab` is **2** — two legacy leads that were copied
into their routed tab on purpose. **If that number is ever 3 or more, something
is being submitted twice.** That is how the retry bug of 3 Sep was found.

---

## 9. Where this diverges from the standard Feyth stack

`/lp-build` describes Pages Functions, the `feyth-lp-template`, and Zapier
fanning out to Sheets and the CRM. Pick & Ride predates that and does none of
it. The differences are deliberate:

| Standard | Here |
|---|---|
| `functions/api/lead.js` | a standalone Cloudflare Worker |
| Zapier Catch Hook | Worker posts straight to DealerCenter and Apps Script |
| Zap B: CallRail → Sheet | CallRail → Google Ads native only; calls never reach the sheet |
| Bot Fight Mode on | **off** — it blocks CallRail's verifier |
| Template with fixed 9 blocks | bespoke pages, no template |

Do not "fix" this toward the standard without a reason. The Worker exists
because DealerCenter needs a signed XML request that Zapier cannot produce.

---

## 10. Open items

- **`Fleet - Call` is still Primary** in the Contact goal with 0 conversions.
  It was left that way on purpose: demoting it would leave that goal group
  without a primary action and trigger a different warning. Known debt.
- **An API integration uploaded malformed click ids on 18 Aug 2026** and has not
  run since. Change history identifies it as CallRail, connected by
  `hello@feythmarketing.com`. It created three conversion actions — `Phone
  Call`, `First Time Phone Call`, `Repeat Phone Call` — which are all still
  `Misconfigured`. **Now that CallRail is reinstalled, this can wake up.** See
  the warning below.
- **No number pool in CallRail.** A single static tracking number can say a call
  came from Google, not which click, so no call is attributed at click level.
- **`gbraid` / `wbraid` are captured but never uploaded.** The feed carries
  `gclid` only. `adsFeedReport()` counts what that gap costs; it was 0 as of
  4 Sep.
- **The `SECRET` shared with the Apps Script is short and guessable.** Rotate it
  in both places in the same sitting; changing one side drops every lead.
- **Spreadsheet time zone is `America/Caracas`** on a Houston dealership's sheet.
  Harmless for Ads — conversion times carry an explicit UTC offset — but
  `received_at` reads in the wrong local time for whoever calls the lead back.

### Warning about reinstalling CallRail

CallRail's Google Ads integration is still linked to account `479-890-0905`. On
18 Aug 2026 it uploaded conversions whose click ids Google could not decode,
which is what marked `Form Capture` as `Misconfigured` in the first place.

Now that the swap script is back on both pages, **check CallRail → Integrations
→ Google Ads and confirm which conversion action it reports into. It must not be
`Form Capture`.** If it is, CallRail will start writing unparseable click ids
into the one conversion action that finally works, and undo two and a half weeks
of it.

Watch `Form Capture`'s tracking status for a few days after this deploy. It
should stay out of `Misconfigured`.
