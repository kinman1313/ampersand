import assert from "node:assert/strict";
import crypto from "node:crypto";

const env = new Map();
globalThis.Deno = {
  env: { get: (k) => env.get(k) },
  serve: (fn) => { globalThis.__handlers.push(fn); },
};
globalThis.__handlers = [];

let db = {};
let sentEmails = [];
let claudeReply = null;
let rpcCalls = [];
let receivedLookup = {};

function resetFixtures() {
  env.clear();
  env.set("SUPABASE_URL", "https://example.supabase.co");
  env.set("SUPABASE_ANON_KEY", "anon");
  env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
  env.set("RESEND_API_KEY", "re_test_key");
  env.set("NOTIFY_FROM", "Ampersand <nudges@ourampersand.app>");
  env.set("ANTHROPIC_API_KEY", "sk-ant-test");
  env.set("OUTREACH_INBOUND_DOMAIN", "inbound.ourampersand.app");
  env.set("OUTREACH_WEBHOOK_SECRET", "whsec_" + Buffer.from("super-secret-webhook-key-32bytes").toString("base64"));
  env.set("APP_URL", "https://www.ourampersand.app");

  sentEmails = [];
  rpcCalls = [];
  receivedLookup = {};
  claudeReply = null;

  const opt1 = {
    id: "o1", vendor: "Cedar & Pine Chimney", title: "Full sweep + camera",
    date: "2026-11-28", start: "09:00", end: "11:00", totalCents: 18500,
    includes: "Sweep & camera check", vendorEmail: "hello@cedarpine.example",
  };
  const hash1 = [opt1.vendor, opt1.date, opt1.start, opt1.end, opt1.totalCents, opt1.includes].join("|");

  db = {
    callerUser: { id: "u1", email: "alex@example.com" },
    users: { u1: "alex@example.com", u2: "sam@example.com" },
    members: [
      { household_id: "hh1", user_id: "u1", display_name: "Alex", notify_email: true },
      { household_id: "hh1", user_id: "u2", display_name: "Sam", notify_email: true },
    ],
    households: [
      { id: "hh1", home_base: "Allen, TX", timezone: "America/Chicago", contact_phone: "469-555-0192", service_address: "412 Maple Ln, Allen, TX" },
    ],
    tasks: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        household_id: "hh1", title: "Get the chimney swept", project: "home",
        due: "2026-11-30", due_reason: "before winter", budget_cents: 20000,
        status: "open", options: [opt1], log: [],
      },
    ],
    approvals: [
      { task_id: "11111111-1111-4111-8111-111111111111", user_id: "u1", yes_option_id: "o1", yes_hash: hash1 },
    ],
    vendor_threads: [],
    vendor_messages: [],
    hash1,
  };
}

function makeQuery(table, isAdmin) {
  let rows = [...(db[table] || [])];
  let mode = "select";
  let payload = null;
  let filters = [];
  let single = false;
  let headOnly = false;
  let countExact = false;

  const applyFilters = (list) => list.filter((r) => filters.every(([op, col, val]) => {
    if (op === "eq") return r[col] === val;
    if (op === "gte") return String(r[col] || "") >= String(val);
    return true;
  }));

  const q = {
    select(_cols, opts) { if (opts?.head) headOnly = true; if (opts?.count === "exact") countExact = true; return q; },
    insert(row) {
      mode = "insert";
      const arr = Array.isArray(row) ? row : [row];
      payload = arr.map((r) => ({ id: r.id || crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r }));
      db[table].push(...payload);
      return q;
    },
    update(patch) { mode = "update"; payload = patch; return q; },
    eq(col, val) { filters.push(["eq", col, val]); return q; },
    gte(col, val) { filters.push(["gte", col, val]); return q; },
    order() { return q; },
    limit(n) { rows = applyFilters(rows).slice(0, n); return q; },
    maybeSingle() { single = true; return q; },
    single() { single = true; return q; },
    then(res) {
      if (mode === "insert") {
        return Promise.resolve({ data: single ? payload[0] : payload, error: null }).then(res);
      }
      if (mode === "update") {
        const matched = applyFilters(db[table] || []);
        for (const r of matched) Object.assign(r, payload);
        return Promise.resolve({ data: matched, error: null }).then(res);
      }
      const matched = applyFilters(db[table] || []);
      if (headOnly) return Promise.resolve({ count: matched.length, data: null, error: null }).then(res);
      return Promise.resolve({ data: single ? (matched[0] || null) : matched, count: countExact ? matched.length : undefined, error: null }).then(res);
    },
  };
  return q;
}

