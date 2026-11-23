// Ampersand calendar-callback: where Google and Microsoft send the browser back after the consent screen.
// Deployed with --no-verify-jwt (the browser arrives here from the provider, with no Supabase session).
// It trusts nothing but the HMAC-signed state that the calendar function made for a signed-in person:
// that says who is connecting which provider and where to send them back (re-checked against APP_URL).
// It exchanges the code and parks the encrypted tokens in calendar_pending under a random key k, then 302s back
// with ?calendar=pending&provider=<p>&k=<k> (or ?calendar=error&reason=<fixed code>). It never writes
// calendar_connections: the state says who STARTED connecting, not who is in this browser, so the calendar
// function's `finish` action moves the row over only when the signed-in person is that same person.
// Provider error text is never passed on.
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  CalError, clients, encryptToken, isProvider, newPendingKey, pendingAad, PENDING_TTL_MS, providerConfigured, safeReturnTo, verifyState,
} from "../_shared/calendar.ts";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function plain(status: number, text: string) {
  return new Response(text, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
}

// returnTo must already be an allowed address (from safeReturnTo). Only fixed codes go into the query.
function back(returnTo: string, outcome: "pending" | "error", provider: string | null, reason?: string, k?: string) {
  const u = new URL(returnTo);
  for (const x of ["calendar", "provider", "reason", "k"]) u.searchParams.delete(x);
  u.searchParams.set("calendar", outcome);
  if (provider) u.searchParams.set("provider", provider);
  if (reason) u.searchParams.set("reason", reason);
  if (k) u.searchParams.set("k", k);
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: u.toString() } });
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return plain(405, "Method not allowed");
  const fallback = safeReturnTo(null); // APP_URL
  const fail = (reason: string) => (fallback ? back(fallback, "error", null, reason) : plain(400, `Calendar connection failed: ${reason}`));
  try {
    const q = new URL(req.url).searchParams;
    const v = await verifyState(q.get("state"));
    if (!v.ok && v.reason === "bad_state") return fail("bad_state");
    const st = v.state!;
    // The signature is good, but re-check where it sends people, in case APP_URL changed since.
    const returnTo = safeReturnTo(st.returnTo);
    if (!returnTo) return plain(400, "Calendar connection failed: no return address");
    if (!isProvider(st.provider)) return back(returnTo, "error", null, "unknown_provider");
    const provider = st.provider;
    if (!v.ok) return back(returnTo, "error", provider, "expired");
    if (q.get("error")) return back(returnTo, "error", provider, q.get("error") === "access_denied" ? "denied" : "provider_error");
    const code = q.get("code");
    if (!code || code.length > 4096) return back(returnTo, "error", provider, "no_code");
    if (!providerConfigured(provider)) return back(returnTo, "error", provider, "not_configured");

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) return back(returnTo, "error", provider, "server_error");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // The person must still be in a household.
    const { data: me, error: meErr } = await admin.from("members").select("household_id").eq("user_id", st.uid).maybeSingle();
    if (meErr) return back(returnTo, "error", provider, "db_error");
    if (!me) return back(returnTo, "error", provider, "no_household");

    const client = clients[provider];
    let tokens;
    try {
      tokens = await client.exchange(code);
    } catch {
      return back(returnTo, "error", provider, "exchange_failed");
    }
    if (!tokens.refresh_token) return back(returnTo, "error", provider, "no_refresh_token");
    if (!client.hasScopes(tokens)) return back(returnTo, "error", provider, "missing_scopes");
    let email: string | null = null;
    try { email = await client.email(tokens); } catch { /* the email is only a label; connect without it */ }

    // Clear out expired pending rows while we're here. Only housekeeping: a failure changes nothing.
    await admin.from("calendar_pending").delete().lt("expires_at", new Date().toISOString());

    const k = newPendingKey();
    const aad = pendingAad(k, st.uid, provider);
    const now = Date.now();
    const { error: insErr } = await admin.from("calendar_pending").insert({
      k, uid: st.uid, household_id: me.household_id, provider, account_email: email,
      refresh_token_enc: await encryptToken(tokens.refresh_token, aad),
      access_token_enc: await encryptToken(tokens.access_token, aad),
      access_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
      created_at: new Date(now).toISOString(), expires_at: new Date(now + PENDING_TTL_MS).toISOString(),
    });
    if (insErr) return back(returnTo, "error", provider, "db_error");
    return back(returnTo, "pending", provider, undefined, k);
  } catch (e) {
    return fail(e instanceof CalError ? (e.code === "not_configured" ? "not_configured" : "server_error") : "server_error");
  }
});
