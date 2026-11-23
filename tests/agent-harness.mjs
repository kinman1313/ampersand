// Exercises the agent's I/O paths with a fake database and a fake Claude API.
let handler; let env = { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'x', ANTHROPIC_API_KEY: 'k' };
globalThis.Deno = { serve: fn => { handler = fn; }, env: { get: k => env[k] } };
let db, calls, claudeCalls;
function makeStub(opts) {
  calls = []; claudeCalls = 0;
  const task = { id: 't1', title: 'Gutters', project: 'home', log: [], due: '2026-12-01', due_reason: null, budget_cents: 20000 };
  const q = (table) => {
    const st = { table, op: 'select', patch: null };
    const api = {
      select() { return api; }, eq() { return api; }, order() { return api; },
      update(p) { st.op = 'update'; st.patch = p; return api; },
      maybeSingle() { return api.then(r => r); }, single() { return api; },
      then(res, rej) {
        calls.push({ table, op: st.op, patch: st.patch });
        const key = `${table}.${st.op}.${st.patch && st.patch.status || ''}`;
        if (opts.fail && opts.fail[key]) return Promise.resolve({ data: null, error: { message: 'simulated ' + key } }).then(res, rej);
        let data = null;
        if (table === 'members' && st.op === 'select') data = opts.memberOne ? { household_id: 'h', display_name: 'Kevin' } : [{ user_id: 'u1', display_name: 'Kevin' }, { user_id: 'u2', display_name: 'Kelli' }];
        if (table === 'households') data = { home_base: 'Allen, TX' };
        if (table === 'tasks' && st.op === 'select') data = task;
        return Promise.resolve({ data, error: null }).then(res, rej);
      }
    };
    return api;
  };
  let memberCalls = 0;
  globalThis.__stub = { createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: (t) => { if (t === 'members') { memberCalls++; opts.memberOne = memberCalls === 1; } return q(t); }
  }) };
}
globalThis.fetch = async () => { claudeCalls++; return fetchImpl(); };
let fetchImpl;
const ok = body => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(body) }] }), text: async () => '' });
const fail = st => ({ ok: false, status: st, json: async () => ({}), text: async () => 'unauthorized' });
await import("./.build/agent.mjs");
const call = async (body) => { const r = await handler(new Request('http://x', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
const results = [];
const check = (name, cond, info) => { results.push(cond); console.log((cond ? 'PASS ' : 'FAIL ') + name, info ? JSON.stringify(info).slice(0, 160) : ''); };
const good = { note: 'n', options: [{ vendor: 'V', title: 'T', detail: 'd', date: '2026-11-28', start: '09:00', end: '11:00', totalCents: 15000, includes: 'x', url: 'https://example.com' }] };
const today = { today: '2026-11-21', weekday: 'Saturday' };

makeStub({}); fetchImpl = () => ok(good);
let r = await call({ action: 'research', taskId: 't1', ...today });
check('research success saves options', r.status === 200 && r.body.count === 1 && calls.some(c => c.op === 'update' && Array.isArray(c.patch.options)), r);

makeStub({}); fetchImpl = () => fail(401);
r = await call({ action: 'research', taskId: 't1', ...today });
const reset = calls.filter(c => c.op === 'update').pop();
check('Claude API failure: task reset to open, 502 reported', r.status === 502 && reset.patch.status === 'open' && /Claude API 401/.test(r.body.detail), r);

makeStub({ fail: { 'tasks.update.researching': true } }); fetchImpl = () => ok(good);
r = await call({ action: 'research', taskId: 't1', ...today });
check('start-status write fails: 500, Claude never called', r.status === 500 && r.body.error === 'db_error' && claudeCalls === 0, r);

makeStub({ fail: { 'tasks.update.open': true } }); fetchImpl = () => ok(good);
r = await call({ action: 'research', taskId: 't1', ...today });
check('saving options fails and reset fails: both reported', r.status === 502 && /could not save options/.test(r.body.detail) && /also could not reset/.test(r.body.detail), r);

makeStub({}); fetchImpl = () => ok({ note: 'n', options: [{ vendor: 'V', title: 'T', date: '2020-01-01', start: '9am', end: 'x', totalCents: -5 }] });
r = await call({ action: 'research', taskId: 't1', ...today });
check('unusable options rejected, task reset', r.status === 502 && /no usable options/.test(r.body.detail) && calls.filter(c => c.op === 'update').pop().patch.status === 'open', r);

makeStub({ fail: { 'tasks.select.': true } }); fetchImpl = () => ok(good);
r = await call({ action: 'research', taskId: 't1', ...today });
check('task read fails: 500 db_error', r.status === 500 && r.body.error === 'db_error', r);

makeStub({ fail: { 'households.select.': true } }); fetchImpl = () => ok(good);
r = await call({ action: 'parse', text: 'fix gutters', ...today });
check('household read fails: 500 db_error, not "no household"', r.status === 500 && r.body.error === 'db_error', r);

makeStub({}); fetchImpl = () => ok({ tasks: [{ title: 'Clean gutters', project: 'home', assignee: 'Kelli', due: '2026-11-30', dueReason: 'end of month', research: true, budgetCents: 20000 }, { title: 'x', project: 'bogus', assignee: 'Nobody' }] });
r = await call({ action: 'parse', text: 'gutters', ...today });
check('parse maps names and cleans output', r.status === 200 && r.body.tasks[0].assignee === 'u2' && r.body.tasks[1].project === 'us' && r.body.tasks[1].assignee === null, r.body.tasks);

env.ANTHROPIC_API_KEY = undefined; makeStub({});
r = await call({ action: 'status' });
check('status reports agent off without key', r.status === 200 && r.body.configured === false, r);
r = await call({ action: 'research', taskId: 't1' });
check('research without key: 503 agent_not_configured', r.status === 503, r);
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exitCode = 1; // let `&&` chains and CI see a failure
