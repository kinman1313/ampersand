// Ampersand outreach: drafts and sends quote requests or booking confirmations to suggested vendors.
// Reads tasks, approvals and household details with the CALLER's session (RLS enforced).
// Never touches private_items. Uses the service role only for rate-limiting, looking up the caller's
// reply-to email fallback, and recording threads/messages after Resend accepts the email.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { addDays, busyLines, daysBetween, householdBusy, isTz, zonedToUtc } from "../_shared/calendar.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const DRAFT_MODEL = "claude-haiku-5-5";
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_HOUSEHOLD_CAP = 10; // outbound vendor emails per household per 24h
const CALENDAR_TIMEOUT_MS = 8000;

const isUuid = (s: unknown) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isEmail = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 5 && s.length <= 160 && !/[\r\n]/.test(s) && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/.test(s.trim());
const oneLine = (s: unknown, max = 160) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

type Option = {
  id?: string; vendor?: string; title?: string; detail?: string; date?: string;
  start?: string; end?: string; totalCents?: number; includes?: string;
  url?: string | null; vendorEmail?: string | null; priceIsEstimate?: boolean;
};

// Must match termsHash() in index.html and public.terms_hash() in SQL.
const termsHash = (o: Option) => [o.vendor, o.date, o.start, o.end, o.totalCents, o.includes || ""].join("|");

function money(cents: unknown) {
  const c = Number(cents);
  if (!Number.isFinite(c) || c <= 0) return "price to confirm";
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

function fmtDay(d: unknown) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) return String(d || "flexible date");
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtTime(t: unknown) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  if (!m) return String(t || "");
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

function randomToken(bytes = 18): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function extractJSON(text: string): Record<string, unknown> | null {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  for (let i = text.indexOf("{"); i >= 0 && i < end; i = text.indexOf("{", i + 1)) {
    try { return JSON.parse(text.slice(i, end + 1)); } catch { /* keep scanning */ }
  }
  return null;
}

function addLog(log: unknown, text: string) {
  const arr = Array.isArray(log) ? log : [];
  return [...arr, { at: Date.now(), who: "agent", text }].slice(-40);
}

function renderVendorHtml(bodyText: string): string {
  const paras = bodyText.trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, "<br>")}</p>`
  ).join("\n");
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2421;max-width:580px">\n${paras}\n</body></html>`;
}

function fallbackDraft(
  kind: "quote" | "confirm",
  taskTitle: string,
  opt: Option,
  callerName: string,
  partnerName: string | null,
  homeBase: string,
  contactPhone: string | null,
  serviceAddress: string | null,
): { subject: string; body: string } {
  const who = partnerName ? `${callerName} & ${partnerName}` : callerName;
  const slot = `${fmtDay(opt.date)}, ${fmtTime(opt.start)}–${fmtTime(opt.end)}`;
  if (kind === "confirm") {
    const contactLines = [
      serviceAddress ? `Address: ${serviceAddress}` : null,
      contactPhone ? `Phone: ${contactPhone}` : null,
    ].filter(Boolean);
    return {
      subject: `Booking confirmation: ${opt.title || taskTitle} (${fmtDay(opt.date)})`,
      body: [
        `Hi ${opt.vendor || "there"},`,
        "",
        `We'd love to go ahead and book "${opt.title || taskTitle}" on ${slot} at the quoted total of ${money(opt.totalCents)} all-in${opt.includes ? ` (${opt.includes})` : ""}.`,
        ...(contactLines.length ? ["", ...contactLines] : []),
        "",
        "Could you reply to confirm this slot and total? Let us know if you need anything else from us.",
        "",
        `Thanks,\n${who}`,
      ].join("\n"),
    };
  }
  return {
    subject: `Quote & availability request: ${taskTitle}`,
    body: [
      `Hi ${opt.vendor || "there"},`,
      "",
      `We're in ${homeBase} and looking for "${taskTitle}"${opt.title ? ` (${opt.title})` : ""}.`,
      `Would you be available around ${slot}? Could you reply with your all-in quote (including any fees/tax), what's included, and whether that window works — or another nearby time that does?`,
      "",
      `Thanks so much,\n${who}`,
    ].join("\n"),
  };
}

