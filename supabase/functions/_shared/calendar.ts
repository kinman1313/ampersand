// Shared calendar code for the calendar, calendar-callback and agent edge functions:
// Google and Microsoft clients, token encryption, signed OAuth state, time zone maths and householdBusy.
// It has no imports: callers pass in their own Supabase client, so the tests can bundle it as is.
// Privacy: only free/busy intervals are read. Event titles and details are never requested.
// Errors carry short fixed codes, never text from a provider.

export type Provider = "google" | "microsoft";
export const PROVIDERS: Provider[] = ["google", "microsoft"];
export const isProvider = (p: unknown): p is Provider => p === "google" || p === "microsoft";

export class CalError extends Error {
  code: string; status: number; detail?: string;
  constructor(code: string, status = 0, detail?: string) {
    super(code); this.code = code; this.status = status; this.detail = detail;
  }
}
const codeOf = (e: unknown) => (e instanceof CalError ? e.code : "server_error");

const env = (k: string) => Deno.env.get(k) || "";
const te = new TextEncoder();
const td = new TextDecoder();

// deno-lint-ignore no-explicit-any
type Admin = any;

/* ===================== Configuration ===================== */

function keyBytes(): Uint8Array | null {
  const raw = env("CALENDAR_TOKEN_KEY").trim();
  if (!raw) return null;
  try {
    const b = b64decode(raw);
    return b.length >= 32 ? b : null;
  } catch { return null; }
}

// A provider is configured only when its client id and secret and a usable CALENDAR_TOKEN_KEY are set.
export function providerConfigured(p: Provider): boolean {
  const pre = p === "google" ? "GOOGLE" : "MS";
  return !!(env(`${pre}_CLIENT_ID`) && env(`${pre}_CLIENT_SECRET`) && keyBytes());
}

export function redirectUri(): string {
  return env("CALENDAR_REDIRECT_URI") || `${env("SUPABASE_URL").replace(/\/+$/, "")}/functions/v1/calendar-callback`;
}

// Where the browser may be sent back to: a page on APP_URL's origin, or http(s)://localhost or 127.0.0.1
// for local work. Anything else falls back to APP_URL. Returns null only if nothing is allowed.
export function safeReturnTo(given: unknown): string | null {
  const app = env("APP_URL");
  let appOrigin: string | null = null;
  try { if (app) appOrigin = new URL(app).origin; } catch { /* unusable APP_URL */ }
  if (typeof given === "string" && given.length <= 500) {
    try {
      const u = new URL(given);
      const plain = (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (plain && (local || (appOrigin && u.origin === appOrigin))) return u.toString();
    } catch { /* not a URL */ }
  }
  return appOrigin ? new URL(app).toString() : null;
}

/* ===================== Encoding and crypto ===================== */

function b64encode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64url = (b: Uint8Array) => b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(p + "===".slice((p.length + 3) % 4));
}

// Two separate keys derived from CALENDAR_TOKEN_KEY with HKDF: one encrypts tokens, one signs OAuth state.
let keyCache: { raw: string; enc: CryptoKey; mac: CryptoKey } | null = null;
async function keys() {
  const bytes = keyBytes();
  if (!bytes) throw new CalError("not_configured");
  const raw = env("CALENDAR_TOKEN_KEY");
  if (keyCache && keyCache.raw === raw) return keyCache;
  const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  const salt = te.encode("ampersand-calendar");
  const enc = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("token-encryption-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const mac = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("oauth-state-v1") },
    base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
  keyCache = { raw, enc, mac };
  return keyCache;
}

// AES-GCM with a random 96-bit IV. The ciphertext is bound to its row (user and provider) as associated data,
// so a token copied into another row does not decrypt.
export async function encryptToken(plain: string, aad: string): Promise<string> {
  const { enc } = await keys();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, enc, te.encode(plain)));
  return `${b64encode(iv)}.${b64encode(ct)}`;
}
export async function decryptToken(stored: string, aad: string): Promise<string> {
  const { enc } = await keys();
  try {
    const [iv, ct] = String(stored).split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv), additionalData: te.encode(aad) }, enc, b64decode(ct));
    return td.decode(pt);
  } catch {
    throw new CalError("decrypt_failed");
  }
}
export const aadFor = (userId: string, provider: string) => `${userId}:${provider}`;

