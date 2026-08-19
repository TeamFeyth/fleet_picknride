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

    const name = clean(lead.name, 120);
    const phone = clean(lead.phone, 32).replace(/\D/g, '').slice(-10);
    if (!name) return json({ ok: false, error: 'name_required' }, 422, cors);
    if (phone.length !== 10) return json({ ok: false, error: 'phone_invalid' }, 422, cors);

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
      attribution: {},
    };
    const src = lead.attribution && typeof lead.attribution === 'object' ? lead.attribution : {};
    for (const key of Object.keys(src)) normalized.attribution[clean(key, 40)] = clean(src[key], 300);

    const payload = buildApplication(normalized, env);
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