// deno-lint-ignore no-explicit-any
async function freeBusyContext(sb: any, householdId: string, today: string, due: unknown, clientTz: unknown): Promise<string> {
  try {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey || !Deno.env.get("CALENDAR_TOKEN_KEY")) return "";
    const { data: hh } = await sb.from("households").select("timezone").eq("id", householdId).maybeSingle();
    const tz = isTz(hh?.timezone) ? hh!.timezone : isTz(clientTz) ? clientTz : "UTC";
    let end = typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due) && due >= today ? due : addDays(today, 21);
    if (daysBetween(today, end) + 1 > 62) end = addDays(today, 61);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const work = householdBusy(admin, householdId, new Date(zonedToUtc(today, "00:00", tz)).toISOString(),
      new Date(zonedToUtc(addDays(end, 1), "00:00", tz)).toISOString()).catch(() => null);
    let timer: number | undefined;
    const timeout = new Promise<null>((res) => { timer = setTimeout(() => res(null), CALENDAR_TIMEOUT_MS); });
    const hb = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
    if (!hb || !Object.values(hb.checked).some(Boolean)) return "";
    const lines = busyLines(hb.busy, tz);
    return lines.length ? `Times the couple is BUSY (do NOT suggest these): ${lines.join("; ")}.` : "Their calendars are currently open.";
  } catch {
    return "";
  }
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
    const inboundAddress = (Deno.env.get("OUTREACH_INBOUND_ADDRESS") || "").trim().toLowerCase();
    const inboundParts = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(inboundAddress);
    const inboundUser = inboundParts ? inboundParts[1] : "reply";
    const inboundDomain = inboundParts ? inboundParts[2] : ((Deno.env.get("OUTREACH_INBOUND_DOMAIN") || "").trim().toLowerCase() || null);
    const fromAddr = Deno.env.get("OUTREACH_FROM") || (inboundParts ? `Jeeves via Ampersand <${inboundAddress}>` : "") || Deno.env.get("NOTIFY_FROM") || "";
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") || "";

    if (body.action === "status") {
      return json({
        configured: !!(resendKey && fromAddr),
        inboundDomain,
        inboundAddress: inboundParts ? inboundAddress : null,
        canDraft: !!anthropicKey,
      });
    }

    if (body.action !== "draft" && body.action !== "send") {
      return json({ error: "bad_request", detail: "action must be status, draft or send" }, 400);
    }
    const kind = body.kind === "confirm" ? "confirm" : body.kind === "quote" ? "quote" : null;
    if (!kind) return json({ error: "bad_request", detail: "kind must be quote or confirm" }, 400);
    if (!isUuid(body.taskId)) return json({ error: "bad_request", detail: "taskId must be a uuid" }, 400);
    const optionId = typeof body.optionId === "string" ? body.optionId.trim() : "";
    if (!optionId || optionId.length > 64) return json({ error: "bad_request", detail: "optionId is required" }, 400);

    /* ---------- Read household, task & approvals with the CALLER's session ---------- */
    const { data: me, error: meErr } = await sb.from("members").select("household_id, display_name").eq("user_id", user.id).maybeSingle();
    if (meErr) return json({ error: "db_error", detail: meErr.message }, 500);
    if (!me) return json({ error: "no_household" }, 400);

    const { data: members, error: memErr } = await sb.from("members").select("user_id, display_name").eq("household_id", me.household_id);
    if (memErr) return json({ error: "db_error", detail: memErr.message }, 500);

    const { data: hh, error: hhErr } = await sb.from("households").select("home_base, contact_phone, service_address").eq("id", me.household_id).single();
    if (hhErr) return json({ error: "db_error", detail: hhErr.message }, 500);

    const { data: task, error: tErr } = await sb.from("tasks").select("id, household_id, title, project, due, due_reason, budget_cents, status, options, log").eq("id", body.taskId).maybeSingle();
    if (tErr) return json({ error: "db_error", detail: tErr.message }, 500);
    if (!task) return json({ error: "task_not_found" }, 404);

    const options: Option[] = Array.isArray(task.options) ? task.options : [];
    const opt = options.find((o) => o && o.id === optionId);
    if (!opt) return json({ error: "option_not_found" }, 404);

    const partner = (members || []).find((m) => m.user_id !== user.id) || null;
    const homeBase = hh?.home_base || "Allen, TX";

    // Mutual approval check for booking confirmation emails
    if (kind === "confirm") {
      if (task.status === "booked" || task.status === "done") return json({ error: "task_closed", status: task.status }, 409);
      const { data: approvals, error: aErr } = await sb.from("approvals").select("user_id, yes_option_id, yes_hash").eq("task_id", task.id);
      if (aErr) return json({ error: "db_error", detail: aErr.message }, 500);
      const h = termsHash(opt);
      const agreed = (members || []).length >= 2 && (members || []).every((m) =>
        (approvals || []).some((a) => a.user_id === m.user_id && a.yes_option_id === optionId && a.yes_hash === h)
      );
      if (!agreed) return json({ error: "not_agreed", detail: "Both of you must say yes to this option's current terms before emailing to confirm." }, 409);
    }

    // Look up any existing thread for this task + option (best-effort; table may be empty)
    const { data: existingThreads } = await sb.from("vendor_threads")
      .select("id, vendor_email, subject, last_message_id, status")
      .eq("task_id", task.id).eq("option_id", optionId).order("updated_at", { ascending: false }).limit(1);
    const existing = Array.isArray(existingThreads) && existingThreads.length ? existingThreads[0] : null;

    /* ---------- action: draft ---------- */
    if (body.action === "draft") {
      const base = fallbackDraft(
        kind, task.title, opt, me.display_name, partner?.display_name || null, homeBase,
        kind === "confirm" ? (hh?.contact_phone || null) : null,
        kind === "confirm" ? (hh?.service_address || null) : null,
      );
      let subject = existing?.subject ? (existing.subject.startsWith("Re:") ? existing.subject : `Re: ${existing.subject}`) : base.subject;
      let emailBody = base.body;

      if (anthropicKey) {
        const today = typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10);
        const busyNote = kind === "quote" ? await freeBusyContext(sb, me.household_id, today, task.due, body.tz) : "";
        const couple = partner ? `${me.display_name} and ${partner.display_name}` : me.display_name;
        const prompt = kind === "quote"
          ? `Write a brief, polite, natural email from ${couple} (living in ${homeBase}) to a local business ("${opt.vendor}") requesting a quote and confirming availability.
Task: "${task.title}". Service/option: "${opt.title || task.title}".
Target window: ${fmtDay(opt.date)}, ${fmtTime(opt.start)}–${fmtTime(opt.end)}.${task.due ? ` Needed by ${task.due}.` : ""}${task.budget_cents ? ` Keep in mind their target budget is around ${money(task.budget_cents)}, though you don't have to state the ceiling unless helpful.` : ""}
${busyNote}
Rules:
- Keep it short (3–5 sentences), warm, and human — never mention "AI", "agent", or "Ampersand".
- NEVER include a street address or phone number. Only mention ${homeBase} for area.
- Ask them to reply with their all-in price (tax/fees included), what's included, and whether that time window works (or an alternative).
Respond with JSON only: {"subject":"...","body":"..."}`
          : `Write a brief, polite, natural booking confirmation email from ${couple} to "${opt.vendor}".
Agreed service: "${opt.title || task.title}" for "${task.title}".
Exact agreed terms: ${fmtDay(opt.date)}, ${fmtTime(opt.start)}–${fmtTime(opt.end)}, ${money(opt.totalCents)} all-in${opt.includes ? `, includes: ${opt.includes}` : ""}.
${hh?.service_address ? `Service address: ${hh.service_address}.` : "No street address saved yet — ask if they need the address."}
${hh?.contact_phone ? `Contact phone: ${hh.contact_phone}.` : ""}
Rules:
- Keep it short (3–5 sentences), warm, and human — never mention "AI", "agent", or "Ampersand".
- State the exact date, time window, inclusions, and all-in total clearly so there are no surprises, and ask for a quick reply confirming the booking.
Respond with JSON only: {"subject":"...","body":"..."}`;
        try {
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model: DRAFT_MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
          });
          if (r.ok) {
            const j = await r.json();
            const txt = (j.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
            const parsed = extractJSON(txt);
            if (parsed && typeof parsed.body === "string" && parsed.body.trim().length >= 20) {
              emailBody = parsed.body.trim().slice(0, 2800);
              if (!existing?.subject && typeof parsed.subject === "string" && parsed.subject.trim()) {
                subject = oneLine(parsed.subject, 140);
              }
            }
          }
        } catch { /* fall back cleanly to deterministic draft */ }
      }

      return json({
        ok: true,
        kind,
        subject,
        body: emailBody,
        vendorName: opt.vendor || "Vendor",
        vendorEmail: existing?.vendor_email || opt.vendorEmail || "",
        threadId: existing?.id || null,
        hasContactInfo: !!(hh?.contact_phone || hh?.service_address),
        replyMode: inboundDomain ? "inbound" : "direct",
      });
    }

    /* ---------- action: send ---------- */
    if (!resendKey || !fromAddr) return json({ error: "email_not_configured", detail: "Email outreach needs RESEND_API_KEY and NOTIFY_FROM (or OUTREACH_FROM)." }, 503);
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) return json({ error: "server_error", detail: "SUPABASE_SERVICE_ROLE_KEY is not set" }, 500);

    const toEmail = typeof body.toEmail === "string" ? body.toEmail.trim().toLowerCase() : "";
    if (!isEmail(toEmail)) return json({ error: "bad_request", detail: "Enter a valid vendor email address." }, 400);
    const subject = oneLine(body.subject, 160);
    if (!subject) return json({ error: "bad_request", detail: "Add a subject line." }, 400);
    const emailBody = typeof body.body === "string" ? body.body.trim().slice(0, 3000) : "";
    if (emailBody.length < 10) return json({ error: "bad_request", detail: "Add a short message before sending." }, 400);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // Household daily outreach cap (protects sending domain reputation)
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const { count: sentToday, error: capErr } = await admin.from("vendor_messages")
      .select("id", { count: "exact", head: true })
      .eq("household_id", me.household_id).eq("direction", "outbound").gte("created_at", since);
    if (capErr) return json({ error: "db_error", detail: capErr.message }, 500);
    if ((sentToday ?? 0) >= DAILY_HOUSEHOLD_CAP) {
      return json({ error: "daily_cap", detail: `Reached the daily limit of ${DAILY_HOUSEHOLD_CAP} vendor emails. Try again tomorrow.` }, 429);
    }

    // Reuse existing thread if provided & belongs to this household+task, else create a new one
    let threadId: string | null = isUuid(body.threadId) ? body.threadId : existing?.id || null;
    let replyToken = "";
    let prevMessageId: string | null = null;

    if (threadId) {
      const { data: thRow, error: thErr } = await admin.from("vendor_threads")
        .select("id, household_id, task_id, reply_token, last_message_id")
        .eq("id", threadId).maybeSingle();
      if (thErr) return json({ error: "db_error", detail: thErr.message }, 500);
      if (thRow && thRow.household_id === me.household_id && thRow.task_id === task.id) {
        replyToken = thRow.reply_token;
        prevMessageId = thRow.last_message_id || null;
      } else {
        threadId = null;
      }
    }

    if (!threadId) {
      replyToken = randomToken(18);
      const { data: created, error: cErr } = await admin.from("vendor_threads").insert({
        household_id: me.household_id,
        task_id: task.id,
        option_id: optionId,
        vendor_name: opt.vendor || "Vendor",
        vendor_email: toEmail,
        reply_token: replyToken,
        kind,
        status: "sent",
        subject,
        created_by: user.id,
      }).select("id").single();
      if (cErr || !created) return json({ error: "db_error", detail: cErr?.message || "could not create thread" }, 500);
      threadId = created.id;
    }

    // Reply-To: automated inbound address (e.g. jeeves+<token>@ourampersand.app) if configured, else caller's own email
    let replyTo: string | null = null;
    let replyMode: "inbound" | "direct" = "direct";
    if (inboundDomain) {
      replyTo = `${inboundUser}+${replyToken}@${inboundDomain}`;
      replyMode = "inbound";
    } else {
      const { data: au } = await admin.auth.admin.getUserById(user.id);
      if (au?.user?.email && isEmail(au.user.email)) replyTo = au.user.email;
    }

    const payload: Record<string, unknown> = {
      from: fromAddr,
      to: [toEmail],
      subject,
      text: emailBody,
      html: renderVendorHtml(emailBody),
    };
    if (replyTo) payload.reply_to = replyTo;
    if (prevMessageId) {
      const refId = prevMessageId.startsWith("<") ? prevMessageId : `<${prevMessageId}>`;
      payload.headers = { "In-Reply-To": refId, "References": refId };
    }

    let r: Response;
    try {
      r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: "send_failed", detail: `Resend unreachable: ${String((e as Error).message || e).slice(0, 300)}` }, 502);
    }
    if (!r.ok) {
      const detail = `Resend ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`;
      return json({ error: "send_failed", detail }, 502);
    }
    const resJson = await r.json().catch(() => ({}));
    const resendId = typeof resJson?.id === "string" ? resJson.id : null;

    await admin.from("vendor_threads").update({
      vendor_email: toEmail,
      kind,
      status: "sent",
      subject,
      last_message_id: resendId || prevMessageId,
      updated_at: new Date().toISOString(),
    }).eq("id", threadId);

    const { error: msgErr } = await admin.from("vendor_messages").insert({
      thread_id: threadId,
      household_id: me.household_id,
      direction: "outbound",
      from_addr: fromAddr,
      to_addr: toEmail,
      subject,
      body_text: emailBody,
      message_id: resendId,
    });

    // Save discovered/verified vendorEmail onto the option & log on the task (with caller session!)
    const updatedOpts = options.map((o) => o && o.id === optionId ? { ...o, vendorEmail: toEmail } : o);
    const logText = kind === "confirm"
      ? `${me.display_name} emailed ${opt.vendor || toEmail} to confirm the booking.`
      : `${me.display_name} emailed ${opt.vendor || toEmail} to request a quote.`;
    await sb.from("tasks").update({ options: updatedOpts, log: addLog(task.log, logText) }).eq("id", task.id);

    return json({ ok: true, threadId, messageId: resendId, replyMode, logged: !msgErr });
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error).message || e).slice(0, 300) }, 500);
  }
});