// Pending connections (see calendar_pending): a random 32-byte key, and the associated data their tokens are
// encrypted with, which includes that key, so a pending token can't be moved into another row and decrypted.
export const newPendingKey = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const isPendingKey = (k: unknown): k is string => typeof k === "string" && /^[A-Za-z0-9_-]{43}$/.test(k);
export const pendingAad = (k: string, uid: string, provider: string) => `pending:${k}:${uid}:${provider}`;
export const PENDING_TTL_MS = 10 * 60 * 1000;

export type State = { uid: string; provider: string; returnTo: string; nonce: string; exp: number };
export const STATE_TTL_MS = 10 * 60 * 1000;

export async function signState(s: Omit<State, "nonce" | "exp">, now = Date.now()): Promise<string> {
  const { mac } = await keys();
  const full: State = { ...s, nonce: b64url(crypto.getRandomValues(new Uint8Array(16))), exp: now + STATE_TTL_MS };
  const body = b64url(te.encode(JSON.stringify(full)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", mac, te.encode(body)));
  return `${body}.${b64url(sig)}`;
}

// ok: signature valid and not expired. expired: signature valid but too old (the returnTo inside is still ours).
export async function verifyState(token: unknown, now = Date.now()):
  Promise<{ ok: true; state: State } | { ok: false; reason: "bad_state" | "expired"; state?: State }> {
  if (typeof token !== "string" || token.length > 2048) return { ok: false, reason: "bad_state" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "bad_state" };
  const { mac } = await keys();
  let state: State;
  try {
    const good = await crypto.subtle.verify("HMAC", mac, b64urlDecode(parts[1]), te.encode(parts[0]));
    if (!good) return { ok: false, reason: "bad_state" };
    state = JSON.parse(td.decode(b64urlDecode(parts[0])));
  } catch {
    return { ok: false, reason: "bad_state" };
  }
  if (!state || typeof state !== "object" || typeof state.uid !== "string" || typeof state.provider !== "string" ||
      typeof state.returnTo !== "string" || typeof state.exp !== "number") return { ok: false, reason: "bad_state" };
  if (state.exp < now) return { ok: false, reason: "expired", state };
  return { ok: true, state };
}

/* ===================== Dates, times and time zones ===================== */

const DAY_MS = 24 * 60 * 60 * 1000;

export function isDay(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1970 || y > 2200) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
export const isTime = (s: unknown): s is string => typeof s === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);

export function isTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !/^[A-Za-z0-9_+/-]{1,64}$/.test(tz)) return false;
  try { fmt(tz); return true; } catch { return false; }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// The wall clock in tz at instant t, as if that wall clock were UTC (milliseconds).
function wallAsUtc(t: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
}
// UTC offset of tz at instant t, in milliseconds (local minus UTC).
const offsetAt = (t: number, tz: string) => wallAsUtc(t, tz) - Math.floor(t / 1000) * 1000;

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);

// Local date and time in an IANA zone to a UTC instant (ms), with the same rules as Temporal's "compatible":
// - a time that happens twice (clocks go back) is the earlier one;
// - a time that never happens (clocks go forward) moves forward by the gap (02:30 becomes 03:30).
// The true offset is one of the offsets in force a day either side of the naive guess.
export function zonedToUtc(day: string, time: string, tz: string): number {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const before = offsetAt(guess - DAY_MS, tz);
  const after = offsetAt(guess + DAY_MS, tz);
  const hits = [...new Set([before, after])].map((o) => guess - o).filter((t) => wallAsUtc(t, tz) === guess);
  if (hits.length) return Math.min(...hits);
  return guess - before; // in the gap: use the offset from before the change
}

