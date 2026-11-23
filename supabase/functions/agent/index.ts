// Ampersand agent: sorts spoken to-dos into tasks and researches options.
// Runs with the caller's session, so row-level security decides what it can read and write.
// It never touches private_items. Research also reads both people's free/busy times, which needs the
// service role (calendar_connections is closed to signed-in users); that client is made only for that.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { addDays, busyLines, daysBetween, householdBusy, isTz, localInterval, overlapsAny, zonedToUtc, type Busy } from "../_shared/calendar.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PARSE_MODEL = "claude-haiku-5-5";
const RESEARCH_MODEL = "claude-sonnet-5-5";
const PROJECTS = ["home", "money", "kids", "weekend", "us"];

type Msg = { text: string };

async function callClaude(key: string, model: string, prompt: string, maxTokens: number, webSearch: boolean): Promise<Msg> {
  const payload: Record<string, unknown> = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (webSearch) payload.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  const send = () =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  let r = await send();
  if (!r.ok && webSearch && r.status === 400) {
    delete payload.tools; // fall back to no live search rather than failing
    r = await send();
  }
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = (j.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  return { text };
}

function extractJSON(text: string): Record<string, unknown> | null {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  for (let i = text.indexOf("{"); i >= 0 && i < end; i = text.indexOf("{", i + 1)) {
    try { return JSON.parse(text.slice(i, end + 1)); } catch { /* keep looking */ }
  }
  return null;
}

const isDay = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isTime = (s: unknown) => typeof s === "string" && /^\d{1,2}:\d{2}$/.test(s);
const rid = () => "o" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

function addLog(log: unknown, text: string) {
  const arr = Array.isArray(log) ? log : [];
  return [...arr, { at: Date.now(), who: "agent", text }].slice(-40);
}

const CALENDAR_TIMEOUT_MS = 12000;
const CALENDAR_MAX_DAYS = 62;

// Both people's busy times from today to the deadline (or 30 days out), for research. Returns null when
// calendars aren't set up or nobody's calendar could be checked. Never throws: a calendar problem must not
// stop research, it just means research goes ahead without the check.
// deno-lint-ignore no-explicit-any
async function researchBusy(sb: any, householdId: string, today: string, due: unknown, clientTz: unknown):
  Promise<{ busy: Busy[]; tz: string } | null> {
  try {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey || !Deno.env.get("CALENDAR_TOKEN_KEY")) return null;
    const { data: hh, error } = await sb.from("households").select("timezone").eq("id", householdId).maybeSingle();
    const tz = !error && isTz(hh?.timezone) ? hh!.timezone : isTz(clientTz) ? clientTz : "UTC";
    let end = typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due) && due >= today ? due : addDays(today, 30);
    if (daysBetween(today, end) + 1 > CALENDAR_MAX_DAYS) end = addDays(today, CALENDAR_MAX_DAYS - 1);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    // The catch matters: if the timeout wins, a later rejection must not go unhandled.
    const work = householdBusy(admin, householdId, new Date(zonedToUtc(today, "00:00", tz)).toISOString(),
      new Date(zonedToUtc(addDays(end, 1), "00:00", tz)).toISOString()).catch(() => null);
    let timer: number | undefined;
    const timeout = new Promise<null>((res) => { timer = setTimeout(() => res(null), CALENDAR_TIMEOUT_MS); });
    const hb = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
    if (!hb || !Object.values(hb.checked).some(Boolean)) return null;
    return { busy: hb.busy.map((b) => ({ start: b.start, end: b.end })), tz };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "not_signed_in" }, 401);

    const body = await req.json().catch(() => ({}));
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (body.action === "status") return json({ configured: !!key });
    if (!key) return json({ error: "agent_not_configured" }, 503);

    const { data: me, error: meErr } = await sb.from("members").select("household_id, display_name").eq("user_id", user.id).maybeSingle();
    if (meErr) return json({ error: "db_error", detail: meErr.message }, 500);
    if (!me) return json({ error: "no_household" }, 400);
    const { data: members, error: memErr } = await sb.from("members").select("user_id, display_name").eq("household_id", me.household_id);
    if (memErr) return json({ error: "db_error", detail: memErr.message }, 500);
    const { data: hh, error: hhErr } = await sb.from("households").select("home_base").eq("id", me.household_id).single();
    if (hhErr) return json({ error: "db_error", detail: hhErr.message }, 500);
    const partner = (members || []).find((m) => m.user_id !== user.id);
    const homeBase = hh?.home_base || "Allen, TX";
    const today = isDay(body.today) ? body.today : new Date().toISOString().slice(0, 10);
    const todayLine = `Today is ${body.weekday || ""} ${today}.`;

    /* ---------- parse ---------- */
    if (body.action === "parse") {
      const text = String(body.text || "").slice(0, 2000);
      if (!text.trim()) return json({ tasks: [] });
      const names = [me.display_name, partner?.display_name].filter(Boolean).join(" and ");
      const prompt = `You sort a couple's loosely spoken to-dos into tasks for their shared household app. The couple: ${names}. The speaker is ${me.display_name}. ${todayLine} Home base: ${homeBase}.
Projects: home (house, repairs, yard, chores, errands), money (bills, insurance, taxes, registrations, budgets), kids (school, doctors, dentists, activities), weekend (outings, trips, plans with friends or family), us (the two of them: dates, gifts, anniversaries).
Split the input into separate tasks. For each task give:
- title: short imperative, under 60 characters, keeping their specifics
- project: one of home, money, kids, weekend, us
- assignee: "both", or the first name of one person if the input clearly gives it to them. "I" or "me" means ${me.display_name}.
- due: YYYY-MM-DD inferred from phrases like "before thanksgiving", "next saturday", "end of the month", "by dec 15", or null if nothing implies a date
- dueReason: a few words explaining the date, or null
- research: true when an agent could usefully find options, quotes or bookings (services, restaurants, providers, products, events); false for chores they will just do
- budgetCents: integer cents if they mention a budget or limit, else null
Respond with JSON only: {"tasks":[{"title":"","project":"","assignee":"both","due":null,"dueReason":null,"research":false,"budgetCents":null}]}
Input: """${text.replace(/"""/g, '"')}"""`;
      const out = extractJSON((await callClaude(key, PARSE_MODEL, prompt, 1200, false)).text);
      const list = Array.isArray(out?.tasks) ? (out!.tasks as Record<string, unknown>[]) : [];
      const byName = (n: unknown) => (members || []).find((m) => typeof n === "string" && m.display_name.toLowerCase() === n.toLowerCase().trim());
      const tasks = list.slice(0, 8).map((p) => ({
        title: String(p.title || "").trim().slice(0, 120),
        project: PROJECTS.includes(String(p.project)) ? String(p.project) : "us",
        assignee: byName(p.assignee)?.user_id ?? null,
        due: isDay(p.due) ? p.due : null,
        due_reason: p.dueReason ? String(p.dueReason).slice(0, 60) : null,
        research: !!p.research,
        budget_cents: Number.isFinite(Number(p.budgetCents)) && Number(p.budgetCents) > 0 ? Math.round(Number(p.budgetCents)) : null,
      })).filter((t) => t.title);
      return json({ tasks });
    }

    /* ---------- research ---------- */
    if (body.action === "research") {
      const { data: t, error: tErr } = await sb.from("tasks").select("*").eq("id", body.taskId).maybeSingle();
      if (tErr) return json({ error: "db_error", detail: tErr.message }, 500);
      if (!t) return json({ error: "task_not_found" }, 404);
      const log1 = addLog(t.log, "Started researching options.");
      const { error: startErr } = await sb.from("tasks").update({ status: "researching", research_at: new Date().toISOString(), log: log1 }).eq("id", t.id);
      if (startErr) return json({ error: "db_error", detail: startErr.message }, 500);
      const cal = await researchBusy(sb, me.household_id, today, t.due, body.tz);
      const calLines = cal ? busyLines(cal.busy, cal.tz) : [];
      const calendarLine = !cal ? "" : calLines.length
        ? `\nTheir calendars show these busy times (local time, ${cal.tz}). Avoid these times; both people must be free: ${calLines.join("; ")}.`
        : `\nTheir calendars show no busy times before the deadline.`;
      try {
        const prompt = `You are the research agent in a couple's shared household app. Find exactly 3 concrete options for this task so each of them can say yes to one. ${todayLine} Home base: ${homeBase}.
Task: "${t.title}". Project: ${t.project}. ${t.due ? `Needed by ${t.due} (${t.due_reason || "their deadline"}).` : "No deadline given."} ${t.budget_cents ? `Budget: under $${(t.budget_cents / 100).toFixed(2)} all-in.` : ""}
Use web search to find real providers near ${homeBase} and their published prices where available. Only name a business you actually found; include the page you found it on as "url". If a price isn't published, estimate it and set "priceIsEstimate": true. Never invent phone numbers or addresses.
Each option needs exact terms the couple will approve: a specific date after today and on or before the deadline (YYYY-MM-DD), a start and end time (HH:MM, 24-hour; for a purchase, the delivery window), and an all-in total in cents including tax, fees and tip.${calendarLine}
Finish with JSON only, no prose after it: {"note":"one plain sentence for the couple","options":[{"vendor":"","title":"","detail":"one sentence on why this one","date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","totalCents":0,"includes":"short list","url":"https://...","priceIsEstimate":true}]}`;
        const out = extractJSON((await callClaude(key, RESEARCH_MODEL, prompt, 4000, true)).text);
        const raw = Array.isArray(out?.options) ? (out!.options as Record<string, unknown>[]) : [];
        const options = raw.slice(0, 3).map((o) => {
          let cents = Math.round(Number(o.totalCents));
          if (Number.isFinite(cents) && cents > 0 && cents < 500) cents *= 100;
          const url = typeof o.url === "string" && /^https:\/\/[^\s]+$/.test(o.url) ? o.url.slice(0, 400) : null;
          return {
            id: rid(), vendor: String(o.vendor || "Local provider").slice(0, 90), title: String(o.title || "").slice(0, 100),
            detail: String(o.detail || "").slice(0, 240), date: String(o.date || ""), start: String(o.start || ""), end: String(o.end || ""),
            totalCents: cents, includes: String(o.includes || "").slice(0, 140), url, priceIsEstimate: o.priceIsEstimate !== false, source: "agent",
          };
        }).filter((o) => o.title && isDay(o.date) && o.date > today && isTime(o.start) && isTime(o.end) && Number.isFinite(o.totalCents) && o.totalCents > 0);
        if (!options.length) throw new Error("no usable options");
        // Drop options that clash with either person's calendar. If every one clashes, keep them and say so.
        let conflict = false;
        let kept: (typeof options[number] & { conflict?: boolean })[] = options;
        if (cal && cal.busy.length) {
          const clashes = (o: typeof options[number]) => { const iv = localInterval(o, cal.tz); return !!iv && overlapsAny(iv, cal.busy); };
          const free = options.filter((o) => !clashes(o));
          if (free.length) kept = free;
          else { conflict = true; kept = options.map((o) => ({ ...o, conflict: true })); }
        }
        const baseNote = String(out?.note || "Here are three options. Prices are checked again before anything is booked.").slice(0, 300);
        const { error: saveErr } = await sb.from("tasks").update({
          status: "open", options: kept, research: false,
          agent_note: conflict ? `${baseNote.slice(0, 220)} Heads up: every option clashes with one of your calendars.` : baseNote,
          log: addLog(log1, `Found ${kept.length} options. Each of you can say yes to one.`),
        }).eq("id", t.id);
        if (saveErr) throw new Error(`could not save options: ${saveErr.message}`);
        return json(conflict ? { ok: true, count: kept.length, conflict: true } : { ok: true, count: kept.length });
      } catch (e) {
        const { error: resetErr } = await sb.from("tasks").update({ status: "open", agent_note: "The agent couldn't finish this one. Try again in a minute.", log: addLog(log1, "Research stopped before finishing.") }).eq("id", t.id);
        const detail = String((e as Error).message || e).slice(0, 300) + (resetErr ? ` (also could not reset the task: ${resetErr.message}; the app treats it as open after 4 minutes)` : "");
        return json({ error: "research_failed", detail }, 502);
      }
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error).message || e).slice(0, 300) }, 500);
  }
});
