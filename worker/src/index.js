/**
 * pnr-lead-relay
 * -----------------------------------------------------------------------------
 * Accepts a JSON submission from a Pick & Ride landing page and posts it to the
 * DealerCenter Prospect API (a.k.a. Credit App API / PostXML) as an
 * <ac_application> document.
 *
 * A static page cannot hold the access token or POST cross-origin to
 * DealerCenter. This Worker is the smallest thing that closes that gap.
 *
 * Reference: DealerCenter Prospect API - CRM Integration Guide v2.0 (Mar 2026).
 *
 * Routes
 *   POST /lead    submit a lead
 *   GET  /health  liveness probe
 */

/** Escape the five XML predefined entities. Never interpolate raw user input. */
function xml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Strip control characters and clamp length.
 * DealerCenter fails validation SILENTLY - a value it cannot parse is dropped
 * with no error - so everything is normalised here rather than discovering a
 * missing field in the CRM later.
 */
function clean(value, max = 400) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Split a single "name" input into first/last.
 * Minimum-field rule: first_name + a phone is sufficient, so a single-word
 * name is still a valid prospect.
 */
/* ------------------------------------------------------------------ *
 * Abuse controls                                                      *
 *                                                                     *
 * Everything here runs on the server. The honeypot and the two-second *
 * timer on the pages only stop naive bots: anyone can read the page   *
 * source, find this endpoint and POST straight to it. These checks    *
 * are the ones that cannot be skipped.                                *
 * ------------------------------------------------------------------ */

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * In-memory, and therefore per-isolate: Cloudflare may run several isolates
 * and recycles them, so a determined attacker spread thin across regions can
 * exceed these numbers. It still flattens the common case, which is one host
 * hammering one endpoint, and it costs no extra infrastructure. The durable
 * version of this belongs in a Cloudflare Rate Limiting rule on the dashboard,
 * which is worth adding alongside rather than instead.
 */
const recentByIp = new Map();
const recentLeads = new Map();

function sweep(map, windowMs, now) {
  if (map.size < 500) return;
  for (const [key, value] of map) {
    const last = Array.isArray(value) ? value[value.length - 1] : value;
    if (now - last > windowMs) map.delete(key);
  }
}

function rateLimited(ip, now) {
  if (!ip) return false;
  sweep(recentByIp, RATE_WINDOW_MS, now);
  const hits = (recentByIp.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recentByIp.set(ip, hits);
  return hits.length > RATE_MAX;
}

/** Same person, same form, twice in ten minutes: a double click or a retry. */
function isDuplicate(key, now) {
  sweep(recentLeads, DUPLICATE_WINDOW_MS, now);
  const last = recentLeads.get(key);
  recentLeads.set(key, now);
  return Boolean(last && now - last < DUPLICATE_WINDOW_MS);
}

/**
 * Phone shapes no real North American customer has.
 *
 * Area code and exchange must both start 2-9 under the numbering plan, so
 * 0XX and 1XX are impossible rather than merely unusual, and the 555 exchange
 * is reserved for fiction and directory assistance.
 */
function isJunkPhone(digits) {
  const d = String(digits || '');
  if (d.length !== 10) return true;
  if (/^(\d)\1{9}$/.test(d)) return true;
  if (d === '1234567890' || d === '0123456789') return true;
  if (/^\d{3}555\d{4}$/.test(d)) return true;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return true;
  return false;
}

/**
 * Counts links in free text.
 *
 * One link is not suspicious: a customer pasting the listing they are asking
 * about is doing exactly what the message box is for. Two or more is the
 * signature of link-stuffing spam, and that is where the line goes.
 */
function linkCount(text) {
  const found = String(text || '').match(/https?:\/\/|www\./gi);
  return found ? found.length : 0;
}

/**
 * Cloudflare Turnstile, verified server-side.
 *
 * Fails OPEN when the verification service itself cannot be reached. A
 * Cloudflare outage must never cost real customers; the honeypot, the rate
 * limit and the phone checks still apply in that window.
 */
async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET) return { ok: true, reason: 'not_configured' };
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET);
    body.append('response', token);
    if (ip) body.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json();
    return {
      ok: Boolean(data.success),
      reason: (data['error-codes'] || []).join(',') || 'invalid',
    };
  } catch (err) {
    return { ok: true, reason: 'verify_unavailable' };
  }
}