export function utcToLocal(t: number, tz: string): { date: string; time: string } {
  const iso = new Date(wallAsUtc(t, tz)).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

// RFC 3339 local time with its offset, such as 2026-03-08T09:00:00-05:00.
export function rfc3339Local(t: number, tz: string): string {
  const off = Math.round(offsetAt(t, tz) / 60000);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  const local = new Date(wallAsUtc(t, tz)).toISOString().slice(0, 19);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// UTC interval of a date with start and end times. An end at or before the start is taken as the next day.
export function localInterval(o: { date?: unknown; start?: unknown; end?: unknown }, tz: string): [number, number] | null {
  if (!isDay(o.date) || !isTime(o.start) || !isTime(o.end)) return null;
  const s = zonedToUtc(o.date, o.start, tz);
  const toMin = (x: string) => { const [h, m] = x.split(":").map(Number); return h * 60 + m; };
  const endDay = toMin(o.end) <= toMin(o.start) ? addDays(o.date, 1) : o.date;
  return [s, zonedToUtc(endDay, o.end, tz)];
}

export type Busy = { start: string; end: string };
export const overlapsAny = (iv: [number, number], busy: Busy[]) =>
  busy.some((b) => iv[0] < Date.parse(b.end) && iv[1] > Date.parse(b.start));

// Merge overlapping or touching intervals (ms pairs), clipped to [from, to].
function mergeIntervals(list: [number, number][], from: number, to: number): Busy[] {
  const xs = list
    .map(([s, e]) => [Math.max(s, from), Math.min(e, to)] as [number, number])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const iv of xs) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() }));
}

// Busy windows as short local-time lines for a prompt, people merged (the agent doesn't need to know whose).
export function busyLines(busy: Busy[], tz: string, max = 60): string[] {
  const all = mergeIntervals(busy.map((b) => [Date.parse(b.start), Date.parse(b.end)]), -Infinity, Infinity);
  return all.slice(0, max).map((b) => {
    const s = utcToLocal(Date.parse(b.start), tz), e = utcToLocal(Date.parse(b.end), tz);
    return s.date === e.date ? `${s.date} ${s.time}-${e.time}` : `${s.date} ${s.time} to ${e.date} ${e.time}`;
  });
}

/* ===================== Provider clients ===================== */

const TIMEOUT_MS = 10000;
async function call(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new CalError("provider_unreachable");
  }
}
// deno-lint-ignore no-explicit-any
async function readJson(r: Response): Promise<any> {
  try { return await r.json(); } catch { return null; }
}
// A provider answered with an error: 401 means the access token is no good (worth one refresh and retry).
function providerFail(r: Response): never {
  throw new CalError(r.status === 401 ? "unauthorized" : "provider_error", r.status);
}

export type Tokens = { access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope?: string };
export type NewEvent = { title: string; description: string; startLocal: string; endLocal: string; startRfc: string; endRfc: string; tz: string };

const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.events"];
const MS_SCOPES = ["openid", "email", "offline_access", "User.Read", "Calendars.ReadWrite"];
const TOKEN_URL: Record<Provider, string> = {
  google: "https://oauth2.googleapis.com/token",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
};

