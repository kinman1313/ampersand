// Ampersand notify: emails your partner when you need them to come back ("nudges").
// Everything about the caller's household, task and approvals is read with the CALLER's session,
// so row-level security decides what it can see. The service role is used only to look up the
// partner's email address and to read and write notify_log. It never touches private_items.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const KINDS = ["yes", "options"];
const THROTTLE_MS = 6 * 60 * 60 * 1000; // one email per (recipient, task, kind) per 6 hours
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP = 20; // emails per recipient per 24 hours
const isUuid = (s: unknown) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

type Option = { id?: string; vendor?: string; title?: string; date?: string; start?: string; end?: string; totalCents?: number; includes?: string };

// Must match termsHash() in index.html and public.terms_hash() in SQL.
// SQL: concat_ws('|', coalesce(o->>'vendor',''), ... coalesce(o->>'totalCents',''), coalesce(o->>'includes','')).
// Array.join renders null/undefined as '' like coalesce, and renders the number 15000 as "15000"
// just as o->>'totalCents' does for a jsonb number. (They would differ only for odd values such as
// 1e21 or a nested object, which the agent never writes.)
const termsHash = (o: Option) => [o.vendor, o.date, o.start, o.end, o.totalCents, o.includes || ""].join("|");

// Escape every user- or agent-provided string before it goes into the HTML email.
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
// Subjects are one line.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim().slice(0, 150);

