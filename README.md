# Pick & Ride Auto Sales — Commercial Fleet Landing Page

Google Ads landing page for the commercial van and truck campaign.
Destination subdomain: **fleet.picknrideauto.com**

Built and maintained by Feyth Marketing.

---

## What's here

```
index.html              the page (self-contained; no build step)
assets/img/             photography, logo, icons — responsive WebP + JPEG fallback
assets/fonts/           self-hosted Barlow / Barlow Condensed subsets
worker/                 Cloudflare Worker that delivers leads to DealerCenter
docs/                   client-supplied source material not yet used on the page
```

The page is plain static HTML. Open `index.html` directly, or serve the folder
with any static server. There is nothing to compile.

---

## Hosting

Live at **https://picknride-fleet-lp.pages.dev** (Cloudflare Pages, account
`hello@feythmarketing.com`).

GitHub Pages is not used: it cannot serve a private repo on the Free plan, and
making this repo public would expose the client photography and the DealerCenter
lead address. Cloudflare Pages hosts it free from the private repo, and keeps the
page on the same platform as the lead Worker.

Deploy is a direct upload of a **staged public-only directory** — never the repo
root. Everything uploaded to Pages is publicly fetchable, so `README.md`,
`worker/` and `docs/` must stay out of it:

```bash
rm -rf dist && mkdir dist
cp index.html _headers dist/ && cp -r assets dist/assets
npx wrangler pages deploy dist --project-name=picknride-fleet-lp --branch=main
```

### Custom domain

`picknrideauto.com` runs on GoDaddy nameservers (`ns59/ns60.domaincontrol.com`),
not Cloudflare. To point the subdomain at the page, add the custom domain in the
Pages project, then create this record at GoDaddy:

```
CNAME   fleet   picknride-fleet-lp.pages.dev
```

Then update `canonical`, `og:url` and `ALLOWED_ORIGINS` to the live subdomain.

## Go-live checklist

Everything below is a one-line edit in the `window.PNR` block at the top of
`index.html`, except where noted.

- [x] **`leadEndpoint`** — set to the deployed Worker,
      `https://pnr-lead-relay.cold-smoke-4aef.workers.dev/lead`.
- [ ] **DealerCenter credentials** — the last thing standing between this page
      and live leads. See *Remaining step: credentials* below. Until they exist
      the form refuses to submit and tells the visitor to call instead; it never
      fakes a success.
- [ ] **`gtmId`** — the real `GTM-XXXXXXX` container. Empty means GTM stays off,
      so no 404 and no phantom container.
- [ ] **CallRail** — already wired to company `929436290`. Confirm the swap
      script is the right one for this rooftop before launch.
- [ ] **Phone number** — the page currently shows `(832) 205-4321` throughout.
      The build doc specifies the CallRail tracking number `832-262-4073`, but
      that instruction sits under the *Used Cars* page, not this one. Confirm
      which number the fleet page should show. Every number is live text with
      class `cr-phone`, so CallRail dynamic insertion can swap it either way.
- [ ] **Sample listings** — the four vehicle cards use real photography but the
      titles, specs and mileage are still placeholders. Replace with real units.
- [ ] **Hero and footer art** — both are the same model in the same cargo van,
      and she is barefoot in both. For a page selling work vehicles to Houston
      business owners this reads off-message, and the pair is repetitive. The
      four lot photos are genuine inventory and would carry more credibility.
      Shipped as supplied; swap when replacement art exists.
- [ ] **Canonical URL** — currently `https://www.picknrideauto.com/commercial-vans/`.
      Update if the page lives at the subdomain instead.

---

## Lead flow

```
visitor submits form
   └─> POST JSON to the Worker
          └─> Worker builds a DealerCenter <ac_application> document
                 └─> POST to the DealerCenter Prospect API
                        └─> DealerCenter returns a GUID for the new prospect
```

GitHub Pages (and Cloudflare Pages) serve static files only — a page cannot hold
the access token or post cross-origin to DealerCenter. The Worker closes that gap.

This replaced an earlier ADF-over-email design. The Prospect API is better here:
no sending domain to onboard, no deliverability risk, and a synchronous GUID
confirming the record was actually created.