function splitName(full) {
  const parts = clean(full, 120).split(' ').filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0].slice(0, 50), last: '' };
  return {
    first: parts.shift().slice(0, 50),
    last: parts.join(' ').slice(0, 50),
  };
}

/** Landing-page interest labels -> DealerCenter vehicle fields. */
const VEHICLE_MAP = {
  'Mercedes-Benz Sprinter': { manufacturer: 'MERCEDES-BENZ', model: 'SPRINTER' },
  'Ford Transit': { manufacturer: 'FORD', model: 'TRANSIT' },
  'RAM ProMaster': { manufacturer: 'RAM', model: 'PROMASTER' },
  'Chevrolet Express': { manufacturer: 'CHEVROLET', model: 'EXPRESS' },
};

function vehicleFor(interest) {
  for (const label of Object.keys(VEHICLE_MAP)) {
    if (interest && interest.indexOf(label) === 0) return VEHICLE_MAP[label];
  }
  return null; // "Not sure yet", "Multiple units", generic used-car interest
}

/** Build the <ac_application> payload. */
function buildApplication(lead, env) {
  const a = lead.attribution || {};
  const { first, last } = splitName(lead.name);
  const vehicle = vehicleFor(lead.van_interest);

  // The API has no field for click ids. `comments` is free-form and lands as a
  // note activity on the prospect, so attribution survives into the CRM and can
  // be exported later for Google Ads offline conversion import.
  const notes = [
    ['Interest', lead.van_interest],
    ['Message', lead.message],
    ['Form', lead.form_name],
    ['Landing page', a.landing_page || lead.page_url],
    ['Referrer', a.referrer],
    ['GCLID', a.gclid],
    ['GBRAID', a.gbraid],
    ['WBRAID', a.wbraid],
    ['UTM source', a.utm_source],
    ['UTM medium', a.utm_medium],
    ['UTM campaign', a.utm_campaign],
    ['UTM term', a.utm_term],
    ['UTM content', a.utm_content],
    ['Campaign ID', a.campaignid],
    ['Ad group ID', a.adgroupid],
    ['Creative', a.creative],
    ['Keyword', a.keyword],
    ['Match type', a.matchtype],
    ['Network', a.network],
    ['Device', a.device],
    ['GA client ID', lead.ga_client_id],
    ['First seen', a.first_seen],
    ['Submitted', lead.submitted_at],
  ].filter((p) => p[1]).map((p) => p[0] + ': ' + p[1]).join('\n');

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<ac_application>');
  lines.push('  <dealer>');
  lines.push('    <dealercenter_dealer_id>' + xml(env.DEALERCENTER_DEALER_ID) + '</dealercenter_dealer_id>');
  lines.push('  </dealer>');
  lines.push('  <application_info>');
  lines.push('    <source>' + xml(clean(lead.source || env.LEAD_SOURCE, 100)) + '</source>');
  lines.push('  </application_info>');
  lines.push('  <application_data>');
  lines.push('    <primary_applicant_data>');
  lines.push('      <first_name>' + xml(first) + '</first_name>');
  if (last) lines.push('      <last_name>' + xml(last) + '</last_name>');
  lines.push('      <mobile_phone>' + xml(lead.phone) + '</mobile_phone>');
  if (lead.email) lines.push('      <email_address>' + xml(lead.email) + '</email_address>');
  lines.push('      <preferred_language>' + xml(lead.preferred_language === 'Spanish' ? 'Spanish' : 'English') + '</preferred_language>');
  lines.push('    </primary_applicant_data>');
  if (vehicle) {
    lines.push('    <vehicle>');
    lines.push('      <selected_from_inventory>');
    lines.push('        <manufacturer>' + xml(vehicle.manufacturer) + '</manufacturer>');
    lines.push('        <model>' + xml(vehicle.model) + '</model>');
    lines.push('      </selected_from_inventory>');
    lines.push('    </vehicle>');
  }
  lines.push('    <comments>' + xml(notes) + '</comments>');
  lines.push('  </application_data>');
  lines.push('</ac_application>');
  return lines.join('\n') + '\n';
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const ok = allowed.indexOf('*') !== -1 || allowed.indexOf(origin) !== -1;
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : (allowed[0] || ''),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  });
}

