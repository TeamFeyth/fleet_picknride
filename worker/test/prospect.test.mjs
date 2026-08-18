/**
 * Tests for the DealerCenter Prospect API relay.
 * Run: npm test
 */
import worker from '../src/index.js';

const ENDPOINT = 'https://app-int0.dealercenter.net/api-gateway/crm-externalintegration/LeadManagement/post-xml';

const baseEnv = () => ({
  DEALERCENTER_ENDPOINT: ENDPOINT,
  DEALERCENTER_DEALER_ID: 'NOWCOM',
  DEALERCENTER_ACCESS_TOKEN: 'test-token-guid',
  LEAD_SOURCE: 'Feyth Marketing - Landing Page',
  ALLOWED_ORIGINS: 'https://fleet.picknrideauto.com,https://call.picknrideauto.com',
});

const GOOD = {
  name: "Maria O'Brien-Reyes & Sons <Fleet>",
  phone: '(832) 555-0142',
  van_interest: 'Mercedes-Benz Sprinter',
  form_name: 'fleet_callback',
  page_url: 'https://fleet.picknrideauto.com/',
  submitted_at: '2026-08-18T05:07:48.913Z',
  ga_client_id: '1234567890.1234567890',
  attribution: {
    gclid: 'TESTGCLID123', utm_source: 'google', utm_medium: 'cpc',
    utm_campaign: 'fleet-vans-houston', campaignid: '22110045',
    keyword: 'cargo van', matchtype: 'e', device: 'm',
    landing_page: 'https://fleet.picknrideauto.com/?gclid=TESTGCLID123',
    referrer: '(direct)', first_seen: '2026-08-18T05:05:39.705Z',
  },
};

const post = (body, origin = 'https://fleet.picknrideauto.com') =>
  new Request('https://w.dev/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });

/** Capture outbound calls to DealerCenter. */
let calls = [];
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: opts.body });
    return handler(calls.length);
  };
}
const okGuid = () => new Response('"3fa85f64-5717-4562-b3fc-2c963f66afa6"', { status: 200 });
const dcError = (msg) => new Response(msg, { status: 500 });

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
};

// ---------------------------------------------------------------- happy path
console.log('\n--- happy path ---');
mockFetch(okGuid);
let res = await worker.fetch(post(GOOD), baseEnv());
let body = await res.json();
check('200 OK', res.status === 200, 'got ' + res.status);
check('returns prospect_id', body.prospect_id === '3fa85f64-5717-4562-b3fc-2c963f66afa6', JSON.stringify(body));
check('one outbound call', calls.length === 1);
check('posts to the configured endpoint', calls[0].url === ENDPOINT);
check('sends access_token header', calls[0].headers.access_token === 'test-token-guid');
check('sends xml content-type', calls[0].headers['Content-Type'] === 'application/xml');

const doc = calls[0].body;
console.log('\n--- ac_application payload ---\n' + doc);

check('root element', doc.includes('<ac_application>') && doc.includes('</ac_application>'));
check('dealer id present', doc.includes('<dealercenter_dealer_id>NOWCOM</dealercenter_dealer_id>'));
check('source present', doc.includes('<source>Feyth Marketing - Landing Page</source>'));
check('first name split', doc.includes('<first_name>Maria</first_name>'));
check('last name split + escaped', doc.includes('<last_name>O&apos;Brien-Reyes &amp; Sons &lt;Fleet&gt;</last_name>'));
check('phone digits only', doc.includes('<mobile_phone>8325550142</mobile_phone>'));
check('preferred_language defaults English', doc.includes('<preferred_language>English</preferred_language>'));
check('manufacturer mapped', doc.includes('<manufacturer>MERCEDES-BENZ</manufacturer>'));
check('model mapped', doc.includes('<model>SPRINTER</model>'));
check('gclid in comments', doc.includes('GCLID: TESTGCLID123'));
check('keyword in comments', doc.includes('Keyword: cargo van'));
check('no unescaped ampersand', !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(doc));
check('no raw control chars', !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(doc));

const stack = [];
let wellFormed = true;
for (const m of doc.matchAll(/<\/?([a-z_]+)(?:\s[^>]*)?\/?>/g)) {
  const raw = m[0], tag = m[1];
  if (raw.startsWith('<?') || raw.endsWith('/>')) continue;
  if (raw.startsWith('</')) { if (stack.pop() !== tag) { wellFormed = false; break; } }
  else stack.push(tag);
}
check('XML well-formed (balanced tags)', wellFormed && stack.length === 0, 'unclosed: ' + stack.join(','));