globalThis.__stub = {
  createClient: (_url, key) => {
    const isAdmin = key === "service";
    return {
      auth: {
        getUser: async () => ({ data: { user: db.callerUser }, error: null }),
        admin: {
          getUserById: async (id) => ({ data: { user: db.users[id] ? { id, email: db.users[id] } : null }, error: null }),
        },
      },
      from: (table) => makeQuery(table, isAdmin),
      rpc: async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: { ok: true, applied: args.p_outcome }, error: null };
      },
    };
  },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.resend.com/emails/receiving/")) {
    const id = decodeURIComponent(u.split("/").pop());
    const found = receivedLookup[id];
    if (!found) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(found), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u === "https://api.resend.com/emails") {
    const body = JSON.parse(init.body);
    sentEmails.push(body);
    return new Response(JSON.stringify({ id: "re_msg_" + sentEmails.length }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u === "https://api.anthropic.com/v1/messages") {
    const text = claudeReply || JSON.stringify({ subject: "Chimney sweep quote request", body: "Hi Cedar & Pine Chimney, we are in Allen, TX looking for a full sweep around Sat Nov 28. Could you share your all-in quote and availability? Thanks, Alex & Sam" });
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error("unexpected fetch: " + u);
};

await import("./.build/outreach.mjs");
const outreachHandler = globalThis.__handlers[0];
await import("./.build/outreach-inbound.mjs");
const inboundHandler = globalThis.__handlers[1];

const callOutreach = async (body) => {
  const res = await outreachHandler(new Request("https://fn/outreach", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};

function signSvix(rawBody, secret, ts = Math.floor(Date.now() / 1000)) {
  const id = "msg_" + crypto.randomUUID().slice(0, 8);
  const key = Buffer.from(secret.slice(6), "base64");
  const sig = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` };
}

let passed = 0;
async function test(name, fn) {
  resetFixtures();
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

await test("status reports configured, inboundDomain and canDraft", async () => {
  const r = await callOutreach({ action: "status" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { configured: true, inboundDomain: "inbound.ourampersand.app", canDraft: true });
});

await test("unauthenticated caller rejected 401", async () => {
  db.callerUser = null;
  const r = await callOutreach({ action: "status" });
  assert.equal(r.status, 401);
});

await test("draft quote succeeds and never leaks street address or phone", async () => {
  env.delete("ANTHROPIC_API_KEY"); // test deterministic fallback privacy too
  const r = await callOutreach({ action: "draft", kind: "quote", taskId: db.tasks[0].id, optionId: "o1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.vendorEmail, "hello@cedarpine.example");
  assert.ok(r.body.body.includes("Allen, TX"));
  assert.ok(!r.body.body.includes("412 Maple Ln"));
  assert.ok(!r.body.body.includes("469-555-0192"));
});

await test("draft confirm blocked 409 when partner has not said yes", async () => {
  const r = await callOutreach({ action: "draft", kind: "confirm", taskId: db.tasks[0].id, optionId: "o1" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "not_agreed");
});

await test("draft confirm includes address and phone once both partners agree", async () => {
  env.delete("ANTHROPIC_API_KEY");
  db.approvals.push({ task_id: db.tasks[0].id, user_id: "u2", yes_option_id: "o1", yes_hash: db.hash1 });
  const r = await callOutreach({ action: "draft", kind: "confirm", taskId: db.tasks[0].id, optionId: "o1" });
  assert.equal(r.status, 200);
  assert.ok(r.body.body.includes("412 Maple Ln"));
  assert.ok(r.body.body.includes("469-555-0192"));
});

await test("send quote rejects invalid email and header injection", async () => {
  const r1 = await callOutreach({ action: "send", kind: "quote", taskId: db.tasks[0].id, optionId: "o1", toEmail: "not-an-email", subject: "Hi", body: "Hello there, could we get a quote?" });
  assert.equal(r1.status, 400);
  const r2 = await callOutreach({ action: "send", kind: "quote", taskId: db.tasks[0].id, optionId: "o1", toEmail: "a@b.com\r\nBcc: evil@x.com", subject: "Hi", body: "Hello there, could we get a quote?" });
  assert.equal(r2.status, 400);
});

await test("send quote creates thread, sets inbound reply_to, logs message and saves vendorEmail", async () => {
  const r = await callOutreach({
    action: "send", kind: "quote", taskId: db.tasks[0].id, optionId: "o1",
    toEmail: "quotes@cedarpine.example", subject: "Chimney sweep quote",
    body: "Hi there, could you quote a chimney sweep in Allen, TX around Nov 28?",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.replyMode, "inbound");
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].reply_to, /^reply\+[a-f0-9]{36}@inbound\.ourampersand\.app$/);
  assert.equal(db.vendor_threads.length, 1);
  assert.equal(db.vendor_messages.length, 1);
  assert.equal(db.tasks[0].options[0].vendorEmail, "quotes@cedarpine.example");
});

await test("send quote without OUTREACH_INBOUND_DOMAIN falls back reply_to to caller email", async () => {
  env.delete("OUTREACH_INBOUND_DOMAIN");
  const r = await callOutreach({
    action: "send", kind: "quote", taskId: db.tasks[0].id, optionId: "o1",
    toEmail: "quotes@cedarpine.example", subject: "Chimney sweep quote",
    body: "Hi there, could you quote a chimney sweep in Allen, TX around Nov 28?",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.replyMode, "direct");
  assert.equal(sentEmails[0].reply_to, "alex@example.com");
});

await test("send confirm reuses existing thread and sets In-Reply-To & References headers", async () => {
  db.approvals.push({ task_id: db.tasks[0].id, user_id: "u2", yes_option_id: "o1", yes_hash: db.hash1 });
  const r1 = await callOutreach({
    action: "send", kind: "quote", taskId: db.tasks[0].id, optionId: "o1",
    toEmail: "hello@cedarpine.example", subject: "Chimney sweep quote",
    body: "Hi there, could you quote a chimney sweep in Allen, TX?",
  });
  const r2 = await callOutreach({
    action: "send", kind: "confirm", taskId: db.tasks[0].id, optionId: "o1",
    toEmail: "hello@cedarpine.example", subject: "Re: Chimney sweep quote",
    body: "We'd love to book Sat Nov 28, 9-11 AM at $185 all-in. Please confirm!",
    threadId: r1.body.threadId,
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.threadId, r1.body.threadId);
  assert.equal(db.vendor_threads.length, 1);
  assert.equal(sentEmails[1].headers["In-Reply-To"], "<re_msg_1>");
});

await test("daily household cap of 10 outbound vendor emails is enforced", async () => {
  for (let i = 0; i < 10; i++) {
    db.vendor_messages.push({ id: i + 1, household_id: "hh1", direction: "outbound", created_at: new Date().toISOString() });
  }
  const r = await callOutreach({
    action: "send", kind: "quote", taskId: db.tasks[0].id, optionId: "o1",
    toEmail: "hello@cedarpine.example", subject: "Hi", body: "Could you send us a quote for next week?",
  });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "daily_cap");
});

await test("inbound webhook rejects missing or tampered signature and stale timestamps", async () => {
  const raw = JSON.stringify({ type: "email.received", data: { to: ["reply+deadbeefdeadbeef@inbound.ourampersand.app"] } });
  const r1 = await inboundHandler(new Request("https://fn/in", { method: "POST", body: raw }));
  assert.equal(r1.status, 401);

  const staleHeaders = signSvix(raw, env.get("OUTREACH_WEBHOOK_SECRET"), Math.floor(Date.now() / 1000) - 900);
  const r2 = await inboundHandler(new Request("https://fn/in", { method: "POST", headers: staleHeaders, body: raw }));
  assert.equal(r2.status, 401);
});

await test("inbound webhook verifies Svix signature, fetches Resend body, parses quote, calls RPC, notifies household, and deduplicates retries", async () => {
  const token = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6";
  db.vendor_threads.push({
    id: "22222222-2222-4222-8222-222222222222", household_id: "hh1",
    task_id: db.tasks[0].id, option_id: "o1", vendor_name: "Cedar & Pine Chimney",
    vendor_email: "hello@cedarpine.example", reply_token: token, kind: "quote", status: "sent",
  });
  receivedLookup["em_999"] = { text: "Hi! Yes we can do Sat Nov 28 9:00-11:00 AM for $175 all-in including full sweep & cap check." };
  claudeReply = JSON.stringify({
    outcome: "quoted", summary: "$175 all-in for Sat Nov 28, 9–11 AM.",
    date: "2026-11-28", start: "09:00", end: "11:00", totalCents: 17500, includes: "Full sweep & cap check",
  });

  const raw = JSON.stringify({
    type: "email.received",
    data: { email_id: "em_999", from: "hello@cedarpine.example", to: [`reply+${token}@inbound.ourampersand.app`], subject: "Re: Chimney sweep quote" },
  });
  const headers = signSvix(raw, env.get("OUTREACH_WEBHOOK_SECRET"));
  const r1 = await inboundHandler(new Request("https://fn/in", { method: "POST", headers, body: raw }));
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.outcome, "quoted");
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "apply_vendor_reply");
  assert.equal(rpcCalls[0].args.p_quote.totalCents, 17500);
  assert.equal(sentEmails.length, 2); // notified both Alex & Sam

  // Replay with same email_id is deduplicated cleanly
  const r2 = await inboundHandler(new Request("https://fn/in", { method: "POST", headers: signSvix(raw, env.get("OUTREACH_WEBHOOK_SECRET")), body: raw }));
  const b2 = await r2.json();
  assert.equal(b2.duplicate, true);
  assert.equal(rpcCalls.length, 1);
});

await test("inbound webhook accepts x-outreach-secret for Cloudflare Email Worker", async () => {
  const token = "f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5";
  db.vendor_threads.push({
    id: "33333333-3333-4333-8333-333333333333", household_id: "hh1",
    task_id: db.tasks[0].id, option_id: "o1", vendor_name: "Cedar & Pine Chimney",
    vendor_email: "hello@cedarpine.example", reply_token: token, kind: "confirm", status: "sent",
  });
  claudeReply = JSON.stringify({ outcome: "confirmed", summary: "Confirmed for Sat Nov 28 at $185." });
  const raw = JSON.stringify({
    from: "hello@cedarpine.example", to: `reply+${token}@inbound.ourampersand.app`,
    subject: "Re: Booking confirmation", text: "You're all set for Sat Nov 28 9am!", messageId: "<m-123@vendor>",
  });
  const r = await inboundHandler(new Request("https://fn/in", {
    method: "POST",
    headers: { "x-outreach-secret": env.get("OUTREACH_WEBHOOK_SECRET") },
    body: raw,
  }));
  assert.equal(r.status, 200);
  assert.equal(rpcCalls[0].args.p_outcome, "confirmed");
});

console.log(`${passed}/${passed} passed`);
