// Exercises the calendar, calendar-callback and agent (research) functions and the shared calendar module
// with a fake database (two clients: caller and service role) and fake Google, Microsoft and Claude APIs.
const handlers = {}; let current; let env;
globalThis.Deno = { serve: fn => { handlers[current] = fn; }, env: { get: k => env[k] } };

const KEY = Buffer.alloc(32, 7).toString('base64');
const KEY2 = Buffer.alloc(32, 9).toString('base64');
const APP = 'https://www.ourampersand.app';
const T = '11111111-1111-4111-8111-111111111111'; // booked task
const T2 = '22222222-2222-4222-8222-222222222222'; // open task
const T3 = '33333333-3333-4333-8333-333333333333'; // other household's task
const GSCOPE = 'openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events';
const b64u = s => Buffer.from(s).toString('base64url');
const jwt = claims => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify(claims))}.sig`;

/* ---------- fake database ---------- */
let db, calls, fail, caller, signedOut;
const PK = { calendar_connections: ['user_id', 'provider'], calendar_events: ['task_id', 'user_id', 'provider'], calendar_pending: ['k'] };
const DEFAULTS = { calendar_connections: () => ({ check_conflicts: true, add_bookings: true, connected_at: new Date().toISOString(), last_error: null, access_token_enc: null, access_expires_at: null }),
  calendar_events: () => ({ created_at: new Date().toISOString() }) };
const callerHousehold = () => (db.members.find(m => m.user_id === caller) || {}).household_id;
const rlsVisible = (table, r) => table === 'households' ? r.id === callerHousehold() : r.household_id === callerHousehold();
const project = (r, cols) => {
  if (!cols || cols.trim() === '*') return { ...r };
  const o = {}; for (const c of cols.split(',').map(s => s.trim())) o[c] = r[c]; return o;
};
function run(who, table, st) {
  calls.push({ who, table, op: st.op });
  const key = `${who}.${table}.${st.op}`;
  if (fail[key]) return { data: null, error: { message: 'simulated ' + key } };
  if (who === 'caller' && !['members', 'tasks', 'households'].includes(table)) return { data: null, error: { message: 'permission denied for table ' + table } };
  const rows = (db[table] ||= []);
  const match = r => (who === 'service' || rlsVisible(table, r)) && st.filters.every(f => f(r));
  const pkOf = r => (PK[table] || []).map(c => r[c]).join('|');
  if (st.op === 'insert') {
    if (PK[table] && rows.some(r => pkOf(r) === pkOf(st.row))) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
    rows.push({ ...(DEFAULTS[table] ? DEFAULTS[table]() : {}), ...st.row }); return { data: null, error: null };
  }
  if (st.op === 'upsert') {
    const cols = st.opts.onConflict.split(',');
    const ex = rows.find(r => cols.every(c => r[c] === st.row[c]));
    if (ex) Object.assign(ex, st.row); else rows.push({ ...(DEFAULTS[table] ? DEFAULTS[table]() : {}), ...st.row });
    return { data: null, error: null };
  }
  const hit = rows.filter(match);
  if (st.op === 'update') { hit.forEach(r => Object.assign(r, st.patch)); return { data: st.returning ? hit.map(r => project(r, st.cols)) : null, error: null }; }
  if (st.op === 'delete') { db[table] = rows.filter(r => !hit.includes(r)); return { data: null, error: null }; }
  const out = hit.map(r => project(r, st.cols));
  return { data: st.single ? (out[0] ?? null) : out, error: null };
}
function client(who) {
  const from = table => {
    const st = { op: 'select', filters: [], cols: null, returning: false, single: false };
    const api = {
      select(cols) { if (st.op === 'select') st.cols = cols; else { st.returning = true; st.cols = cols; } return api; },
      eq(c, v) { st.filters.push(r => r[c] === v); return api; },
      in(c, vs) { st.filters.push(r => vs.includes(r[c])); return api; },
      lt(c, v) { st.filters.push(r => r[c] < v); return api; },
      neq(c, v) { st.filters.push(r => r[c] !== v); return api; },
      insert(row) { st.op = 'insert'; st.row = row; return api; },
      upsert(row, o) { st.op = 'upsert'; st.row = row; st.opts = o; return api; },
      update(p) { st.op = 'update'; st.patch = p; return api; },
      delete() { st.op = 'delete'; return api; },
      maybeSingle() { st.single = true; return api; }, single() { st.single = true; return api; },
      then(res, rej) { return Promise.resolve().then(() => run(who, table, st)).then(res, rej); },
    };
    return api;
  };
  return { auth: { getUser: async () => ({ data: { user: signedOut ? null : { id: caller } } }) }, from };
}
globalThis.__stub = { createClient: (_url, key) => { if (key === 'service') return client('service'); if (key === 'anon') return client('caller'); throw new Error('unexpected key ' + key); } };

/* ---------- fake Google, Microsoft and Claude ---------- */
let net, prov, evN;
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const userOf = tok => String(tok).split('-')[2]; // g-access-u1 -> u1
globalThis.fetch = async (input, init = {}) => {
  const url = String(input); const method = init.method || 'GET';
  const headers = Object.fromEntries(new Headers(init.headers || {}));
  const body = init.body; const tok = (headers.authorization || '').replace(/^Bearer /, '');
  net.push({ url, method, headers, body });
  if (url === 'https://oauth2.googleapis.com/token' || url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
    const f = Object.fromEntries(new URLSearchParams(body)); const g = url.includes('google');
    if (f.grant_type === 'authorization_code') {
      if (prov.exchange) return prov.exchange(f, g);
      return g ? J({ access_token: 'g-access-new', refresh_token: 'g-refresh-new', expires_in: 3599, id_token: jwt({ email: 'sam@gmail.com' }), scope: GSCOPE })
        : J({ access_token: 'm-access-new', refresh_token: 'm-refresh-new', expires_in: 3600, scope: 'openid email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite' });
    }
    if (prov.invalid.includes(f.refresh_token)) return J({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
    const access = f.refresh_token.replace('refresh', 'access').replace(/-rotated$/, '');
    return J({ access_token: access, expires_in: 3600, ...(g ? {} : { refresh_token: f.refresh_token.replace(/-rotated$/, '') + '-rotated' }) });
  }
  if (url === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
  if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return J({ email: 'from-userinfo@gmail.com' });
  if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
    if (prov.unauthorized.includes(tok)) return J({ error: { message: 'Invalid Credentials' } }, 401);
    if (prov.googleBusyFail) return J({ error: { message: 'Backend Error: internal detail' } }, 500);
    return J({ kind: 'calendar#freeBusy', calendars: { primary: { busy: prov.gbusy[userOf(tok)] || [] } } });
  }
  if (url === 'https://www.googleapis.com/calendar/v3/calendars/primary/events') {
    if (prov.googleCreateFail) return J({ error: { message: 'Backend Error: secret internals' } }, 500);
    return J({ id: 'gev' + (++evN) });
  }
  if (url.startsWith('https://graph.microsoft.com/v1.0/me?')) return J({ mail: null, userPrincipalName: 'alex@outlook.com' });
  if (url.startsWith('https://graph.microsoft.com/v1.0/me/calendarView')) {
    const pages = prov.mpages[userOf(tok)] || [[]];
    const n = Number((/skiptoken=(\d+)/.exec(url) || [])[1] || 0);
    const next = prov.mnext ? prov.mnext(n) : (n + 1 < pages.length ? `https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=${n + 1}` : undefined);
    return J({ value: pages[n] || [], ...(next ? { '@odata.nextLink': next } : {}) });
  }
  if (url === 'https://graph.microsoft.com/v1.0/me/events') {
    if (prov.msCreateFail) return J({ error: { message: 'secret' } }, 503);
    return J({ id: 'msev' + (++evN) }, 201);
  }
  if (url === 'https://api.anthropic.com/v1/messages') {
    prov.prompts.push(JSON.parse(body).messages[0].content);
    return J({ content: [{ type: 'text', text: JSON.stringify(prov.claude) }] });
  }
  return J({ error: 'unexpected url ' + url }, 599);
};

/* ---------- load the code ---------- */
const lib = await import('./.build/calendar-lib.mjs');
current = 'calendar'; await import('./.build/calendar.mjs');
current = 'callback'; await import('./.build/calendar-callback.mjs');
current = 'agent'; await import('./.build/agent-cal.mjs');

const results = [];
const check = (name, cond, info) => { results.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name, cond ? '' : JSON.stringify(info ?? '').slice(0, 400)); };

const future = () => new Date(Date.now() + 30 * 60000).toISOString();
const past = () => new Date(Date.now() - 60000).toISOString();
async function conn(user_id, provider, over = {}) {
  const p = provider === 'google' ? 'g' : 'm'; const aad = `${user_id}:${provider}`;
  return {
    user_id, household_id: over.household_id || 'h', provider, account_email: `${user_id}@${provider}.example`,
    refresh_token_enc: await lib.encryptToken(over.refresh || `${p}-refresh-${user_id}`, aad),
    access_token_enc: await lib.encryptToken(over.access || `${p}-access-${user_id}`, aad),
    access_expires_at: over.expired ? past() : future(),
    check_conflicts: over.check_conflicts ?? true, add_bookings: over.add_bookings ?? true,
    connected_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', last_error: over.last_error ?? null,
  };
}
const booking = (o = {}) => ({ optionId: 'oA', vendor: 'Gutter Pros', date: '2026-11-28', start: '09:00', end: '11:00', capCents: 15050, confirmation: 'AMP-ABCDE', ...o });
async function reset(over = {}) {
  env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', CALENDAR_TOKEN_KEY: KEY, APP_URL: APP,
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', MS_CLIENT_ID: 'mid', MS_CLIENT_SECRET: 'msecret', ANTHROPIC_API_KEY: 'k', ...over.env };
  for (const [k, v] of Object.entries(over.env || {})) if (v === undefined) delete env[k];
  caller = over.caller || 'u1'; signedOut = !!over.signedOut; fail = over.fail || {}; calls = []; net = []; evN = 0;
  prov = { invalid: [], unauthorized: [], gbusy: {}, mpages: {}, prompts: [], claude: null, ...over.prov };
  db = {
    households: [{ id: 'h', home_base: 'Allen, TX', timezone: 'America/Chicago' }, { id: 'h2', home_base: 'Elsewhere', timezone: null }],
    members: [{ household_id: 'h', user_id: 'u1', display_name: 'Sam' }, { household_id: 'h', user_id: 'u2', display_name: 'Alex' }, { household_id: 'h2', user_id: 'u3', display_name: 'Pat' }],
    tasks: [
      { id: T, household_id: 'h', title: 'Get the gutters cleaned', status: 'booked', booking: booking(), log: [] },
      { id: T2, household_id: 'h', title: 'Fix the fence', project: 'home', status: 'open', booking: null, log: [], due: '2026-11-30', due_reason: null, budget_cents: null },
      { id: T3, household_id: 'h2', title: 'Theirs', status: 'booked', booking: booking(), log: [] },
    ],
    calendar_connections: [], calendar_events: [], calendar_pending: [], private_items: [{ user_id: 'u1', title: 'secret' }],
    ...over.db,
  };
}
const call = async (fn, body, method = 'POST') => {
  const r = await handlers[fn](new Request('https://proj.supabase.co/functions/v1/' + fn, { method, headers: { Authorization: 'Bearer t' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: r.status, body: await r.json(), headers: r.headers };
};
const cal = body => call('calendar', body);
const callback = async (qs, method = 'GET') => {
  const r = await handlers.callback(new Request('https://proj.supabase.co/functions/v1/calendar-callback?' + new URLSearchParams(qs), { method }));
  const loc = r.headers.get('location');
  return { status: r.status, loc, q: loc ? new URL(loc).searchParams : null, url: loc ? new URL(loc) : null, cache: r.headers.get('cache-control'), text: loc ? '' : await r.text() };
};
// The caller's session only reads members, tasks and households; nobody reads private_items.
const scoped = () => calls.every(c => c.who === 'service' || ['members', 'tasks', 'households'].includes(c.table)) && !calls.some(c => c.table === 'private_items');
const tokenCalls = () => net.filter(n => /oauth2\.googleapis\.com\/token|oauth2\/v2\.0\/token/.test(n.url));

/* ===================== shared module ===================== */
await reset();
{
  const enc = await lib.encryptToken('refresh-plain-123', 'u1:google');
  const enc2 = await lib.encryptToken('refresh-plain-123', 'u1:google');
  const back = await lib.decryptToken(enc, 'u1:google');
  let wrongAad = null, tampered = null;
  try { await lib.decryptToken(enc, 'u2:google'); } catch (e) { wrongAad = e.code; }
  const [iv, ct] = enc.split('.'); const b = Buffer.from(ct, 'base64'); b[0] ^= 1;
  try { await lib.decryptToken(`${iv}.${b.toString('base64')}`, 'u1:google'); } catch (e) { tampered = e.code; }
  check('encryption: round-trip, "iv.ciphertext", random IV, bound to its row, tamper detected',
    back === 'refresh-plain-123' && /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(enc) && enc !== enc2 && !enc.includes('refresh-plain') && wrongAad === 'decrypt_failed' && tampered === 'decrypt_failed', { enc, wrongAad, tampered });
  env.CALENDAR_TOKEN_KEY = KEY2;
  let otherKey = null; try { await lib.decryptToken(enc, 'u1:google'); } catch (e) { otherKey = e.code; }
  env.CALENDAR_TOKEN_KEY = KEY;
  check('encryption: a different CALENDAR_TOKEN_KEY cannot decrypt', otherKey === 'decrypt_failed', otherKey);

  const s = await lib.signState({ uid: 'u1', provider: 'google', returnTo: APP + '/' });
  const v = await lib.verifyState(s);
  const [body, sig] = s.split('.');
  const forged = b64u(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), uid: 'u2' }));
  const t1 = await lib.verifyState(`${forged}.${sig}`);
  const t2 = await lib.verifyState(`${body}.${sig.slice(0, -2)}AA`);
  const t3 = await lib.verifyState('garbage');
  const old = await lib.signState({ uid: 'u1', provider: 'google', returnTo: APP + '/' }, Date.now() - 11 * 60000);
  const t4 = await lib.verifyState(old);
  env.CALENDAR_TOKEN_KEY = KEY2; const t5 = await lib.verifyState(s); env.CALENDAR_TOKEN_KEY = KEY;
  check('state: HMAC verifies; tampered body or signature, garbage, other key rejected; expired detected',
    v.ok && v.state.uid === 'u1' && v.state.nonce && v.state.exp > Date.now() && !t1.ok && t1.reason === 'bad_state' && !t2.ok && t2.reason === 'bad_state'
    && t3.reason === 'bad_state' && t4.reason === 'expired' && t4.state.uid === 'u1' && t5.reason === 'bad_state', { v, t1, t2, t4 });

  const z = (d, t, tz) => new Date(lib.zonedToUtc(d, t, tz)).toISOString();
  const cases = [
    ['2026-03-07', '09:00', 'America/New_York', '2026-03-07T14:00:00.000Z'], // EST
    ['2026-03-08', '01:30', 'America/New_York', '2026-03-08T06:30:00.000Z'], // just before spring forward
    ['2026-03-08', '02:30', 'America/New_York', '2026-03-08T07:30:00.000Z'], // in the gap: moves forward to 03:30 EDT
    ['2026-03-08', '03:30', 'America/New_York', '2026-03-08T07:30:00.000Z'], // EDT
    ['2026-03-08', '09:00', 'America/New_York', '2026-03-08T13:00:00.000Z'],
    ['2026-11-01', '00:30', 'America/New_York', '2026-11-01T04:30:00.000Z'],
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00.000Z'], // happens twice: the earlier (EDT)
    ['2026-11-01', '02:00', 'America/New_York', '2026-11-01T07:00:00.000Z'],
    ['2026-03-29', '01:30', 'Europe/London', '2026-03-29T01:30:00.000Z'], // gap: 02:30 BST
    ['2026-10-25', '01:30', 'Europe/London', '2026-10-25T00:30:00.000Z'], // twice: the earlier (BST)
    ['2026-04-05', '02:30', 'Australia/Sydney', '2026-04-04T15:30:00.000Z'], // twice: the earlier (AEDT)
    ['2026-10-04', '02:30', 'Australia/Sydney', '2026-10-03T16:30:00.000Z'], // gap: 03:30 AEDT
    ['2026-11-28', '09:00', 'Asia/Kolkata', '2026-11-28T03:30:00.000Z'],
    ['2026-11-28', '00:00', 'UTC', '2026-11-28T00:00:00.000Z'],
    ['2026-12-31', '23:30', 'Pacific/Kiritimati', '2026-12-31T09:30:00.000Z'],
  ];
  const bad = cases.filter(([d, t, tz, want]) => z(d, t, tz) !== want).map(([d, t, tz, want]) => ({ d, t, tz, want, got: z(d, t, tz) }));
  check('zonedToUtc: correct across spring-forward gaps and fall-back overlaps in several zones', bad.length === 0, bad);
  // Times in a spring-forward gap don't exist, so they can't round-trip; leave those out.
  const gaps = ['2026-03-08 02:30 America/New_York', '2026-03-29 01:30 Europe/London', '2026-10-04 02:30 Australia/Sydney'];
  const rt = cases.filter(([d, t, tz]) => !gaps.includes(`${d} ${t} ${tz}`)).every(([d, t, tz]) => { const l = lib.utcToLocal(lib.zonedToUtc(d, t, tz), tz); return l.date === d && l.time === t; });
  check('utcToLocal round-trips', rt);
  check('rfc3339Local gives the offset in force', lib.rfc3339Local(Date.parse('2026-03-07T14:00:00Z'), 'America/New_York') === '2026-03-07T09:00:00-05:00'
    && lib.rfc3339Local(Date.parse('2026-03-08T13:00:00Z'), 'America/New_York') === '2026-03-08T09:00:00-04:00'
    && lib.rfc3339Local(Date.parse('2026-11-28T03:30:00Z'), 'Asia/Kolkata') === '2026-11-28T09:00:00+05:30');
  const over = lib.localInterval({ date: '2026-11-28', start: '22:00', end: '01:00' }, 'UTC');
  check('localInterval: an end before the start is the next day', over[1] - over[0] === 3 * 3600000, over);
  check('strict validation: impossible dates, bad times and unknown zones rejected',
    lib.isDay('2026-02-28') && !lib.isDay('2026-02-30') && !lib.isDay('2026-13-01') && !lib.isDay('26-1-1') && !lib.isDay(null)
    && lib.isTime('9:00') && lib.isTime('23:59') && !lib.isTime('24:00') && !lib.isTime('9am')
    && lib.isTz('America/Chicago') && lib.isTz('UTC') && !lib.isTz('Nope/Nowhere') && !lib.isTz('../etc/passwd') && !lib.isTz(''));
}

/* ===================== status ===================== */
await reset();
db.calendar_connections = [await conn('u1', 'google', { last_error: 'reconnect' }), await conn('u2', 'microsoft', { add_bookings: false }), await conn('u3', 'google')];
let r = await cal({ action: 'status' });
const mine = r.body.mine, partner = r.body.partner;
check('status: configured flags, my connections with email, partner without email or tokens',
  r.status === 200 && r.body.configured.google === true && r.body.configured.microsoft === true
  && mine.length === 1 && mine[0].provider === 'google' && mine[0].account_email === 'u1@google.example' && mine[0].last_error === 'reconnect' && mine[0].check_conflicts === true && mine[0].connected_at
  && partner.length === 1 && JSON.stringify(partner[0]) === JSON.stringify({ provider: 'microsoft', check_conflicts: true, add_bookings: false })
  && !JSON.stringify(r.body).includes('u2@microsoft') && !/_enc|refresh|access/.test(JSON.stringify(r.body)) && !JSON.stringify(r.body).includes('u3'), r.body);
check('status: caller session reads no calendar table', scoped(), calls);
await reset({ env: { CALENDAR_TOKEN_KEY: 'c2hvcnQ=' } });
r = await cal({ action: 'status' });
const weak = r.body.configured;
await reset({ env: { MS_CLIENT_SECRET: undefined } });
r = await cal({ action: 'status' });
check('status: not configured without a usable key (32+ bytes) or without a client secret', weak.google === false && weak.microsoft === false && r.body.configured.google === true && r.body.configured.microsoft === false, { weak, r: r.body });
await reset({ signedOut: true });
r = await cal({ action: 'status' });
check('no session: 401 not_signed_in', r.status === 401 && r.body.error === 'not_signed_in' && calls.length === 0, r);

/* ===================== connect ===================== */
await reset({ env: { GOOGLE_CLIENT_SECRET: undefined } });
r = await cal({ action: 'connect', provider: 'google', returnTo: APP + '/' });
check('connect: provider not configured -> 409 not_configured', r.status === 409 && r.body.error === 'not_configured', r);

await reset();
r = await cal({ action: 'connect', provider: 'google', returnTo: APP + '/?tab=settings' });
let u = new URL(r.body.url); let st = await lib.verifyState(u.searchParams.get('state'));
check('connect google: auth URL with scopes, offline access, consent, redirect URI and signed state',
  r.status === 200 && u.origin + u.pathname === 'https://accounts.google.com/o/oauth2/v2/auth' && u.searchParams.get('client_id') === 'gid'
  && u.searchParams.get('scope') === GSCOPE && u.searchParams.get('access_type') === 'offline' && u.searchParams.get('prompt') === 'consent'
  && u.searchParams.get('include_granted_scopes') === 'true' && u.searchParams.get('response_type') === 'code'
  && u.searchParams.get('redirect_uri') === 'https://proj.supabase.co/functions/v1/calendar-callback'
  && st.ok && st.state.uid === 'u1' && st.state.provider === 'google' && st.state.returnTo === APP + '/?tab=settings'
  && st.state.exp - Date.now() > 9 * 60000 && st.state.exp - Date.now() <= 10 * 60000 && !r.body.url.includes('gsecret'), { url: r.body.url, st });

r = await cal({ action: 'connect', provider: 'microsoft', returnTo: 'http://localhost:5173/' });
u = new URL(r.body.url); st = await lib.verifyState(u.searchParams.get('state'));
check('connect microsoft: common tenant, scopes incl. offline_access and Calendars.ReadWrite; localhost returnTo kept',
  u.origin + u.pathname === 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' && u.searchParams.get('client_id') === 'mid'
  && u.searchParams.get('scope') === 'openid email offline_access User.Read Calendars.ReadWrite' && u.searchParams.get('response_mode') === 'query'
  && st.state.provider === 'microsoft' && st.state.returnTo === 'http://localhost:5173/', r.body.url);

const badReturns = ['https://evil.example/', 'https://www.ourampersand.app.evil.com/', 'https://www.ourampersand.app@evil.com/', 'javascript:alert(1)', '//evil.example/', 'http://localhost.evil.com/', 42];
const fellBack = [];
for (const rt of badReturns) {
  r = await cal({ action: 'connect', provider: 'google', returnTo: rt });
  fellBack.push((await lib.verifyState(new URL(r.body.url).searchParams.get('state'))).state.returnTo);
}
check('connect: a returnTo off APP_URL\'s origin falls back to APP_URL', fellBack.every(x => x === APP + '/'), fellBack);
r = await cal({ action: 'connect', provider: 'yahoo', returnTo: APP });
check('connect: unknown provider -> 400', r.status === 400 && r.body.error === 'bad_request', r);
await reset({ db: { members: [{ household_id: 'h2', user_id: 'u3', display_name: 'Pat' }] }, caller: 'u9' });
r = await cal({ action: 'connect', provider: 'google', returnTo: APP });
check('connect: not in a household -> 400 no_household', r.status === 400 && r.body.error === 'no_household', r);

/* ===================== callback ===================== */
const stateFor = (o = {}, now) => lib.signState({ uid: 'u1', provider: 'google', returnTo: APP + '/?tab=settings', ...o }, now);
const connWrites = () => calls.filter(c => c.table === 'calendar_connections' && c.op !== 'select');
await reset();
db.calendar_pending = [{ k: 'old', uid: 'u2', provider: 'google', refresh_token_enc: 'x', expires_at: past() }];
let cb = await callback({ code: 'good-code', state: await stateFor() });
let pend = db.calendar_pending.find(x => x.k === cb.q.get('k'));
const ex = tokenCalls()[0]; const exForm = ex && Object.fromEntries(new URLSearchParams(ex.body));
check('callback google: 302 back with ?calendar=pending&provider=google&k=<32 random bytes>, no-store',
  cb.status === 302 && cb.url.origin === APP && cb.q.get('calendar') === 'pending' && cb.q.get('provider') === 'google' && /^[A-Za-z0-9_-]{43}$/.test(cb.q.get('k'))
  && cb.q.get('tab') === 'settings' && !cb.q.get('reason') && cb.cache === 'no-store', cb);
check('callback: never writes calendar_connections; parks encrypted tokens in calendar_pending (expired rows cleared)',
  connWrites().length === 0 && db.calendar_connections.length === 0 && db.calendar_pending.length === 1 && pend
  && pend.uid === 'u1' && pend.household_id === 'h' && pend.provider === 'google' && pend.account_email === 'sam@gmail.com'
  && Date.parse(pend.expires_at) - Date.parse(pend.created_at) === 10 * 60000, { calls: connWrites(), pend });
check('callback: code exchanged with secret and redirect URI', exForm.code === 'good-code' && exForm.client_secret === 'gsecret' && exForm.grant_type === 'authorization_code'
  && exForm.redirect_uri === 'https://proj.supabase.co/functions/v1/calendar-callback', exForm);
let aadOk = null; try { await lib.decryptToken(pend.refresh_token_enc, 'u1:google'); aadOk = 'decrypted without k'; } catch { aadOk = 'needs k'; }
check('callback: pending tokens encrypted (no plaintext stored) with associated data that includes k',
  !JSON.stringify(db).includes('g-refresh-new') && !JSON.stringify(db).includes('g-access-new') && aadOk === 'needs k'
  && await lib.decryptToken(pend.refresh_token_enc, `pending:${pend.k}:u1:google`) === 'g-refresh-new', aadOk);

const finish = (k, who = 'u1') => { caller = who; return cal({ action: 'finish', k }); };
const k1 = pend.k;
r = await finish(k1);
let row = db.calendar_connections.find(c => c.user_id === 'u1' && c.provider === 'google');
check('finish by the same person: connected, pending row deleted, response {ok, provider}',
  r.status === 200 && JSON.stringify(r.body) === '{"ok":true,"provider":"google"}' && db.calendar_pending.length === 0
  && row && row.household_id === 'h' && row.account_email === 'sam@gmail.com' && row.check_conflicts === true && row.add_bookings === true && row.last_error === null
  && Date.parse(row.access_expires_at) > Date.now() + 3500000, { body: r.body, row });
check('finish: connection tokens re-encrypted for the connection row, no plaintext stored',
  !JSON.stringify(db).includes('g-refresh-new') && await lib.decryptToken(row.refresh_token_enc, 'u1:google') === 'g-refresh-new'
  && await lib.decryptToken(row.access_token_enc, 'u1:google') === 'g-access-new', row);
r = await finish(k1);
check('finish: replaying the same k -> 404 not_found', r.status === 404 && r.body.error === 'not_found' && db.calendar_connections.length === 1, r);

await reset();
cb = await callback({ code: 'c', state: await stateFor() });
r = await finish(cb.q.get('k'), 'u2');
check('finish by a different signed-in person -> 403 not_yours, pending row deleted, nothing connected',
  r.status === 403 && r.body.error === 'not_yours' && db.calendar_pending.length === 0 && db.calendar_connections.length === 0, r);
r = await finish(cb.q.get('k'), 'u1');
check('finish: after a not_yours the real owner can no longer use that k (404)', r.status === 404 && db.calendar_connections.length === 0, r);

await reset();
cb = await callback({ code: 'c', state: await stateFor() });
db.calendar_pending[0].expires_at = past();
r = await finish(cb.q.get('k'));
check('finish: expired -> 410 expired, row deleted, nothing connected', r.status === 410 && r.body.error === 'expired' && db.calendar_pending.length === 0 && db.calendar_connections.length === 0, r);
const badK = await Promise.all([finish('short'), finish(undefined), finish('x'.repeat(43) + '!')]);
check('finish: malformed k -> 400', badK.every(x => x.status === 400 && x.body.error === 'bad_request'), badK.map(x => x.body));
await reset({ fail: { 'service.calendar_connections.upsert': true } });
cb = await callback({ code: 'c', state: await stateFor() });
r = await finish(cb.q.get('k'));
check('finish: connection write fails -> 500 db_error, pending row kept for a retry', r.status === 500 && r.body.error === 'db_error' && db.calendar_pending.length === 1, r);
await reset();
cb = await callback({ code: 'c', state: await stateFor() });
r = await finish(cb.q.get('k'), 'u9');
check('finish: caller not in a household -> 400 no_household, nothing connected', r.status === 400 && r.body.error === 'no_household' && db.calendar_connections.length === 0, r);

await reset();
db.calendar_connections = [await conn('u2', 'microsoft', { check_conflicts: false, add_bookings: false, last_error: 'reconnect' })];
cb = await callback({ code: 'mcode', state: await stateFor({ uid: 'u2', provider: 'microsoft', returnTo: 'http://127.0.0.1:8080/' }) });
const mex = Object.fromEntries(new URLSearchParams(tokenCalls()[0].body));
r = await finish(cb.q.get('k'), 'u2');
row = db.calendar_connections.find(c => c.user_id === 'u2');
check('callback + finish microsoft (reconnect): email from /me, scope sent, toggles kept, last_error cleared',
  cb.status === 302 && cb.loc.startsWith('http://127.0.0.1:8080/?') && cb.q.get('calendar') === 'pending' && cb.q.get('provider') === 'microsoft'
  && mex.scope === 'openid email offline_access User.Read Calendars.ReadWrite' && mex.client_secret === 'msecret' && r.body.provider === 'microsoft'
  && db.calendar_connections.length === 1 && row.account_email === 'alex@outlook.com' && row.check_conflicts === false && row.add_bookings === false && row.last_error === null
  && await lib.decryptToken(row.refresh_token_enc, 'u2:microsoft') === 'm-refresh-new', { cb, row });

await reset();
const good = await stateFor();
const [sb_, ss_] = good.split('.');
const evilBody = b64u(JSON.stringify({ ...JSON.parse(Buffer.from(sb_, 'base64url')), uid: 'u2', returnTo: 'https://evil.example/' }));
cb = await callback({ code: 'c', state: `${evilBody}.${ss_}` });
check('callback: tampered state -> back to APP_URL with reason=bad_state, nothing exchanged or stored',
  cb.status === 302 && cb.url.origin === APP && cb.q.get('calendar') === 'error' && cb.q.get('reason') === 'bad_state' && !cb.q.get('provider')
  && tokenCalls().length === 0 && db.calendar_pending.length === 0 && cb.cache === 'no-store', cb);
cb = await callback({ code: 'c' });
check('callback: missing state -> bad_state', cb.q.get('reason') === 'bad_state' && tokenCalls().length === 0, cb);

cb = await callback({ code: 'c', state: await stateFor({}, Date.now() - 11 * 60000) });
check('callback: expired state -> reason=expired, nothing exchanged', cb.status === 302 && cb.q.get('reason') === 'expired' && cb.q.get('provider') === 'google' && cb.q.get('tab') === 'settings' && tokenCalls().length === 0, cb);

cb = await callback({ error: 'access_denied', error_description: '<script>alert(1)</script>', state: await stateFor() });
check('callback: provider error param -> reason=denied, provider text not passed on', cb.q.get('reason') === 'denied' && !/script|alert/.test(cb.loc) && tokenCalls().length === 0, cb);
cb = await callback({ error: 'server_error', state: await stateFor() });
check('callback: other provider error -> reason=provider_error', cb.q.get('reason') === 'provider_error', cb);

cb = await callback({ code: 'c', state: await stateFor({ provider: 'yahoo' }) });
check('callback: unknown provider in state -> reason=unknown_provider', cb.q.get('reason') === 'unknown_provider' && tokenCalls().length === 0, cb);

cb = await callback({ code: 'c', state: await stateFor({ returnTo: 'https://evil.example/x' }) });
check('callback: a returnTo that is not allowed is replaced by APP_URL even in a signed state', cb.url.origin === APP && cb.q.get('calendar') === 'pending', cb);

await reset({ prov: { exchange: () => J({ error: 'invalid_grant', error_description: 'Bad Request: secret internals <b>' }, 400) } });
cb = await callback({ code: 'used-code', state: await stateFor() });
check('callback: code exchange fails -> reason=exchange_failed, no provider text, nothing stored',
  cb.status === 302 && cb.q.get('calendar') === 'error' && cb.q.get('reason') === 'exchange_failed' && !/secret|internals/i.test(cb.loc) && db.calendar_pending.length === 0, cb);
await reset({ prov: { exchange: () => J({ access_token: 'a', expires_in: 3600, scope: GSCOPE }) } });
cb = await callback({ code: 'c', state: await stateFor() });
check('callback: no refresh token -> reason=no_refresh_token', cb.q.get('reason') === 'no_refresh_token' && db.calendar_pending.length === 0, cb);
await reset({ prov: { exchange: () => J({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/calendar.freebusy' }) } });
cb = await callback({ code: 'c', state: await stateFor() });
check('callback: calendar scope unticked on the consent screen -> reason=missing_scopes', cb.q.get('reason') === 'missing_scopes' && db.calendar_pending.length === 0, cb);
await reset({ fail: { 'service.calendar_pending.insert': true } });
cb = await callback({ code: 'c', state: await stateFor() });
check('callback: database write fails -> reason=db_error, no k', cb.q.get('reason') === 'db_error' && !cb.q.get('k'), cb);
await reset({ env: { CALENDAR_TOKEN_KEY: undefined } });
cb = await callback({ code: 'c', state: 'x.y' });
check('callback: not configured -> error redirect to APP_URL, no exchange', cb.status === 302 && cb.url.origin === APP && cb.q.get('calendar') === 'error' && tokenCalls().length === 0, cb);
await reset();
cb = await callback({ code: 'c', state: await stateFor({ uid: 'u9' }) });
check('callback: person no longer in a household -> reason=no_household', cb.q.get('reason') === 'no_household' && tokenCalls().length === 0, cb);
cb = await callback({ code: 'c', state: await stateFor() }, 'POST');
check('callback: only GET', cb.status === 405 && cb.cache === 'no-store', cb);

/* ===================== busy ===================== */
const busyReq = (o = {}) => cal({ action: 'busy', from: '2026-11-28', to: '2026-11-29', tz: 'America/Chicago', ...o });
await reset({ prov: {
  gbusy: { u1: [{ start: '2026-11-28T15:00:00Z', end: '2026-11-28T16:00:00Z' }, { start: '2026-11-28T15:30:00Z', end: '2026-11-28T17:00:00Z' }], u2: [{ start: '2026-11-28T20:00:00Z', end: '2026-11-28T21:00:00Z' }] },
  mpages: { u1: [
    [{ start: { dateTime: '2026-11-28T16:30:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-28T18:00:00.0000000', timeZone: 'UTC' }, showAs: 'busy' },
     { start: { dateTime: '2026-11-29T01:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-29T02:00:00.0000000', timeZone: 'UTC' }, showAs: 'free' }],
    [{ start: { dateTime: '2026-11-29T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-29T15:00:00.0000000', timeZone: 'UTC' }, showAs: 'tentative' },
     { start: { dateTime: '2026-11-29T16:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-29T17:00:00.0000000', timeZone: 'UTC' }, showAs: 'busy', isCancelled: true },
     { start: { dateTime: '2026-11-27T20:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-28T07:00:00.0000000', timeZone: 'UTC' }, showAs: 'oof' }],
  ] },
} });
db.calendar_connections = [await conn('u1', 'google'), await conn('u1', 'microsoft'), await conn('u2', 'google'), await conn('u2', 'microsoft', { check_conflicts: false }), await conn('u3', 'google')];
r = await busyReq();
const fb = net.find(n => n.url.endsWith('/freeBusy'));
const views = net.filter(n => n.url.includes('calendarView'));
check('busy: merged per person, who relative to the caller, clipped to local midnights',
  r.status === 200 && JSON.stringify(r.body.busy) === JSON.stringify([
    { start: '2026-11-28T06:00:00.000Z', end: '2026-11-28T07:00:00.000Z', who: 'me' },
    { start: '2026-11-28T15:00:00.000Z', end: '2026-11-28T18:00:00.000Z', who: 'me' },
    { start: '2026-11-28T20:00:00.000Z', end: '2026-11-28T21:00:00.000Z', who: 'partner' },
    { start: '2026-11-29T14:00:00.000Z', end: '2026-11-29T15:00:00.000Z', who: 'me' },
  ]) && JSON.stringify(r.body.checked) === '{"me":true,"partner":true}' && r.body.errors.length === 0, r.body);
check('busy: Google freeBusy asked for primary over the local-day range',
  fb && JSON.stringify(JSON.parse(fb.body)) === JSON.stringify({ timeMin: '2026-11-28T06:00:00.000Z', timeMax: '2026-11-30T06:00:00.000Z', items: [{ id: 'primary' }] }), fb && fb.body);
check('busy: Microsoft calendarView with UTC preference, only start/end/showAs selected, nextLink followed, free and cancelled ignored',
  views.length === 2 && views[0].headers.prefer === 'outlook.timezone="UTC"' && /\$select=start,end,showAs,isCancelled/.test(views[0].url)
  && /startDateTime=2026-11-28T06%3A00%3A00.000Z/.test(views[0].url) && /skiptoken=1/.test(views[1].url) && !views.some(v => /subject|body/.test(v.url)), views.map(v => v.url));
check('busy: check_conflicts=false connection skipped; other household never read', net.filter(n => n.headers.authorization === 'Bearer m-access-u2').length === 0
  && net.filter(n => (n.headers.authorization || '').endsWith('u3')).length === 0 && scoped(), net.map(n => n.headers.authorization));
caller = 'u2';
r = await busyReq();
check('busy: who flips when the partner asks', r.body.busy.filter(b => b.who === 'me').length === 1 && r.body.busy.filter(b => b.who === 'partner').length === 3, r.body);

await reset({ prov: { gbusy: { u1: [{ start: '2026-11-28T15:00:00Z', end: '2026-11-28T16:00:00Z' }] }, mpages: { u2: [[]] } } });
db.calendar_connections = [await conn('u1', 'google', { expired: true }), await conn('u2', 'microsoft', { expired: true })];
r = await busyReq();
const rows = db.calendar_connections;
const gRow = rows.find(c => c.provider === 'google'), mRow = rows.find(c => c.provider === 'microsoft');
check('busy: expired access tokens refreshed and stored encrypted (rotated Microsoft refresh token kept)',
  r.body.checked.me && r.body.checked.partner && r.body.busy.length === 1 && tokenCalls().length === 2
  && tokenCalls().every(t => new URLSearchParams(t.body).get('grant_type') === 'refresh_token')
  && Date.parse(gRow.access_expires_at) > Date.now() + 3000000 && await lib.decryptToken(gRow.access_token_enc, 'u1:google') === 'g-access-u1'
  && await lib.decryptToken(mRow.refresh_token_enc, 'u2:microsoft') === 'm-refresh-u2-rotated'
  && !JSON.stringify(db.calendar_connections).includes('rotated') && !JSON.stringify(db.calendar_connections).includes('access-u'), { body: r.body, rows });

await reset({ prov: { unauthorized: ['g-access-u1-stale'], gbusy: { u1: [{ start: '2026-11-28T15:00:00Z', end: '2026-11-28T16:00:00Z' }] } } });
db.calendar_connections = [await conn('u1', 'google', { access: 'g-access-u1-stale' })];
r = await busyReq();
check('busy: a cached token the provider rejects (401) is refreshed once and retried', r.body.checked.me && r.body.busy.length === 1 && tokenCalls().length === 1 && net.filter(n => n.url.endsWith('/freeBusy')).length === 2, r.body);

await reset({ prov: { invalid: ['g-refresh-u2'], gbusy: { u1: [{ start: '2026-11-28T15:00:00Z', end: '2026-11-28T16:00:00Z' }] } } });
db.calendar_connections = [await conn('u1', 'google'), await conn('u2', 'google', { expired: true })];
r = await busyReq();
row = db.calendar_connections.find(c => c.user_id === 'u2');
check('busy: invalid_grant marks the connection reconnect and reports it; the other person still checked',
  r.status === 200 && JSON.stringify(r.body.errors) === JSON.stringify([{ who: 'partner', provider: 'google', error: 'reconnect' }])
  && r.body.checked.me === true && r.body.checked.partner === false && row.last_error === 'reconnect' && row.access_token_enc === null
  && !/expired or revoked/.test(JSON.stringify(r.body)), { body: r.body, row });

await reset({ prov: { googleBusyFail: true } });
db.calendar_connections = [await conn('u1', 'google')];
r = await busyReq();
check('busy: provider failure reported as a fixed code, no provider text', r.status === 200 && r.body.errors[0].error === 'provider_error' && !/Backend|internal/.test(JSON.stringify(r.body)) && r.body.checked.me === false, r.body);

await reset();
r = await busyReq();
check('busy: nobody connected -> empty, checked false', r.status === 200 && r.body.busy.length === 0 && r.body.checked.me === false && r.body.checked.partner === false && net.length === 0, r.body);
const ranges = await Promise.all([
  busyReq({ from: '2026-11-01', to: '2027-01-02' }), busyReq({ from: '2026-11-01', to: '2027-01-01' }), busyReq({ from: '2026-11-29', to: '2026-11-28' }),
  busyReq({ tz: 'Mars/Olympus' }), busyReq({ from: '2026-02-30' }), busyReq({ tz: undefined }),
]);
check('busy: range over 62 days -> 400 (62 is fine); reversed range, bad zone, bad date -> 400',
  ranges[0].status === 400 && /62/.test(ranges[0].body.detail) && ranges[1].status === 200 && ranges.slice(2).every(x => x.status === 400 && x.body.error === 'bad_request'), ranges.map(x => [x.status, x.body.detail]));
await reset({ fail: { 'service.calendar_connections.select': true } });
r = await busyReq();
check('busy: database read fails -> 500 db_error', r.status === 500 && r.body.error === 'db_error' && /simulated/.test(r.body.detail), r);
await reset({ env: { SUPABASE_SERVICE_ROLE_KEY: undefined } });
r = await busyReq();
check('busy: no service role key -> 500 server_error', r.status === 500 && r.body.error === 'server_error' && /SERVICE_ROLE/.test(r.body.detail), r);

/* ===================== add_event ===================== */
const add = (o = {}) => cal({ action: 'add_event', taskId: T, ...o });
await reset();
db.calendar_connections = [await conn('u1', 'google')];
r = await add({ taskId: T2 });
check('add_event: task not booked -> 409 not_booked, nothing created', r.status === 409 && r.body.error === 'not_booked' && net.length === 0, r);
r = await add({ taskId: T3 });
check('add_event: other household\'s task -> 404', r.status === 404 && r.body.error === 'task_not_found', r);
r = await add({ taskId: 'nope' });
check('add_event: bad taskId -> 400', r.status === 400, r);

await reset();
db.calendar_connections = [await conn('u1', 'google'), await conn('u2', 'microsoft'), await conn('u2', 'google', { add_bookings: false }), await conn('u3', 'google')];
r = await add();
const gCreate = net.find(n => n.url.endsWith('/calendars/primary/events'));
const mCreate = net.find(n => n.url.endsWith('/me/events'));
const gB = gCreate && JSON.parse(gCreate.body), mB = mCreate && JSON.parse(mCreate.body);
check('add_event: created for both people who opted in; opted-out skipped; other household untouched',
  r.status === 200 && JSON.stringify(r.body) === JSON.stringify({ added: [{ who: 'me', provider: 'google' }, { who: 'partner', provider: 'microsoft' }], skipped: [{ who: 'partner', provider: 'google', reason: 'add_bookings_off' }], errors: [] })
  && net.filter(n => /events$/.test(n.url)).length === 2 && db.calendar_events.length === 2 && db.calendar_events.every(e => e.task_id === T && /^(gev|msev)\d$/.test(e.event_id)) && scoped(), { body: r.body, ev: db.calendar_events });
check('add_event: title, description and household-time-zone times (Google with offset, Graph with IANA zone)',
  gB.summary === 'Get the gutters cleaned: Gutter Pros' && gB.description === 'Confirmation: AMP-ABCDE\nAll-in cap: $150.50\nBooked with Ampersand: https://www.ourampersand.app/'
  && JSON.stringify(gB.start) === JSON.stringify({ dateTime: '2026-11-28T09:00:00-06:00', timeZone: 'America/Chicago' }) && gB.end.dateTime === '2026-11-28T11:00:00-06:00'
  && mB.subject === gB.summary && mB.body.contentType === 'text' && mB.body.content === gB.description
  && JSON.stringify(mB.start) === JSON.stringify({ dateTime: '2026-11-28T09:00:00', timeZone: 'America/Chicago' }) && mB.end.dateTime === '2026-11-28T11:00:00', { gB, mB });
const before = net.length;
r = await add();
check('add_event: second call is idempotent (nothing created, both already_added)',
  r.status === 200 && r.body.added.length === 0 && r.body.errors.length === 0 && r.body.skipped.filter(s => s.reason === 'already_added').length === 2 && net.length === before && db.calendar_events.length === 2, r.body);

await reset({ prov: { googleCreateFail: true } });
db.calendar_connections = [await conn('u1', 'google'), await conn('u2', 'microsoft')];
r = await add();
check('add_event: one provider failing is reported while the other succeeds; failed slot released',
  r.status === 200 && JSON.stringify(r.body.added) === JSON.stringify([{ who: 'partner', provider: 'microsoft' }])
  && JSON.stringify(r.body.errors) === JSON.stringify([{ who: 'me', provider: 'google', error: 'provider_error' }]) && !/secret|Backend/.test(JSON.stringify(r.body))
  && db.calendar_events.length === 1 && db.calendar_events[0].provider === 'microsoft', { body: r.body, ev: db.calendar_events });
prov.googleCreateFail = false;
r = await add();
check('add_event: retry after a failure adds only the missing one', JSON.stringify(r.body.added) === JSON.stringify([{ who: 'me', provider: 'google' }]) && r.body.skipped.length === 1 && db.calendar_events.length === 2, r.body);

await reset();
db.households[0].timezone = 'America/New_York';
db.tasks[0].booking = booking({ date: '2026-11-01', start: '01:30', end: '02:30' });
db.calendar_connections = [await conn('u1', 'google'), await conn('u2', 'microsoft')];
r = await add();
let g = JSON.parse(net.find(n => n.url.endsWith('/calendars/primary/events')).body);
let m = JSON.parse(net.find(n => n.url.endsWith('/me/events')).body);
check('add_event: correct UTC times across the fall-back change (01:30 EDT to 02:30 EST is 2 hours)',
  g.start.dateTime === '2026-11-01T01:30:00-04:00' && g.end.dateTime === '2026-11-01T02:30:00-05:00'
  && new Date(g.start.dateTime).toISOString() === '2026-11-01T05:30:00.000Z' && new Date(g.end.dateTime).toISOString() === '2026-11-01T07:30:00.000Z'
  && m.start.dateTime === '2026-11-01T01:30:00' && m.start.timeZone === 'America/New_York', { g: g.start, ge: g.end, m: m.start });
await reset();
db.households[0].timezone = null;
db.tasks[0].booking = booking({ date: '2026-03-08', start: '9:00', end: '10:00' });
db.calendar_connections = [await conn('u1', 'google')];
r = await add({ tz: 'America/New_York' });
g = JSON.parse(net.find(n => n.url.endsWith('/calendars/primary/events')).body);
check('add_event: no household zone -> the client tz; spring-forward day gets -04:00', g.start.dateTime === '2026-03-08T09:00:00-04:00' && g.start.timeZone === 'America/New_York'
  && new Date(g.start.dateTime).toISOString() === '2026-03-08T13:00:00.000Z', g.start);
await reset();
db.households[0].timezone = null;
db.calendar_connections = [await conn('u1', 'google')];
r = await add({ tz: 'Not/AZone' });
g = JSON.parse(net.find(n => n.url.endsWith('/calendars/primary/events')).body);
check('add_event: no usable zone at all -> UTC', g.start.dateTime === '2026-11-28T09:00:00+00:00' && g.start.timeZone === 'UTC', g.start);
await reset({ prov: { invalid: ['g-refresh-u1'] } });
db.calendar_connections = [await conn('u1', 'google', { expired: true })];
r = await add();
check('add_event: revoked grant -> errors reconnect, slot released', JSON.stringify(r.body.errors) === JSON.stringify([{ who: 'me', provider: 'google', error: 'reconnect' }]) && db.calendar_events.length === 0 && db.calendar_connections[0].last_error === 'reconnect', r.body);

/* ===================== disconnect and settings ===================== */
await reset();
db.calendar_connections = [await conn('u1', 'google'), await conn('u1', 'microsoft'), await conn('u2', 'google')];
db.calendar_events = [{ task_id: T, user_id: 'u1', provider: 'google', event_id: 'e1' }, { task_id: T, user_id: 'u1', provider: 'microsoft', event_id: 'e2' }, { task_id: T, user_id: 'u2', provider: 'google', event_id: 'e3' }];
r = await cal({ action: 'disconnect', provider: 'google' });
const rv = net.find(n => n.url === 'https://oauth2.googleapis.com/revoke');
check('disconnect google: token revoked at Google, row and its event records deleted, others kept',
  r.status === 200 && r.body.ok === true && r.body.revoked === true && rv && new URLSearchParams(rv.body).get('token') === 'g-refresh-u1'
  && !db.calendar_connections.some(c => c.user_id === 'u1' && c.provider === 'google') && db.calendar_connections.length === 2
  && JSON.stringify(db.calendar_events.map(e => e.event_id)) === '["e2","e3"]', { body: r.body, ev: db.calendar_events });
r = await cal({ action: 'disconnect', provider: 'microsoft' });
check('disconnect microsoft: no revoke endpoint, row deleted anyway', r.body.ok === true && r.body.revoked === false && db.calendar_connections.length === 1 && db.calendar_events.length === 1, r.body);
r = await cal({ action: 'disconnect', provider: 'google' });
check('disconnect: not connected is fine', r.status === 200 && r.body.ok === true, r.body);
await reset({ fail: { 'service.calendar_connections.delete': true } });
db.calendar_connections = [await conn('u1', 'google')];
r = await cal({ action: 'disconnect', provider: 'google' });
check('disconnect: delete fails -> 500 db_error', r.status === 500 && r.body.error === 'db_error', r);

await reset();
db.calendar_connections = [await conn('u1', 'google'), await conn('u2', 'google')];
r = await cal({ action: 'settings', provider: 'google', check_conflicts: false });
const s1 = db.calendar_connections[0], s2 = db.calendar_connections[1];
check('settings: updates only my row', r.status === 200 && r.body.ok === true && s1.check_conflicts === false && s1.add_bookings === true && s2.check_conflicts === true, r);
const sets = await Promise.all([
  cal({ action: 'settings', provider: 'microsoft', add_bookings: false }),
  cal({ action: 'settings', provider: 'google', add_bookings: 'no' }),
  cal({ action: 'settings', provider: 'google' }),
]);
check('settings: not connected -> 404; bad values -> 400', sets[0].status === 404 && sets[0].body.error === 'not_connected' && sets[1].status === 400 && sets[2].status === 400, sets.map(x => x.body));
const junk = await Promise.all([cal({ action: 'explode' }), call('calendar', 'not json'), cal({ action: 'disconnect' })]);
check('bad input: 400 bad_request', junk.every(x => x.status === 400 && x.body.error === 'bad_request'), junk.map(x => x.body));

/* ===================== agent research ===================== */
const opts3 = [
  { vendor: 'A Co', title: 'Morning', detail: 'd', date: '2026-11-28', start: '09:00', end: '11:00', totalCents: 15000, includes: 'x', url: 'https://a.example' },
  { vendor: 'B Co', title: 'Afternoon', detail: 'd', date: '2026-11-28', start: '14:00', end: '15:00', totalCents: 16000, includes: 'x', url: 'https://b.example' },
  { vendor: 'C Co', title: 'Sunday', detail: 'd', date: '2026-11-29', start: '10:00', end: '11:00', totalCents: 17000, includes: 'x', url: 'https://c.example' },
];
const research = () => call('agent', { action: 'research', taskId: T2, today: '2026-11-23', weekday: 'Monday' });
const saved = () => db.tasks.find(t => t.id === T2);
// u1 busy Sat 08:00-10:00 Chicago (14:00-16:00Z); u2 busy Sun 09:30-10:15 Chicago (15:30-16:15Z) via Outlook.
const calProv = { claude: { note: 'Three good picks.', options: opts3 },
  gbusy: { u1: [{ start: '2026-11-28T14:00:00Z', end: '2026-11-28T16:00:00Z' }] },
  mpages: { u2: [[{ start: { dateTime: '2026-11-29T15:30:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-29T16:15:00.0000000', timeZone: 'UTC' }, showAs: 'busy' }]] } };
await reset({ prov: { ...calProv, mpages: { u2: [[]] } } });
db.calendar_connections = [await conn('u1', 'google'), await conn('u2', 'microsoft')];
r = await research();
let prompt = prov.prompts[0] || '';
check('agent: busy windows (local household time) reach the prompt', /Avoid these times; both people must be free/.test(prompt) && /America\/Chicago/.test(prompt) && /2026-11-28 08:00-10:00/.test(prompt), prompt.slice(-700));
check('agent: an option overlapping a busy time is dropped, the rest saved',
  r.status === 200 && r.body.count === 2 && !r.body.conflict && JSON.stringify(saved().options.map(o => o.vendor)) === '["B Co","C Co"]' && saved().agent_note === 'Three good picks.' && saved().options.every(o => !o.conflict), { body: r.body, opts: saved().options });
const fbReq = JSON.parse(net.find(n => n.url.endsWith('/freeBusy')).body);
check('agent: range is today to the due date, local midnights', fbReq.timeMin === '2026-11-23T06:00:00.000Z' && fbReq.timeMax === '2026-12-01T06:00:00.000Z', fbReq);
check('agent: task data still read and written with the caller session', calls.filter(c => c.table === 'tasks').every(c => c.who === 'caller') && calls.filter(c => c.who === 'service').every(c => ['members', 'calendar_connections'].includes(c.table)), calls);

await reset({ prov: { ...calProv, gbusy: { u1: [{ start: '2026-11-28T14:00:00Z', end: '2026-11-28T21:00:00Z' }] } } });
db.calendar_connections = [await conn('u1', 'google'), await conn('u2', 'microsoft')];
r = await research();
check('agent: every option overlaps -> all kept with conflict:true and the note says so',
  r.status === 200 && r.body.conflict === true && r.body.count === 3 && saved().options.length === 3 && saved().options.every(o => o.conflict === true) && /clashes with one of your calendars/.test(saved().agent_note), { body: r.body, note: saved().agent_note });

await reset({ prov: { ...calProv, googleBusyFail: true, mpages: { u2: [] } } });
prov.mnext = () => 'https://evil.example/steal';
db.calendar_connections = [await conn('u1', 'google'), await conn('u2', 'microsoft', { expired: true })];
prov.invalid = ['m-refresh-u2'];
r = await research();
check('agent: calendar errors -> research still succeeds without the calendar line', r.status === 200 && r.body.count === 3 && !/busy times/.test(prov.prompts[0]) && !net.some(n => n.url.includes('evil')), { body: r.body });
await reset({ prov: calProv, fail: { 'service.members.select': true } });
db.calendar_connections = [await conn('u1', 'google')];
r = await research();
check('agent: calendar database failure -> research still succeeds', r.status === 200 && r.body.count === 3 && !/busy times/.test(prov.prompts[0]), r);
await reset({ prov: calProv });
db.calendar_connections = [await conn('u1', 'google')];
delete env.CALENDAR_TOKEN_KEY;
r = await research();
check('agent: calendars not configured -> no service client, research as before', r.status === 200 && r.body.count === 3 && !calls.some(c => c.who === 'service') && !/calendars/.test(prov.prompts[0]), r);
await reset({ prov: calProv });
r = await research();
check('agent: nobody connected -> no calendar line', r.status === 200 && r.body.count === 3 && !/calendars/.test(prov.prompts[0]), prov.prompts[0]);
await reset({ prov: { ...calProv, gbusy: {} } });
db.calendar_connections = [await conn('u1', 'google')];
r = await research();
check('agent: connected but free -> says so, keeps all options', r.status === 200 && r.body.count === 3 && /show no busy times/.test(prov.prompts[0]), prov.prompts[0].slice(-300));

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