async function tokenRequest(p: Provider, form: Record<string, string>): Promise<Tokens> {
  const r = await call(TOKEN_URL[p], {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const j = await readJson(r);
  if (!r.ok || !j || typeof j.access_token !== "string") {
    const e = j && typeof j.error === "string" ? j.error : "";
    // Revoked, expired or no longer consented: the person has to connect again.
    if (["invalid_grant", "interaction_required", "consent_required"].includes(e)) throw new CalError("reconnect", r.status);
    throw new CalError("token_failed", r.status);
  }
  const exp = Number(j.expires_in);
  return {
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : undefined,
    expires_in: Number.isFinite(exp) && exp > 0 ? exp : 3600,
    id_token: typeof j.id_token === "string" ? j.id_token : undefined,
    scope: typeof j.scope === "string" ? j.scope : undefined,
  };
}

// The email claim of an id_token we received directly from the provider's token endpoint over TLS.
function idTokenEmail(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(td.decode(b64urlDecode(idToken.split(".")[1] || "")));
    return typeof claims.email === "string" && claims.email.length <= 320 ? claims.email : null;
  } catch { return null; }
}

export type Client = {
  authUrl(state: string): string;
  exchange(code: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  hasScopes(t: Tokens): boolean;
  email(t: Tokens): Promise<string | null>;
  busy(access: string, fromISO: string, toISO: string): Promise<[number, number][]>;
  createEvent(access: string, ev: NewEvent): Promise<string>;
  revoke(refreshToken: string): Promise<boolean>;
};

const google: Client = {
  authUrl(state) {
    const q = new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },
  exchange(code) {
    return tokenRequest("google", {
      code, client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri(), grant_type: "authorization_code",
    });
  },
  refresh(rt) {
    return tokenRequest("google", {
      refresh_token: rt, client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), grant_type: "refresh_token",
    });
  },
  // Google lets people untick scopes on the consent screen; both calendar scopes are needed.
  hasScopes(t) {
    const s = (t.scope || "").split(/\s+/);
    return s.includes(GOOGLE_SCOPES[2]) && s.includes(GOOGLE_SCOPES[3]);
  },
  async email(t) {
    const fromId = idTokenEmail(t.id_token);
    if (fromId) return fromId;
    const r = await call("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } });
    const j = r.ok ? await readJson(r) : null;
    return j && typeof j.email === "string" ? j.email.slice(0, 320) : null;
  },
  async busy(access, fromISO, toISO) {
    const r = await call("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: fromISO, timeMax: toISO, items: [{ id: "primary" }] }),
    });
    if (!r.ok) providerFail(r);
    const j = await readJson(r);
    const cal = j?.calendars?.primary;
    if (!cal || (Array.isArray(cal.errors) && cal.errors.length) || !Array.isArray(cal.busy)) throw new CalError("provider_error", r.status);
    return cal.busy.map((b: { start?: string; end?: string }) => [Date.parse(String(b.start)), Date.parse(String(b.end))] as [number, number]);
  },
  async createEvent(access, ev) {
    const r = await call("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: ev.title, description: ev.description,
        start: { dateTime: ev.startRfc, timeZone: ev.tz }, end: { dateTime: ev.endRfc, timeZone: ev.tz },
      }),
    });
    if (!r.ok) providerFail(r);
    const j = await readJson(r);
    if (!j || typeof j.id !== "string") throw new CalError("provider_error", r.status);
    return j.id;
  },
  async revoke(rt) {
    try {
      const r = await call("https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: rt }).toString(),
      });
      return r.ok;
    } catch { return false; }
  },
};