/**
 * DealerCenter signals every failure as HTTP 500 with a human-readable message.
 * Only "Could not create a prospect" is documented as retryable; the rest are
 * our fault (bad XML, wrong dealer id) and retrying just duplicates work.
 */
function isRetryable(text) {
  return /could not create a prospect/i.test(text || '');
}

async function postToDealerCenter(payload, env) {
  const endpoint = env.DEALERCENTER_ENDPOINT;
  const token = env.DEALERCENTER_ACCESS_TOKEN;
  if (!endpoint || !token || !env.DEALERCENTER_DEALER_ID) {
    return { ok: false, status: 0, reason: 'not_configured' };
  }

  let last = { ok: false, status: 0, reason: 'unknown' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml', access_token: token },
        body: payload,
      });
    } catch (err) {
      last = { ok: false, status: 0, reason: 'network_error', detail: String(err && err.message) };
      continue; // transport failure is always worth one retry
    }

    const text = (await res.text()).trim();
    if (res.ok) return { ok: true, status: res.status, prospectId: text.replace(/^"|"$/g, '') };

    last = { ok: false, status: res.status, reason: 'dealercenter_error', detail: text.slice(0, 300) };
    if (!isRetryable(text)) break;
  }
  return last;
}


/**
 * Backup copy of every validated lead, appended to a Google Sheet.
 *
 * Why this exists: DealerCenter is the system of record, but it is a single
 * point of failure. If the token expires, the endpoint changes, or their API
 * has a bad afternoon, the Worker answers 502 and tells the visitor to call.
 * That protects the visitor but the lead itself is gone - nobody can follow
 * up on a submission nobody kept. This writes a row either way, so the sales
 * floor always has a list to work from.
 *
 * SHEETS_WEBHOOK_URL points at a Google Apps Script Web App that does the
 * actual appendRow. Empty = feature off, and the Worker behaves exactly as
 * before. SHEETS_SHARED_SECRET is echoed back to the script so a stranger who
 * guesses the URL cannot inject rows.
 */