// ------------------------------------------------------------ normalisation
console.log('\n--- normalisation ---');
mockFetch(okGuid);
await worker.fetch(post({ ...GOOD, name: 'Cher', phone: '18325550142' }), baseEnv());
check('single-word name -> first_name only',
  calls[0].body.includes('<first_name>Cher</first_name>') && !calls[0].body.includes('<last_name>'));
check('leading country code trimmed to 10 digits',
  calls[0].body.includes('<mobile_phone>8325550142</mobile_phone>'));

mockFetch(okGuid);
await worker.fetch(post({ ...GOOD, van_interest: 'Not sure yet, need advice' }), baseEnv());
check('no <vehicle> block for unmapped interest', !calls[0].body.includes('<vehicle>'));

mockFetch(okGuid);
await worker.fetch(post({ ...GOOD, preferred_language: 'Spanish', email: 'a@b.com' }), baseEnv());
check('Spanish honoured', calls[0].body.includes('<preferred_language>Spanish</preferred_language>'));
check('email included when supplied', calls[0].body.includes('<email_address>a@b.com</email_address>'));

// ------------------------------------------------------- validation / abuse
console.log('\n--- validation & abuse ---');
mockFetch(okGuid);
res = await worker.fetch(post({ ...GOOD, name: '' }), baseEnv());
check('empty name -> 422', res.status === 422);
check('nothing sent on invalid input', calls.length === 0);

mockFetch(okGuid);
res = await worker.fetch(post({ ...GOOD, phone: '555' }), baseEnv());
check('short phone -> 422', res.status === 422 && calls.length === 0);

mockFetch(okGuid);
res = await worker.fetch(post({ ...GOOD, company_website: 'http://spam.ru' }), baseEnv());
check('honeypot -> 200, nothing sent', res.status === 200 && calls.length === 0);

