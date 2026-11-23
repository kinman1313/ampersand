// Ampersand calendar: connect Google or Outlook calendars, check free/busy, and add bookings to calendars.
// Who the caller is, their household, their partner and their tasks are read with the CALLER's session,
// so row-level security decides what it can see. The service role is used only for calendar_connections
// and calendar_events, which no signed-in user can read. Tokens never leave the server; the partner's
// email address and tokens are never returned. It never touches private_items.
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  aadFor, addDays, CalError, clients, codeOf, CONN_COLUMNS, daysBetween, decryptToken, encryptToken, householdBusy, isDay,
  isPendingKey, isProvider, isTz, localInterval, pendingAad, providerConfigured, rfc3339Local, safeReturnTo, signState, utcToLocal, withAccess,
  zonedToUtc, type Conn, type Provider,
} from "../_shared/calendar.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const MAX_RANGE_DAYS = 62;
const isUuid = (s: unknown) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function money(cents: unknown) {
  const c = Number(cents);
  if (!Number.isFinite(c) || c <= 0) return "price to confirm";
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const sb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "not_signed_in" }, 401);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_request", detail: "body must be a JSON object" }, 400);
    const action = body.action;
    if (!["status", "connect", "finish", "disconnect", "settings", "busy", "add_event"].includes(action)) {
      return json({ error: "bad_request", detail: "action must be status, connect, finish, disconnect, settings, busy or add_event" }, 400);
    }
    if (["connect", "disconnect", "settings"].includes(action) && !isProvider(body.provider)) {
      return json({ error: "bad_request", detail: "provider must be google or microsoft" }, 400);
    }

    // The service role, only for the two calendar tables (and householdBusy's member list).
    // deno-lint-ignore no-explicit-any
    let adminClient: any = null; // untyped: there is no generated schema, so typed rows would be `never`
    const admin = () => {
      if (adminClient) return adminClient;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!serviceKey) throw new CalError("server_error", 0, "SUPABASE_SERVICE_ROLE_KEY is not set");
      adminClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      return adminClient;
    };

    /* ---------- caller and household: with the caller's session ---------- */
    const { data: me, error: meErr } = await sb.from("members").select("household_id").eq("user_id", user.id).maybeSingle();
    if (meErr) return json({ error: "db_error", detail: meErr.message }, 500);
    let partnerId: string | null = null;
    if (me) {
      const { data: members, error: memErr } = await sb.from("members").select("user_id").eq("household_id", me.household_id);
      if (memErr) return json({ error: "db_error", detail: memErr.message }, 500);
      partnerId = (members || []).find((m: { user_id: string }) => m.user_id !== user.id)?.user_id ?? null;
    }
    const whoOf = (uid: string) => (uid === user.id ? "me" : "partner");

    /* ---------- status ---------- */
    if (action === "status") {
      const configured = { google: providerConfigured("google"), microsoft: providerConfigured("microsoft") };
      const { data: mine, error: mineErr } = await admin().from("calendar_connections")
        .select("provider, account_email, check_conflicts, add_bookings, connected_at, last_error").eq("user_id", user.id);
      if (mineErr) return json({ error: "db_error", detail: mineErr.message }, 500);
      let partner: unknown[] = [];
      if (partnerId) {
        // Only these three columns: never the partner's email address or tokens.
        const { data: theirs, error: thErr } = await admin().from("calendar_connections")
          .select("provider, check_conflicts, add_bookings").eq("user_id", partnerId);
        if (thErr) return json({ error: "db_error", detail: thErr.message }, 500);
        partner = (theirs || []).map((c: { provider: string; check_conflicts: boolean; add_bookings: boolean }) =>
          ({ provider: c.provider, check_conflicts: c.check_conflicts, add_bookings: c.add_bookings }));
      }
      const mineOut = (mine || []).map((c: Record<string, unknown>) => ({
        provider: c.provider, account_email: c.account_email ?? null, check_conflicts: c.check_conflicts, add_bookings: c.add_bookings,
        connected_at: c.connected_at, last_error: c.last_error ?? null,
      }));
      return json({ configured, mine: mineOut, partner });
    }

    if (!me) return json({ error: "no_household" }, 400);
    const provider = body.provider as Provider;

    /* ---------- connect ---------- */
    if (action === "connect") {
      if (!providerConfigured(provider)) return json({ error: "not_configured" }, 409);
      const returnTo = safeReturnTo(body.returnTo);
      if (!returnTo) return json({ error: "server_error", detail: "APP_URL is not set" }, 500);
      const state = await signState({ uid: user.id, provider, returnTo });
      return json({ url: clients[provider].authUrl(state) });
    }

    /* ---------- finish ---------- */
    // Completes a connection the callback parked in calendar_pending, but only for the person who started it.
    // This is what stops someone attaching another person's calendar to their own account (see the migration).
    if (action === "finish") {
      if (!isPendingKey(body.k)) return json({ error: "bad_request", detail: "k must be the key from the calendar=pending redirect" }, 400);
      const k: string = body.k;
      const { data: p, error: pErr } = await admin().from("calendar_pending")
        .select("k, uid, provider, refresh_token_enc, access_token_enc, access_expires_at, account_email, expires_at").eq("k", k).maybeSingle();
      if (pErr) return json({ error: "db_error", detail: pErr.message }, 500);
      // Housekeeping: clear other expired pending rows (after the read, so this one can still answer 410).
      // A failure here changes nothing for this request.
      await admin().from("calendar_pending").delete().lt("expires_at", new Date().toISOString()).neq("k", k);
      if (!p) return json({ error: "not_found" }, 404); // never existed, already finished, or expired and cleared
      const drop = async () => (await admin().from("calendar_pending").delete().eq("k", k)).error;
      if (p.uid !== user.id) {
        const dErr = await drop();
        if (dErr) return json({ error: "db_error", detail: dErr.message }, 500);
        return json({ error: "not_yours" }, 403);
      }
      if (!(Date.parse(p.expires_at) > Date.now())) {
        const dErr = await drop();
        if (dErr) return json({ error: "db_error", detail: dErr.message }, 500);
        return json({ error: "expired" }, 410);
      }
      if (!isProvider(p.provider)) return json({ error: "server_error", detail: "unknown provider in pending row" }, 500);
      const pa = pendingAad(k, p.uid, p.provider), ca = aadFor(user.id, p.provider);
      let refreshEnc: string, accessEnc: string | null = null;
      try {
        // Re-encrypt from the pending row's associated data to the connection's.
        refreshEnc = await encryptToken(await decryptToken(p.refresh_token_enc, pa), ca);
        if (p.access_token_enc) accessEnc = await encryptToken(await decryptToken(p.access_token_enc, pa), ca);
      } catch (e) {
        await drop();
        return json({ error: "server_error", detail: codeOf(e) }, 500);
      }
      const now = new Date().toISOString();
      const { error: upErr } = await admin().from("calendar_connections").upsert({
        user_id: user.id, household_id: me.household_id, provider: p.provider, account_email: p.account_email ?? null,
        refresh_token_enc: refreshEnc, access_token_enc: accessEnc, access_expires_at: accessEnc ? p.access_expires_at : null,
        connected_at: now, updated_at: now, last_error: null,
      }, { onConflict: "user_id,provider" });
      // Keep the pending row on failure, so finishing again can work.
      if (upErr) return json({ error: "db_error", detail: upErr.message }, 500);
      const dErr = await drop();
      // Connected either way. A leftover row can only be finished again by the same person and expires in 10 minutes.
      if (dErr) return json({ ok: true, provider: p.provider, detail: `connected, but could not clear the pending row: ${dErr.message}` });
      return json({ ok: true, provider: p.provider });
    }

    /* ---------- disconnect ---------- */
    if (action === "disconnect") {
      const { data: row, error: rowErr } = await admin().from("calendar_connections").select(CONN_COLUMNS)
        .eq("user_id", user.id).eq("provider", provider).maybeSingle();
      if (rowErr) return json({ error: "db_error", detail: rowErr.message }, 500);
      if (!row) return json({ ok: true, revoked: false });
      // Best effort: a revoke that fails (or a token we can no longer decrypt) doesn't stop the disconnect.
      let revoked = false;
      try { revoked = await clients[provider].revoke(await decryptToken(row.refresh_token_enc, `${user.id}:${provider}`)); } catch { /* keep going */ }
      const { error: evErr } = await admin().from("calendar_events").delete().eq("user_id", user.id).eq("provider", provider);
      if (evErr) return json({ error: "db_error", detail: evErr.message }, 500);
      const { error: delErr } = await admin().from("calendar_connections").delete().eq("user_id", user.id).eq("provider", provider);
      if (delErr) return json({ error: "db_error", detail: delErr.message }, 500);
      return json({ ok: true, revoked });
    }

    /* ---------- settings ---------- */
    if (action === "settings") {
      const patch: Record<string, unknown> = {};
      for (const k of ["check_conflicts", "add_bookings"]) {
        if (body[k] === undefined) continue;
        if (typeof body[k] !== "boolean") return json({ error: "bad_request", detail: `${k} must be true or false` }, 400);
        patch[k] = body[k];
      }
      if (!Object.keys(patch).length) return json({ error: "bad_request", detail: "give check_conflicts or add_bookings" }, 400);
      patch.updated_at = new Date().toISOString();
      const { data: rows, error: upErr } = await admin().from("calendar_connections").update(patch)
        .eq("user_id", user.id).eq("provider", provider).select("provider");
      if (upErr) return json({ error: "db_error", detail: upErr.message }, 500);
      if (!rows || !rows.length) return json({ error: "not_connected" }, 404);
      return json({ ok: true });
    }

    /* ---------- busy ---------- */
    if (action === "busy") {
      if (!isDay(body.from) || !isDay(body.to)) return json({ error: "bad_request", detail: "from and to must be YYYY-MM-DD" }, 400);
      if (!isTz(body.tz)) return json({ error: "bad_request", detail: "tz must be an IANA time zone, such as America/Chicago" }, 400);
      const span = daysBetween(body.from, body.to);
      if (span < 0) return json({ error: "bad_request", detail: "to is before from" }, 400);
      if (span + 1 > MAX_RANGE_DAYS) return json({ error: "bad_request", detail: `at most ${MAX_RANGE_DAYS} days` }, 400);
      // From the start of `from` to the end of `to`, local midnight to local midnight in tz.
      const fromISO = new Date(zonedToUtc(body.from, "00:00", body.tz)).toISOString();
      const toISO = new Date(zonedToUtc(addDays(body.to, 1), "00:00", body.tz)).toISOString();
      let hb;
      try {
        hb = await householdBusy(admin(), me.household_id, fromISO, toISO);
      } catch (e) {
        return json({ error: codeOf(e) === "db_error" ? "db_error" : "server_error", detail: (e as CalError).detail || codeOf(e) }, 500);
      }
      return json({
        busy: hb.busy.map((b) => ({ start: b.start, end: b.end, who: whoOf(b.user_id) })),
        checked: { me: !!hb.checked[user.id], partner: !!(partnerId && hb.checked[partnerId]) },
        errors: hb.errors.map((e) => ({ who: whoOf(e.user_id), provider: e.provider, error: e.error })),
      });
    }

    /* ---------- add_event ---------- */
    if (!isUuid(body.taskId)) return json({ error: "bad_request", detail: "taskId must be a uuid" }, 400);
    const { data: task, error: tErr } = await sb.from("tasks").select("id, title, status, booking").eq("id", body.taskId).maybeSingle();
    if (tErr) return json({ error: "db_error", detail: tErr.message }, 500);
    if (!task) return json({ error: "task_not_found" }, 404); // RLS hides other households' tasks too
    const bk = task.booking as Record<string, unknown> | null;
    if (task.status !== "booked" || !bk || typeof bk !== "object") return json({ error: "not_booked", status: task.status }, 409);
    const { data: hh, error: hhErr } = await sb.from("households").select("timezone").eq("id", me.household_id).maybeSingle();
    if (hhErr) return json({ error: "db_error", detail: hhErr.message }, 500);
    const tz = isTz(hh?.timezone) ? hh!.timezone : isTz(body.tz) ? body.tz : "UTC";
    const iv = localInterval(bk, tz);
    if (!iv) return json({ error: "not_booked", detail: "the booking has no usable date and times" }, 409);
    const startL = utcToLocal(iv[0], tz), endL = utcToLocal(iv[1], tz);
    const appUrl = safeReturnTo(null);
    const ev = {
      title: `${String(task.title).slice(0, 200)}: ${String(bk.vendor || "Booking").slice(0, 90)}`,
      description: [
        bk.confirmation ? `Confirmation: ${String(bk.confirmation).slice(0, 40)}` : "",
        `All-in cap: ${money(bk.capCents)}`,
        appUrl ? `Booked with Ampersand: ${appUrl}` : "Booked with Ampersand",
      ].filter(Boolean).join("\n"),
      startLocal: `${startL.date}T${startL.time}:00`, endLocal: `${endL.date}T${endL.time}:00`,
      startRfc: rfc3339Local(iv[0], tz), endRfc: rfc3339Local(iv[1], tz), tz,
    };

    const memberIds = [user.id, ...(partnerId ? [partnerId] : [])];
    const { data: conns, error: cErr } = await admin().from("calendar_connections").select(`${CONN_COLUMNS}, add_bookings`)
      .in("user_id", memberIds).eq("household_id", me.household_id);
    if (cErr) return json({ error: "db_error", detail: cErr.message }, 500);

    const added: { who: string; provider: string }[] = [];
    const skipped: { who: string; provider: string; reason: string }[] = [];
    const errors: { who: string; provider: string; error: string }[] = [];
    const taskId: string = task.id;
    await Promise.all((conns || []).map(async (c: Conn & { add_bookings: boolean }) => {
      const who = whoOf(c.user_id);
      if (!isProvider(c.provider)) return;
      if (!c.add_bookings) { skipped.push({ who, provider: c.provider, reason: "add_bookings_off" }); return; }
      if (!providerConfigured(c.provider)) { errors.push({ who, provider: c.provider, error: "not_configured" }); return; }
      // Claim the (task, person, provider) slot first, so two calls at once can't both create the event.
      const { error: claimErr } = await admin().from("calendar_events")
        .insert({ task_id: taskId, user_id: c.user_id, provider: c.provider, event_id: "pending" });
      if (claimErr) {
        if (claimErr.code === "23505") skipped.push({ who, provider: c.provider, reason: "already_added" });
        else errors.push({ who, provider: c.provider, error: "db_error" });
        return;
      }
      // deno-lint-ignore no-explicit-any
      const match = (q: any) => q.eq("task_id", taskId).eq("user_id", c.user_id).eq("provider", c.provider);
      let eventId: string;
      try {
        eventId = await withAccess(admin(), c, (tok) => clients[c.provider].createEvent(tok, ev));
      } catch (e) {
        // Release the claim so a later call can try again. If that fails too, say so.
        const { error: relErr } = await match(admin().from("calendar_events").delete());
        errors.push({ who, provider: c.provider, error: codeOf(e) });
        if (relErr) errors.push({ who, provider: c.provider, error: "could_not_release" });
        return;
      }
      const { error: recErr } = await match(admin().from("calendar_events").update({ event_id: eventId }));
      added.push({ who, provider: c.provider });
      // The event exists; only our record of its id failed. It still won't be added twice (the claim stays).
      if (recErr) errors.push({ who, provider: c.provider, error: "not_recorded" });
    }));
    const order = (a: { who: string; provider: string }, b: { who: string; provider: string }) =>
      (a.who + a.provider).localeCompare(b.who + b.provider);
    return json({ added: added.sort(order), skipped: skipped.sort(order), errors: errors.sort(order) });
  } catch (e) {
    if (e instanceof CalError) return json({ error: e.code === "db_error" ? "db_error" : "server_error", detail: e.detail || e.code }, 500);
    return json({ error: "server_error", detail: String((e as Error).message || e).slice(0, 300) }, 500);
  }
});