async function logToSheet(lead, dcResult, env) {
  // Trimmed because these values are pasted into the Cloudflare dashboard by
  // hand, and a trailing newline is invisible there but makes fetch throw.
  const url = String(env.SHEETS_WEBHOOK_URL || '').trim();

  if (!url) {
    // This used to return silently, which made a misspelled variable name look
    // exactly like a working setup: no request, no log, no row, no clue.
    console.error(
      'Sheet backup skipped: SHEETS_WEBHOOK_URL is empty or missing. ' +
      'Check the name is spelled exactly SHEETS_WEBHOOK_URL on the Worker ' +
      '(not on the Pages project) and that you redeployed after saving it.'
    );
    return { ok: false, reason: 'not_configured' };
  }
  if (url.indexOf('/exec') === -1) {
    console.error(
      'Sheet backup skipped: SHEETS_WEBHOOK_URL does not end in /exec, so it ' +
      'is not a published Apps Script web app URL. Got: ' + url.slice(0, 60)
    );
    return { ok: false, reason: 'bad_url' };
  }

  const row = {
    secret: env.SHEETS_SHARED_SECRET || '',
    submitted_at: lead.submitted_at,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    van_interest: lead.van_interest,
    preferred_language: lead.preferred_language,
    message: lead.message,
    source: lead.source,
    form_name: lead.form_name,
    page_url: lead.page_url,
    ga_client_id: lead.ga_client_id,
    user_agent: lead.user_agent,
    ip: lead.ip,
    attribution: JSON.stringify(lead.attribution || {}),
    // So a human scanning the sheet can tell which rows DealerCenter missed.
    dealercenter_status: dcResult.ok ? 'delivered' : (dcResult.reason || 'failed'),
    dealercenter_prospect_id: dcResult.prospectId || '',
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.error('Sheet backup rejected with HTTP', res.status);
      return { ok: false, reason: 'sheet_error', status: res.status };
    }
    // Apps Script answers 200 even when it refuses the row, so the body is
    // the only place the refusal shows up. Without this, a mismatched SECRET
    // looked like a successful write.
    const text = (await res.text()).slice(0, 300);
    if (text.indexOf('"ok":true') === -1) {
      console.error('Sheet backup refused by the script:', text);
      return { ok: false, reason: 'sheet_refused', detail: text };
    }
    return { ok: true };
  } catch (err) {
    console.error('Sheet backup failed', String(err && err.message));
    return { ok: false, reason: 'network_error' };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') {
      return json({
        ok: true,
        configured: Boolean(env.DEALERCENTER_ACCESS_TOKEN && env.DEALERCENTER_DEALER_ID && env.DEALERCENTER_ENDPOINT),
        sheets_backup: Boolean(env.SHEETS_WEBHOOK_URL),
        turnstile_secret: Boolean(env.TURNSTILE_SECRET),
        turnstile_enforced: String(env.TURNSTILE_ENFORCE || '').toLowerCase() === 'true',
      }, 200, cors);
    }
    if (url.pathname !== '/lead') return json({ ok: false, error: 'not_found' }, 404, cors);
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);

    let lead;
    try {
      lead = await request.json();
    } catch (e) {
      return json({ ok: false, error: 'invalid_json' }, 400, cors);
    }

    // Bots that filled the honeypot get a 200 and go nowhere.
    if (clean(lead.company_website)) return json({ ok: true, skipped: true }, 200, cors);

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const now = Date.now();

    // Flood control first: cheapest check, and it protects everything below it
    // including the outbound call to Turnstile.
    if (rateLimited(ip, now)) {
      return json({ ok: false, error: 'rate_limited' }, 429, cors);
    }

    // Turnstile. Enforcement is a separate switch from the secret so the
    // Worker can be deployed before the pages carry the widget: until
    // TURNSTILE_ENFORCE is 'true' a failure is logged and waved through, and
    // nothing breaks in the gap between the two deploys.
    const enforceTurnstile = String(env.TURNSTILE_ENFORCE || '').toLowerCase() === 'true';
    const turnstile = await verifyTurnstile(clean(lead.turnstile_token, 2048), ip, env);
    if (!turnstile.ok) {
      if (enforceTurnstile) {
        // A real 4xx rather than a silent 200. A visitor whose widget expired
        // must be told to try again; swallowing this would lose real leads to
        // look tidy against bots, which is the wrong trade.
        return json({ ok: false, error: 'turnstile_failed', reason: turnstile.reason }, 403, cors);
      }
      console.log('Turnstile not enforced yet, letting through: ' + turnstile.reason);
    }

    const name = clean(lead.name, 120);
    const phone = clean(lead.phone, 32).replace(/\D/g, '').slice(-10);
    if (!name) return json({ ok: false, error: 'name_required' }, 422, cors);
    if (phone.length !== 10) return json({ ok: false, error: 'phone_invalid' }, 422, cors);

    // Same phone, same form, twice inside ten minutes. Answered as a success
    // because from the visitor's side it was one: they pressed the button
    // twice. Delivering twice would create two prospects and two conversions.
    if (isDuplicate([phone, clean(lead.form_name, 60)].join('|'), now)) {
      return json({ ok: true, duplicate: true }, 200, cors);
    }

    // Heuristics that can be wrong about a real person. These leads are NOT
    // delivered to DealerCenter, but they ARE written to the sheet with the
    // reason attached, so a false positive is visible and recoverable instead
    // of vanishing. Turnstile and rate-limit failures are not logged: those
    // are unambiguously automated, and logging them would hand a bot a way to
    // flood the spreadsheet.
    let spamReason = '';
    if (isJunkPhone(phone)) spamReason = 'junk_phone';
    else if (linkCount(lead.message) >= 2) spamReason = 'links_in_message';
    else if (linkCount(lead.name) >= 1) spamReason = 'link_in_name';

    const normalized = {
      name,
      phone,
      email: clean(lead.email, 200),
      van_interest: clean(lead.van_interest, 120) || 'Not specified',
      message: clean(lead.message, 1000),
      preferred_language: lead.preferred_language === 'Spanish' ? 'Spanish' : 'English',
      source: clean(lead.source, 100),
      form_name: clean(lead.form_name, 60),
      page_url: clean(lead.page_url, 300),
      ga_client_id: clean(lead.ga_client_id, 60),
      submitted_at: clean(lead.submitted_at, 40) || new Date().toISOString(),
      // Both landing pages have always sent user_agent; it used to be dropped
      // here and never reached the sheet. Google Ads uses it, together with the
      // IP below, to strengthen the match when no click id is present.
      user_agent: clean(lead.user_agent, 400),
      // Cloudflare gives us the visitor's real IP for free. The lead body must
      // never be trusted for this: a client can put anything in it.
      ip: clean(request.headers.get('CF-Connecting-IP') || '', 45),
      attribution: {},
    };
    const src = lead.attribution && typeof lead.attribution === 'object' ? lead.attribution : {};
    for (const key of Object.keys(src)) normalized.attribution[clean(key, 40)] = clean(src[key], 300);

    const payload = buildApplication(normalized, env);
    // Flagged leads stop here. They are recorded with the reason in place of
    // the delivery status, which makes them easy to find in the sheet and easy
    // to hand back to sales if a check turns out to have been wrong. The
    // response is a plain 200: a bot learns nothing, and a real person who
    // tripped a heuristic is not left staring at an error while we look into
    // it. The sheet is the safety net that makes this acceptable.
    if (spamReason) {
      console.log('Lead flagged as ' + spamReason + ' from ' + (ip || 'unknown ip'));
      await logToSheet(normalized, { status: 'blocked_spam:' + spamReason }, env);
      return json({ ok: true, filtered: true }, 200, cors);
    }

    const result = await postToDealerCenter(payload, env);

    if (!result.ok) {
      console.error('DealerCenter submit failed', result.reason, result.detail || '', result.status);
      // DealerCenter is the one that dropped it, so the backup is the only
      // copy of this lead. Wait for the write instead of firing and forgetting,
      // and report whether it landed. Costs latency only on the failure path.
      const backup = await logToSheet(normalized, result, env);
      // 503 when we were never wired up, 502 when DealerCenter refused it.
      const status = result.reason === 'not_configured' ? 503 : 502;
      return json({
        ok: false,
        error: result.reason,
        backed_up: backup.ok,
        // Surfaced so the reason is visible in the browser Network tab
        // without having to open the Worker log stream.
        backup_reason: backup.ok ? 'saved' : (backup.reason || 'failed'),
      }, status, cors);
    }

    // Happy path: the lead is already safe in DealerCenter, so the sheet row
    // is bookkeeping. Hand it to waitUntil so the visitor is not kept waiting.
    const backup = logToSheet(normalized, result, env);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(backup);
    else await backup;

    return json({ ok: true, prospect_id: result.prospectId || null }, 200, cors);
  },
};