mockFetch(okGuid);
res = await worker.fetch(new Request('https://w.dev/lead', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' }), baseEnv());
check('bad json -> 400', res.status === 400);

res = await worker.fetch(new Request('https://w.dev/lead', { method: 'GET' }), baseEnv());
check('GET /lead -> 405', res.status === 405);

res = await worker.fetch(new Request('https://w.dev/nope'), baseEnv());
check('unknown path -> 404', res.status === 404);

res = await worker.fetch(new Request('https://w.dev/lead', {
  method: 'OPTIONS', headers: { Origin: 'https://call.picknrideauto.com' } }), baseEnv());
check('preflight -> 204', res.status === 204);
check('CORS echoes an allowed origin',
  res.headers.get('Access-Control-Allow-Origin') === 'https://call.picknrideauto.com');

res = await worker.fetch(new Request('https://w.dev/lead', {
  method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), baseEnv());
check('CORS does not echo a foreign origin',
  res.headers.get('Access-Control-Allow-Origin') !== 'https://evil.example');

// ------------------------------------------------------------ failure modes
console.log('\n--- failure modes ---');
const unconfigured = { ...baseEnv(), DEALERCENTER_ACCESS_TOKEN: '' };
mockFetch(okGuid);
res = await worker.fetch(post(GOOD), unconfigured);
body = await res.json();
check('missing token -> 503 not_configured', res.status === 503 && body.error === 'not_configured');
check('nothing sent when unconfigured', calls.length === 0);

mockFetch(() => dcError('Invalid Dealer ID.'));
res = await worker.fetch(post(GOOD), baseEnv());
check('DealerCenter rejection -> 502', res.status === 502);
check('non-retryable error tried once', calls.length === 1, 'calls=' + calls.length);

mockFetch(() => dcError('Could not create a prospect. Internal error.'));
res = await worker.fetch(post(GOOD), baseEnv());
check('retryable error retried once', calls.length === 2, 'calls=' + calls.length);
check('still 502 after retry exhausted', res.status === 502);

mockFetch((n) => (n === 1
  ? Promise.reject(new Error('connection reset'))
  : okGuid()));
res = await worker.fetch(post(GOOD), baseEnv());
check('network error retried and recovered', res.status === 200 && calls.length === 2);

console.log('\n--- health ---');
res = await worker.fetch(new Request('https://w.dev/health'), baseEnv());
body = await res.json();
check('/health reports configured:true', res.status === 200 && body.configured === true);
res = await worker.fetch(new Request('https://w.dev/health'), unconfigured);
body = await res.json();
check('/health reports configured:false when token missing', body.configured === false);

// ------------------------------------------------- google sheets backup
console.log('\n--- google sheets backup ---');

const SHEET = 'https://script.google.com/macros/s/AAAA/exec';
const sheetEnv = () => ({ ...baseEnv(), SHEETS_WEBHOOK_URL: SHEET, SHEETS_SHARED_SECRET: 's3cr3t' });
// waitUntil is provided by the runtime; the tests supply one that lets us await.
const makeCtx = () => { const jobs = []; return { waitUntil: (p) => jobs.push(p), jobs }; };
const sheetCalls = () => calls.filter((c) => c.url === SHEET);
const dcCalls = () => calls.filter((c) => c.url === ENDPOINT);

// happy path: row written, and it does not disturb the DealerCenter call
mockFetch((n) => (calls[n - 1].url === SHEET ? new Response('', { status: 200 }) : okGuid()));
let ctx = makeCtx();
res = await worker.fetch(post(GOOD), sheetEnv(), ctx);
await Promise.all(ctx.jobs);
check('lead delivered -> row still written', res.status === 200 && sheetCalls().length === 1);
check('backup does not replace the DealerCenter call', dcCalls().length === 1);
let row = JSON.parse(sheetCalls()[0].body);
check('row carries the shared secret', row.secret === 's3cr3t');
check('row marks the lead as delivered', row.dealercenter_status === 'delivered');
check('row keeps the prospect id', row.dealercenter_prospect_id.length > 10);
check('row keeps attribution as JSON', JSON.parse(row.attribution).gclid === 'TESTGCLID123');
check('row keeps the normalised phone', row.phone === '8325550142');

// the case this feature exists for: DealerCenter refuses, sheet still gets it
mockFetch((n) => (calls[n - 1].url === SHEET
  ? new Response('', { status: 200 })
  : dcError('Invalid Dealer ID.')));
res = await worker.fetch(post(GOOD), sheetEnv(), makeCtx());
body = await res.json();
check('DealerCenter refused -> 502 still', res.status === 502);
check('DealerCenter refused -> lead is backed up', sheetCalls().length === 1);
check('response reports backed_up:true', body.backed_up === true);
row = JSON.parse(sheetCalls()[0].body);
check('row records the failure reason', row.dealercenter_status === 'dealercenter_error');

// unconfigured DealerCenter: the sheet is the only copy
mockFetch(() => new Response('', { status: 200 }));
res = await worker.fetch(post(GOOD), { ...unconfigured, SHEETS_WEBHOOK_URL: SHEET }, makeCtx());
body = await res.json();
check('no token -> 503 and still backed up', res.status === 503 && body.backed_up === true);

// a broken sheet must never turn a good lead into a failure
mockFetch((n) => (calls[n - 1].url === SHEET ? new Response('nope', { status: 500 }) : okGuid()));
ctx = makeCtx();
res = await worker.fetch(post(GOOD), sheetEnv(), ctx);
await Promise.all(ctx.jobs);
check('sheet down -> lead still reported ok', res.status === 200);

mockFetch((n) => { if (calls[n - 1].url === SHEET) throw new Error('dns'); return okGuid(); });
ctx = makeCtx();
res = await worker.fetch(post(GOOD), sheetEnv(), ctx);
await Promise.all(ctx.jobs);
check('sheet unreachable -> lead still reported ok', res.status === 200);

// feature off by default
mockFetch(() => okGuid());
res = await worker.fetch(post(GOOD), baseEnv(), makeCtx());
check('no webhook configured -> nothing extra sent', res.status === 200 && calls.length === 1);

// bots never reach the sheet
mockFetch(() => okGuid());
await worker.fetch(post({ ...GOOD, company_website: 'http://spam.ru' }), sheetEnv(), makeCtx());
check('honeypot hit -> no row written', sheetCalls().length === 0);

// invalid leads never reach the sheet either
mockFetch(() => okGuid());
await worker.fetch(post({ ...GOOD, phone: '555' }), sheetEnv(), makeCtx());
check('invalid phone -> no row written', sheetCalls().length === 0);

res = await worker.fetch(new Request('https://w.dev/health'), sheetEnv());
body = await res.json();
check('/health reports sheets_backup:true', body.sheets_backup === true);
res = await worker.fetch(new Request('https://w.dev/health'), baseEnv());
body = await res.json();
check('/health reports sheets_backup:false when off', body.sheets_backup === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
