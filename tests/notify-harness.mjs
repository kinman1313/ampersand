// Exercises the notify function with a fake database (two clients: caller and service role),
// fake auth admin and a fake Resend API.
let handler; let env;
globalThis.Deno = { serve: fn => { handler = fn; }, env: { get: k => env[k] } };
const T = '11111111-1111-4111-8111-111111111111';
const hash = o => [o.vendor, o.date, o.start, o.end, o.totalCents, o.includes || ''].join('|');
const optA = { id: 'oA', vendor: 'Gutter Pros', title: 'Full clean', date: '2026-11-28', start: '09:00', end: '11:00', totalCents: 15000, includes: 'all gutters' };
const optB = { id: 'oB', vendor: 'Rain Co', title: 'Basic', date: '2026-11-29', start: '10:00', end: '12:00', totalCents: 12050, includes: '' };

let db, calls, sends, fail, adminUser, signedOut;
function reset(over = {}) {
  env = { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', RESEND_API_KEY: 'rk', NOTIFY_FROM: 'Ampersand <nudges@example.com>', ...over.env };
  db = {
    members: [{ household_id: 'h', user_id: 'u1', display_name: 'Sam', notify_email: true }, { household_id: 'h', user_id: 'u2', display_name: 'Alex', notify_email: true }],
    tasks: [{ id: T, household_id: 'h', title: 'Get the gutters cleaned', status: 'open', options: [optA, optB] }],
    approvals: [{ task_id: T, user_id: 'u1', yes_option_id: 'oA', yes_hash: hash(optA) }],
    notify_log: [],
    private_items: [{ user_id: 'u1', title: 'secret' }],
    ...over.db,
  };
  calls = []; sends = []; signedOut = !!over.signedOut; fail = over.fail || {}; adminUser = over.adminUser || { id: 'u2', email: 'alex@example.com' };
  fetchImpl = over.fetchImpl || (() => ({ ok: true, status: 200, text: async () => '{"id":"e1"}' }));
}
function client(who) {
  const q = (table) => {
    const st = { op: 'select', filters: [], head: false, row: null };
    const api = {
      select(_c, o) { if (o && o.head) st.head = true; return api; },
      eq(c, v) { st.filters.push(r => r[c] === v); return api; },
      gte(c, v) { st.filters.push(r => r[c] >= v); return api; },
      insert(row) { st.op = 'insert'; st.row = row; return api; },
      maybeSingle() { st.single = true; return api; },
      then(res, rej) {
        calls.push({ who, table, op: st.op });
        const key = `${who}.${table}.${st.op}`;
        if (fail[key]) return Promise.resolve({ data: null, count: null, error: { message: 'simulated ' + key } }).then(res, rej);
        if (st.op === 'insert') { db[table].push({ ...st.row, sent_at: new Date().toISOString() }); return Promise.resolve({ data: null, error: null }).then(res, rej); }
        const rows = (db[table] || []).filter(r => st.filters.every(f => f(r)));
        if (st.head) return Promise.resolve({ data: null, count: rows.length, error: null }).then(res, rej);
        return Promise.resolve({ data: st.single ? (rows[0] || null) : rows, error: null }).then(res, rej);
      }
    };
    return api;
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: who === 'caller' && !signedOut ? { id: 'u1' } : null } }),
      admin: { getUserById: async (id) => { calls.push({ who, table: 'auth.users', op: 'admin' }); return fail['admin'] ? { data: null, error: { message: 'simulated admin' } } : { data: { user: id === adminUser.id ? adminUser : null }, error: null }; } },
    },
    from: q,
  };
}
globalThis.__stub = { createClient: (_u, key) => client(key === 'service' ? 'service' : key === 'anon' ? 'caller' : 'unknown') };
let fetchImpl;
globalThis.fetch = async (u, init) => { sends.push({ url: u, body: JSON.parse(init.body), headers: init.headers }); return fetchImpl(); };
await import('./.build/notify.mjs');