### Attribution

Click ids are captured on page load, before any interaction, and stored in
`sessionStorage` under `pnr_attr` so they survive scrolling and anchor jumps.
**First touch wins** — a `gclid` is never overwritten mid-session.

Captured: `gclid`, `gbraid`, `wbraid`, `msclkid`, `fbclid`, `ttclid`, all six
`utm_*`, `campaignid`, `adgroupid`, `creative`, `keyword`, `matchtype`,
`network`, `device`, `placement`, `target`, `targetid`, geo params, plus landing
page, referrer and first-seen timestamp. The GA4 client id is read from the
`_ga` cookie at submit time.

The Prospect API has no field for click ids, so they are written into
`comments`, which DealerCenter stores as a note activity on the prospect. That
is what makes **Google Ads offline conversion import** possible later: pull
closed deals with their `gclid` and upload them as conversions, so Ads optimises
toward vehicles actually sold rather than form fills.

### Remaining step: credentials

The Worker is deployed and serving both landing pages, but it is **inert until
DealerCenter provisions credentials**. `/health` reports `configured:false` and
`POST /lead` returns `503 not_configured`, so no lead is ever silently dropped
and nothing is sent to the CRM.

Two values are needed:

1. **`DEALERCENTER_ACCESS_TOKEN`** — email `support@dealercenter.com` with the
   landing page URL. Store it as a secret, never in `wrangler.jsonc`:
   ```bash
   npx wrangler secret put DEALERCENTER_ACCESS_TOKEN
   ```
2. **`DEALERCENTER_DEALER_ID`** — the DC Company ID from DealerCenter →
   Settings → Dealership → General.

### Testing before production

DealerCenter requires a validated test lead first. The integration environment
demands the literal dealer id `NOWCOM` — not the real Company ID. `wrangler.jsonc`
ships pointed at integration with `NOWCOM` for exactly that reason. Switch both
values to the production endpoint and real Company ID only after DealerCenter
signs off.

### Deploying the Worker

```bash
cd worker && npm install
npm test          # 44 assertions: XML output, validation, CORS, retries, abuse
npx wrangler deploy
```


### Worker behaviour

| Path | Method | Result |
|---|---|---|
| `/lead` | POST | `200` + prospect id on success, `422` bad input, `502` DealerCenter refused it, `503` not yet configured |
| `/health` | GET | liveness probe; reports `configured` true/false |

Only "Could not create a prospect" is retried (DealerCenter documents it as
transient). Bad XML or a wrong dealer id fails fast rather than duplicating.

Spam control is a honeypot field plus a 2-second minimum time-to-submit. Both
return a normal success to the bot and deliver nothing.

---

## Images

All photography was re-encoded for the web: **11.0 MB → 1.6 MB** across
responsive WebP with JPEG fallbacks. Re-run that step if the source art changes;
do not commit multi-megabyte originals, since this page is paid traffic and
Largest Contentful Paint is billable.

Vehicle photos are matched **by make**, not by the filename order in the build
doc — that order is reversed relative to the cards and would have put a
Chevrolet Express photo under the Mercedes-Benz Sprinter heading.

| Card | Photo | Source file |
|---|---|---|
| Mercedes-Benz Sprinter 2500 | `sprinter-*` | vehicle 7 |
| Ford Transit 250 | `transit-*` | vehicle 8 |
| RAM ProMaster 2500 | `promaster-*` | vehicle 9 |
| Chevrolet Express 2500 | `express-*` | vehicle 10 |

### Warranty diagram — open decision

The build doc supplies `diagram.jpeg` for the warranty section. It is a
photorealistic drivetrain render whose colours group **mechanical systems**
(engine, suspension, exhaust). The page's existing inline SVG colours the same
components by **warranty tier**, keyed to the Tier 1 / Tier 2 / Tier 3 legend
directly above it.

Swapping one for the other would leave the legend describing colours the image
does not use — a misleading claim about what is covered. The tier SVG is
therefore still in place, and the client file is parked in
`docs/client-warranty-diagram.jpeg` pending a decision.