const GRAPH = "https://graph.microsoft.com/v1.0";
const microsoft: Client = {
  authUrl(state) {
    const q = new URLSearchParams({
      client_id: env("MS_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code", response_mode: "query",
      scope: MS_SCOPES.join(" "), prompt: "select_account", state,
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${q}`;
  },
  exchange(code) {
    return tokenRequest("microsoft", {
      code, client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"),
      redirect_uri: redirectUri(), grant_type: "authorization_code", scope: MS_SCOPES.join(" "),
    });
  },
  refresh(rt) {
    return tokenRequest("microsoft", {
      refresh_token: rt, client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"),
      grant_type: "refresh_token", scope: MS_SCOPES.join(" "),
    });
  },
  // Microsoft reports granted scopes as names or full URLs, such as https://graph.microsoft.com/Calendars.ReadWrite.
  hasScopes(t) {
    if (!t.scope) return true; // older responses can omit it; the first calendar call will tell
    return t.scope.toLowerCase().split(/\s+/).some((s) => s.endsWith("calendars.readwrite"));
  },
  async email(t) {
    const r = await call(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    const j = r.ok ? await readJson(r) : null;
    const e = j && (typeof j.mail === "string" && j.mail ? j.mail : typeof j.userPrincipalName === "string" ? j.userPrincipalName : null);
    return e ? e.slice(0, 320) : idTokenEmail(t.id_token);
  },
  async busy(access, fromISO, toISO) {
    const out: [number, number][] = [];
    let url: string | null = `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(fromISO)}&endDateTime=${encodeURIComponent(toISO)}` +
      `&$select=start,end,showAs,isCancelled&$top=250`;
    for (let page = 0; url; page++) {
      if (page >= 40) throw new CalError("provider_error"); // runaway paging
      const r = await call(url, { headers: { Authorization: `Bearer ${access}`, Prefer: 'outlook.timezone="UTC"' } });
      if (!r.ok) providerFail(r);
      const j = await readJson(r);
      if (!j || !Array.isArray(j.value)) throw new CalError("provider_error", r.status);
      for (const ev of j.value) {
        if (!ev || ev.showAs === "free" || ev.isCancelled === true) continue;
        out.push([graphTime(ev.start), graphTime(ev.end)]);
      }
      const next = j["@odata.nextLink"];
      // Only follow links back to Graph, so the token is never sent anywhere else.
      url = typeof next === "string" && next.startsWith(`${GRAPH}/`) ? next : null;
    }
    return out;
  },
  async createEvent(access, ev) {
    const r = await call(`${GRAPH}/me/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: ev.title, body: { contentType: "text", content: ev.description },
        start: { dateTime: ev.startLocal, timeZone: ev.tz }, end: { dateTime: ev.endLocal, timeZone: ev.tz },
      }),
    });
    if (!r.ok) providerFail(r);
    const j = await readJson(r);
    if (!j || typeof j.id !== "string") throw new CalError("provider_error", r.status);
    return j.id;
  },
  // Microsoft has no endpoint to revoke one app's refresh token (only "sign out everywhere"), so this is a no-op.
  // Deleting the row discards the token; people can remove the app's access at account.microsoft.com or myapps.microsoft.com.
  revoke() { return Promise.resolve(false); },
};

export const clients: Record<Provider, Client> = { google, microsoft };

// Graph dateTime is local time without an offset, such as 2026-11-28T15:00:00.0000000, in the zone we asked for (UTC).
function graphTime(x: { dateTime?: string; timeZone?: string } | undefined): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?/.exec(String(x?.dateTime || ""));
  if (!m) return NaN;
  const tz = x?.timeZone;
  if (tz && tz !== "UTC" && isTz(tz)) return zonedToUtc(m[1], m[2], tz) + (m[3] ? Number(m[3].slice(1)) * 1000 : 0);
  return Date.parse(`${m[1]}T${m[2]}${m[3] || ":00"}Z`);
}

/* ===================== Stored connections ===================== */

export type Conn = {
  user_id: string; provider: Provider; refresh_token_enc: string;
  access_token_enc?: string | null; access_expires_at?: string | null;
};
export const CONN_COLUMNS = "user_id, provider, refresh_token_enc, access_token_enc, access_expires_at";