const call = async (body, auth = 'Bearer t') => {
  const r = await handler(new Request('http://x', { method: 'POST', headers: { Authorization: auth }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const results = [];
const check = (name, cond, info) => { results.push(cond); console.log((cond ? 'PASS ' : 'FAIL ') + name, info ? JSON.stringify(info).slice(0, 200) : ''); };
const nudge = (kind, extra = {}) => call({ action: 'nudge', kind, taskId: T, ...extra });
// Caller data must come through the caller's client; the service role only touches notify_log and auth admin.
const scoped = () => calls.every(c => c.who === 'caller' ? ['members', 'tasks', 'approvals'].includes(c.table) : ['notify_log', 'auth.users'].includes(c.table)) && !calls.some(c => c.table === 'private_items');

reset();
let r = await nudge('yes', { appUrl: 'https://ampersand-home.vercel.app/' });
let s = sends[0];
check('yes: email sent to partner and logged', r.status === 200 && r.body.sent === true && r.body.kind === 'yes' && sends.length === 1 && s.url === 'https://api.resend.com/emails'
  && s.body.to[0] === 'alex@example.com' && s.body.from === env.NOTIFY_FROM && s.headers.Authorization === 'Bearer rk'
  && s.body.subject === 'Sam said yes — your turn' && /Sam said yes to Full clean \(Gutter Pros, Sat, Nov 28, \$150 all-in\) for “Get the gutters cleaned”/.test(s.body.text)
  && /https:\/\/ampersand-home\.vercel\.app\//.test(s.body.html) && /share a list with Sam/.test(s.body.text)
  && db.notify_log.length === 1 && db.notify_log[0].recipient === 'u2' && db.notify_log[0].kind === 'yes', { r, subject: s && s.body.subject });
check('yes: reads use caller session, service role only for log and email lookup, no private_items', scoped(), calls);

reset({ db: { approvals: [{ task_id: T, user_id: 'u1', yes_option_id: 'oA', yes_hash: hash(optA) }, { task_id: T, user_id: 'u2', yes_option_id: 'oA', yes_hash: hash(optA) }] } });
r = await nudge('yes');
check('partner already said yes to the same option: agreed', r.body.sent === true && r.body.kind === 'agreed' && sends[0].body.subject === 'You both said yes: ready to book'
  && /You both said yes to Gutter Pros on Sat, Nov 28\. Open Ampersand to book it\./.test(sends[0].body.text) && db.notify_log[0].kind === 'agreed', r);

reset({ db: { approvals: [{ task_id: T, user_id: 'u1', yes_option_id: 'oA', yes_hash: hash(optA) }, { task_id: T, user_id: 'u2', yes_option_id: 'oB', yes_hash: hash(optB) }] } });
r = await nudge('yes');
check('partner said yes to a different option: plain yes', r.body.kind === 'yes', r);

reset({ db: { approvals: [{ task_id: T, user_id: 'u1', yes_option_id: null, yes_hash: null }] } });
r = await nudge('yes');
check('no current yes: 409, nothing sent', r.status === 409 && r.body.error === 'no_current_yes' && sends.length === 0, r);

reset({ db: { approvals: [{ task_id: T, user_id: 'u1', yes_option_id: 'oA', yes_hash: 'Gutter Pros|2026-11-28|09:00|11:00|10000|all gutters' }] } });
r = await nudge('yes');
check('stale hash (price changed since the yes): 409', r.status === 409 && r.body.error === 'no_current_yes' && sends.length === 0, r);

reset({ db: { tasks: [{ id: T, household_id: 'h', title: 'Get the gutters cleaned', status: 'booked', options: [optA] }] } });
r = await nudge('yes');
check('yes on a booked task: 409 task_closed', r.status === 409 && r.body.error === 'task_closed' && sends.length === 0, r);

reset();
r = await nudge('options');
s = sends[0];
check('options: sent to the partner, not the caller', r.body.sent === true && r.body.kind === 'options' && s.body.to.length === 1 && s.body.to[0] === 'alex@example.com'
  && s.body.subject === '2 options for “Get the gutters cleaned”' && /The agent found 2 options/.test(s.body.text)
  && /Gutter Pros, Sat, Nov 28, \$150/.test(s.body.text) && /Rain Co, Sun, Nov 29, \$120\.50/.test(s.body.text) && db.notify_log[0].recipient === 'u2', { r, text: s && s.body.text });

reset({ db: { tasks: [{ id: T, household_id: 'h', title: 'x', status: 'researching', options: [] }] } });
r = await nudge('options');
check('options with none found: 409 no_options', r.status === 409 && r.body.error === 'no_options' && sends.length === 0, r);

reset({ db: { members: [{ household_id: 'h', user_id: 'u1', display_name: 'Sam', notify_email: true }] } });
r = await nudge('yes');
check('no partner: sent false, no_partner', r.status === 200 && r.body.sent === false && r.body.reason === 'no_partner' && sends.length === 0, r);

reset({ db: { members: [{ household_id: 'h', user_id: 'u1', display_name: 'Sam', notify_email: true }, { household_id: 'h', user_id: 'u2', display_name: 'Alex', notify_email: false }] } });
r = await nudge('options');
check('partner opted out: sent false, opted_out', r.body.sent === false && r.body.reason === 'opted_out' && sends.length === 0 && !calls.some(c => c.who === 'service'), r);

reset({ db: { notify_log: [{ household_id: 'h', recipient: 'u2', task_id: T, kind: 'yes', sent_at: new Date(Date.now() - 3600e3).toISOString() }] } });
r = await nudge('yes');
check('throttled within 6 hours', r.body.sent === false && r.body.reason === 'throttled' && sends.length === 0 && db.notify_log.length === 1, r);

reset({ db: { notify_log: [{ household_id: 'h', recipient: 'u2', task_id: T, kind: 'yes', sent_at: new Date(Date.now() - 7 * 3600e3).toISOString() }] } });
r = await nudge('yes');
check('not throttled after 6 hours', r.body.sent === true, r);

reset({ db: { notify_log: Array.from({ length: 20 }, (_, i) => ({ household_id: 'h', recipient: 'u2', task_id: '22222222-2222-4222-8222-22222222222' + (i % 10), kind: 'options', sent_at: new Date(Date.now() - 3600e3).toISOString() })) } });
r = await nudge('yes');
check('daily cap of 20', r.body.sent === false && r.body.reason === 'daily_cap' && sends.length === 0, r);

reset({ env: { RESEND_API_KEY: undefined } });
r = await nudge('yes');
check('email not configured: sent false, no call to Resend', r.status === 200 && r.body.sent === false && r.body.reason === 'email_not_configured' && sends.length === 0, r);

reset({ fetchImpl: () => ({ ok: false, status: 500, text: async () => 'resend exploded' }) });
r = await nudge('yes');
check('Resend 500: 502 send_failed, nothing logged', r.status === 502 && r.body.error === 'send_failed' && /Resend 500: resend exploded/.test(r.body.detail) && db.notify_log.length === 0, r);

reset({ fetchImpl: () => { throw new Error('network down'); } });
r = await nudge('yes');
check('Resend unreachable: 502 send_failed, nothing logged', r.status === 502 && /network down/.test(r.body.detail) && db.notify_log.length === 0, r);

reset({ fail: { 'service.notify_log.insert': true } });
r = await nudge('yes');
check('log insert fails: sent true, logged false with detail', r.status === 200 && r.body.sent === true && r.body.logged === false && /simulated/.test(r.body.detail), r);

reset({ fail: { 'caller.tasks.select': true } });
r = await nudge('yes');
check('task read fails: 500 db_error', r.status === 500 && r.body.error === 'db_error' && sends.length === 0, r);
reset({ fail: { 'caller.approvals.select': true } });
r = await nudge('yes');
check('approvals read fails: 500 db_error', r.status === 500 && r.body.error === 'db_error', r);
reset({ fail: { 'service.notify_log.select': true } });
r = await nudge('yes');
check('throttle read fails: 500 db_error, nothing sent', r.status === 500 && r.body.error === 'db_error' && sends.length === 0, r);
reset({ fail: { admin: true } });
r = await nudge('yes');
check('partner email lookup fails: 500, nothing sent', r.status === 500 && /could not look up partner/.test(r.body.detail) && sends.length === 0, r);

reset({ db: { tasks: [] } });
r = await nudge('yes');
check('task not visible: 404 task_not_found', r.status === 404 && r.body.error === 'task_not_found', r);

reset();
const bad = await Promise.all([
  call({ action: 'nudge', kind: 'yes', taskId: 'not-a-uuid' }),
  call({ action: 'nudge', kind: 'agreed', taskId: T }),
  call({ action: 'nudge', kind: 'yes' }),
  call({ action: 'explode' }),
  call('not json'),
]);
check('bad input: 400 bad_request', bad.every(x => x.status === 400 && x.body.error === 'bad_request') && sends.length === 0, bad.map(x => x.body.detail));

reset({ signedOut: true });
r = await nudge('yes');
check('no session: 401 not_signed_in, nothing read', r.status === 401 && r.body.error === 'not_signed_in' && calls.length === 0 && sends.length === 0, r);

reset({ db: { tasks: [{ id: T, household_id: 'h', title: '<script>alert("x")</script> & co', status: 'open', options: [{ ...optA, vendor: '<b>Evil</b>' }] }] } });
r = await nudge('options', { appUrl: 'https://ok.example/"><script>' });
s = sends[0];
check('HTML escapes task title and vendor; unsafe appUrl rejected', r.body.sent === true && !/<script>|<b>/.test(s.body.html)
  && /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; co/.test(s.body.html) && /&lt;b&gt;Evil&lt;\/b&gt;/.test(s.body.html) && !/ok\.example/.test(s.body.html), s && s.body.html);

reset({ env: { APP_URL: 'https://ampersand-home.vercel.app' } });
r = await nudge('yes', { appUrl: 'http://localhost.evil.com/' });
check('lookalike localhost rejected, APP_URL used instead', r.body.sent === true && /href="https:\/\/ampersand-home\.vercel\.app"/.test(sends[0].body.html) && !/evil/.test(sends[0].body.html), sends[0] && sends[0].body.text);
reset({ env: { APP_URL: 'https://ampersand-home.vercel.app' } });
r = await nudge('yes', { appUrl: 'https://attacker.example/phish' });
check('with APP_URL set, a link to another site is replaced by APP_URL', r.body.sent === true && !/attacker/.test(sends[0].body.html + sends[0].body.text) && /ampersand-home\.vercel\.app/.test(sends[0].body.text), sends[0] && sends[0].body.text);
reset({ env: { APP_URL: 'https://ampersand-home.vercel.app' } });
r = await nudge('yes', { appUrl: 'https://ampersand-home.vercel.app/?x=1' });
check('with APP_URL set, a same-site link is kept', /https:\/\/ampersand-home\.vercel\.app\/\?x=1/.test(sends[0].body.text), sends[0] && sends[0].body.text);
reset();
r = await nudge('yes', { appUrl: 'http://localhost:5173/' });
check('localhost appUrl accepted', /http:\/\/localhost:5173\//.test(sends[0].body.text), sends[0] && sends[0].body.text);
reset();
r = await nudge('yes');
check('no appUrl and no APP_URL: no link', r.body.sent === true && !/Open Ampersand:/.test(sends[0].body.text) && !/<a /.test(sends[0].body.html), sends[0].body.text);

reset();
r = await call({ action: 'status' });
const on = r.body.email;
reset({ env: { NOTIFY_FROM: undefined } });
r = await call({ action: 'status' });
check('status reports whether email is live', on === true && r.status === 200 && r.body.email === false && sends.length === 0, { on, off: r.body });

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