function money(cents: unknown) {
  const c = Number(cents);
  if (!Number.isFinite(c) || c <= 0) return "price to confirm";
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

function day(d: unknown) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) return String(d || "a date to confirm");
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// The link back to the app. With APP_URL set, only links on that same site are used (so a member
// can't put a link of their choosing in an email sent from our domain); otherwise the caller's own
// address if it looks safe; else no link.
function pickAppUrl(given: unknown): string | null {
  const fixed = Deno.env.get("APP_URL") || null;
  if (fixed) {
    try { if (typeof given === "string" && given.length < 200 && new URL(given).origin === new URL(fixed).origin) return given; } catch { /* use APP_URL */ }
    return fixed;
  }
  if (typeof given === "string" && given.length < 200 &&
      (/^https:\/\/[^\s"'<>]+$/.test(given) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s"'<>]*)?$/.test(given))) {
    try { new URL(given); return given; } catch { /* fall through */ }
  }
  return Deno.env.get("APP_URL") || null;
}

type Email = { subject: string; lines: string[] };

function render(e: Email, partnerName: string, callerName: string, appUrl: string | null) {
  const footer = `You get these because you share a list with ${callerName} on Ampersand. Turn them off in Ampersand → Settings.`;
  const text = [`Hi ${partnerName},`, "", ...e.lines, ...(appUrl ? ["", `Open Ampersand: ${appUrl}`] : []), "", "—", footer].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">
<p>Hi ${esc(partnerName)},</p>
${e.lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join("\n")}
${appUrl ? `<p><a href="${esc(appUrl)}" style="color:#2f5fd0">Open Ampersand</a></p>` : ""}
<p style="margin-top:24px;font-size:12px;color:#777">${esc(footer)}</p>
</body></html>`;
  return { subject: oneLine(e.subject), text, html };
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
    if (!body || typeof body !== "object") return json({ error: "bad_request", detail: "body must be a JSON object" }, 400);
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("NOTIFY_FROM");
    if (body.action === "status") return json({ email: !!(resendKey && from) });
    if (body.action !== "nudge") return json({ error: "bad_request", detail: "action must be nudge or status" }, 400);
    if (!KINDS.includes(body.kind)) return json({ error: "bad_request", detail: "kind must be yes or options" }, 400);
    if (!isUuid(body.taskId)) return json({ error: "bad_request", detail: "taskId must be a uuid" }, 400);
    const taskId: string = body.taskId;

    /* ---------- caller, household, task: all with the caller's session ---------- */
    const { data: me, error: meErr } = await sb.from("members").select("household_id, display_name").eq("user_id", user.id).maybeSingle();
    if (meErr) return json({ error: "db_error", detail: meErr.message }, 500);
    if (!me) return json({ error: "no_household" }, 400);
    const { data: members, error: memErr } = await sb.from("members").select("user_id, display_name, notify_email").eq("household_id", me.household_id);
    if (memErr) return json({ error: "db_error", detail: memErr.message }, 500);
    const { data: task, error: tErr } = await sb.from("tasks").select("id, household_id, title, status, options").eq("id", taskId).maybeSingle();
    if (tErr) return json({ error: "db_error", detail: tErr.message }, 500);
    if (!task) return json({ error: "task_not_found" }, 404); // RLS hides other households' tasks too
    const options: Option[] = Array.isArray(task.options) ? task.options : [];
    const partner = (members || []).find((m) => m.user_id !== user.id);
    const callerName = me.display_name;

    let kind: "yes" | "agreed" | "options";
    let email: Email;
    if (body.kind === "yes") {
      if (task.status === "booked" || task.status === "done") return json({ error: "task_closed", status: task.status }, 409);
      const { data: approvals, error: aErr } = await sb.from("approvals").select("user_id, yes_option_id, yes_hash").eq("task_id", taskId);
      if (aErr) return json({ error: "db_error", detail: aErr.message }, 500);
      const mine = (approvals || []).find((a) => a.user_id === user.id);
      const opt = mine && options.find((o) => o && o.id === mine.yes_option_id && termsHash(o) === mine.yes_hash);
      if (!opt) return json({ error: "no_current_yes" }, 409);
      const theirs = partner && (approvals || []).find((a) => a.user_id === partner.user_id);
      if (theirs && theirs.yes_option_id === opt.id && theirs.yes_hash === mine!.yes_hash) {
        kind = "agreed";
        email = {
          subject: "You both said yes: ready to book",
          lines: [`You both said yes to ${opt.vendor || "the same option"} on ${day(opt.date)}. Open Ampersand to book it.`],
        };
      } else {
        kind = "yes";
        email = {
          subject: `${callerName} said yes — your turn`,
          lines: [
            `${callerName} said yes to ${opt.title || opt.vendor || "an option"} (${opt.vendor || "vendor to confirm"}, ${day(opt.date)}, ${money(opt.totalCents)} all-in) for “${task.title}”.`,
            "Your turn: say yes to the same one, or pick another.",
          ],
        };
      }
    } else {
      if (task.status !== "open" || options.length === 0) return json({ error: "no_options", status: task.status }, 409);
      kind = "options";
      const n = options.length;
      const noun = n === 1 ? "option" : "options";
      email = {
        subject: `${n} ${noun} for “${task.title}”`,
        lines: [
          `The agent found ${n} ${noun} for “${task.title}”.`,
          ...options.map((o) => `• ${o.vendor || "Local provider"}, ${day(o.date)}, ${money(o.totalCents)}`),
        ],
      };
    }

    /* ---------- recipient and whether to send ---------- */
    if (!partner) return json({ sent: false, reason: "no_partner" });
    if (partner.notify_email === false) return json({ sent: false, reason: "opted_out" });
    if (!resendKey || !from) return json({ sent: false, reason: "email_not_configured" });
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) return json({ error: "server_error", detail: "SUPABASE_SERVICE_ROLE_KEY is not set" }, 500);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const now = Date.now();
    const { count: recent, error: thErr } = await admin.from("notify_log").select("id", { count: "exact", head: true })
      .eq("recipient", partner.user_id).eq("task_id", taskId).eq("kind", kind).gte("sent_at", new Date(now - THROTTLE_MS).toISOString());
    if (thErr) return json({ error: "db_error", detail: thErr.message }, 500);
    if ((recent ?? 0) > 0) return json({ sent: false, reason: "throttled" });
    const { count: today, error: capErr } = await admin.from("notify_log").select("id", { count: "exact", head: true })
      .eq("recipient", partner.user_id).gte("sent_at", new Date(now - DAY_MS).toISOString());
    if (capErr) return json({ error: "db_error", detail: capErr.message }, 500);
    if ((today ?? 0) >= DAILY_CAP) return json({ sent: false, reason: "daily_cap" });

    const { data: au, error: auErr } = await admin.auth.admin.getUserById(partner.user_id);
    if (auErr) return json({ error: "db_error", detail: `could not look up partner: ${auErr.message}` }, 500);
    const to = au?.user?.email;
    if (!to) return json({ sent: false, reason: "no_email" });

    /* ---------- send ---------- */
    const msg = render(email, partner.display_name, callerName, pickAppUrl(body.appUrl));
    let r: Response;
    try {
      r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject: msg.subject, text: msg.text, html: msg.html }),
      });
    } catch (e) {
      return json({ error: "send_failed", detail: `Resend unreachable: ${String((e as Error).message || e).slice(0, 300)}` }, 502);
    }
    if (!r.ok) {
      const detail = `Resend ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`;
      return json({ error: "send_failed", detail }, 502);
    }

    // The email went out. If logging fails, say so, but still report it as sent.
    const { error: logErr } = await admin.from("notify_log").insert({ household_id: me.household_id, recipient: partner.user_id, task_id: taskId, kind });
    if (logErr) return json({ sent: true, kind, logged: false, detail: logErr.message });
    return json({ sent: true, kind });
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error).message || e).slice(0, 300) }, 500);
  }
});