// A usable access token for a connection: the cached one if it has a minute or more left, else a refreshed one
// (stored encrypted). On a revoked grant, marks the row last_error='reconnect' and throws CalError('reconnect').
export async function accessToken(admin: Admin, c: Conn, force = false): Promise<string> {
  const aad = aadFor(c.user_id, c.provider);
  if (!force && c.access_token_enc && c.access_expires_at && Date.parse(c.access_expires_at) > Date.now() + 60000) {
    try { return await decryptToken(c.access_token_enc, aad); } catch { /* refresh instead */ }
  }
  const rt = await decryptToken(c.refresh_token_enc, aad);
  let t: Tokens;
  try {
    t = await clients[c.provider].refresh(rt);
  } catch (e) {
    if (codeOf(e) === "reconnect") {
      // If this write fails the next check simply hits the same answer again.
      await admin.from("calendar_connections").update({ last_error: "reconnect", access_token_enc: null, access_expires_at: null, updated_at: new Date().toISOString() })
        .eq("user_id", c.user_id).eq("provider", c.provider);
    }
    throw e;
  }
  const patch: Record<string, unknown> = {
    access_token_enc: await encryptToken(t.access_token, aad),
    access_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    last_error: null, updated_at: new Date().toISOString(),
  };
  // Microsoft (and sometimes Google) rotates refresh tokens: keep the new one.
  if (t.refresh_token && t.refresh_token !== rt) patch.refresh_token_enc = await encryptToken(t.refresh_token, aad);
  const { error } = await admin.from("calendar_connections").update(patch).eq("user_id", c.user_id).eq("provider", c.provider);
  // The new access token works even if caching it failed. A rotated refresh token that failed to save is a real
  // problem though (the old one may stop working), so say so.
  if (error && patch.refresh_token_enc) throw new CalError("db_error", 0, error.message);
  c.access_token_enc = patch.access_token_enc as string;
  c.access_expires_at = patch.access_expires_at as string;
  if (patch.refresh_token_enc) c.refresh_token_enc = patch.refresh_token_enc as string;
  return t.access_token;
}

// Run fn with an access token; if the provider says 401, refresh once and try again.
export async function withAccess<T>(admin: Admin, c: Conn, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await accessToken(admin, c));
  } catch (e) {
    if (codeOf(e) !== "unauthorized") throw e;
    return await fn(await accessToken(admin, c, true));
  }
}

export type HouseholdBusy = {
  busy: { start: string; end: string; user_id: string }[];
  checked: Record<string, boolean>;
  errors: { user_id: string; provider: string; error: string }[];
};

// Busy intervals for every current member of a household, from each connection with check_conflicts on.
// Needs a service-role client (calendar_connections is closed to signed-in users). Merged per person, clipped
// to the range, in UTC. A failing connection is reported in errors and does not stop the others.
// Throws CalError('db_error') only if the database can't be read.
export async function householdBusy(admin: Admin, householdId: string, fromISO: string, toISO: string): Promise<HouseholdBusy> {
  const from = Date.parse(fromISO), to = Date.parse(toISO);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new CalError("bad_range");
  const out: HouseholdBusy = { busy: [], checked: {}, errors: [] };
  const { data: members, error: mErr } = await admin.from("members").select("user_id").eq("household_id", householdId);
  if (mErr) throw new CalError("db_error", 0, mErr.message);
  const ids: string[] = (members || []).map((m: { user_id: string }) => m.user_id);
  for (const id of ids) out.checked[id] = false;
  if (!ids.length) return out;
  // Only current members: a row left behind by someone who moved households is ignored.
  const { data: conns, error: cErr } = await admin.from("calendar_connections").select(CONN_COLUMNS)
    .in("user_id", ids).eq("household_id", householdId).eq("check_conflicts", true);
  if (cErr) throw new CalError("db_error", 0, cErr.message);
  const raw: Record<string, [number, number][]> = {};
  await Promise.all((conns || []).map(async (c: Conn) => {
    if (!isProvider(c.provider)) return;
    if (!providerConfigured(c.provider)) { out.errors.push({ user_id: c.user_id, provider: c.provider, error: "not_configured" }); return; }
    try {
      const list = await withAccess(admin, c, (tok) => clients[c.provider].busy(tok, fromISO, toISO));
      (raw[c.user_id] ||= []).push(...list);
      out.checked[c.user_id] = true;
    } catch (e) {
      out.errors.push({ user_id: c.user_id, provider: c.provider, error: codeOf(e) });
    }
  }));
  for (const id of ids) {
    for (const b of mergeIntervals(raw[id] || [], from, to)) out.busy.push({ ...b, user_id: id });
  }
  out.busy.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

export { codeOf };
