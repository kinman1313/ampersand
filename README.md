# Ampersand

A shared to-do list for two people. Say things loosely, an agent sorts them into projects and finds real options, and nothing gets booked until both of you say yes to the exact same terms.

Live: https://www.ourampersand.app

## How it fits together

| Part | Where | What it does |
|---|---|---|
| App | `index.html` | The whole front end, one static file. Talks to Supabase directly from the browser. |
| Database | `supabase/migrations/` | Households of two, tasks, per-person approvals, private lists, row-level security, and the booking check. |
| Agent | `supabase/functions/agent/` | Edge function that calls Claude to sort spoken to-dos into tasks and to research options with live web search. |
| Nudges | `supabase/functions/notify/` | Edge function that emails your partner (through Resend) when you said yes to an option or the agent found options. Throttled to one per task and kind every 6 hours, and 20 a day per person. Each person can turn them off (`members.notify_email`). |
| Outreach | `supabase/functions/outreach/`, `outreach-inbound/` | Drafts and sends quote requests or agreed booking confirmations to suggested vendors (through Resend), and optionally parses vendor email replies into Verified Quotes or booking confirmations while enforcing `public.terms_hash()`. |
| Calendars | `supabase/functions/calendar/`, `calendar-callback/`, `_shared/calendar.ts` | Each person can connect a Google and/or Outlook calendar. Research avoids times either of you is busy, and a booking is added to the calendar of each person who opted in. Only free/busy times cross between partners; event details are never read. Tokens are encrypted at rest and never reach the browser. |

Hosting: Vercel serves `index.html` as a static site. Supabase project: `ampersand` (`dmtgdhjcpjiqcrwfqscl`).

## The booking rule

A "yes" is bound to a hash of the option's exact terms: vendor, date, start, end, all-in total and what's included (`termsHash()` in `index.html`, `public.terms_hash()` in SQL; keep them identical).

`public.book_task()` runs on the server. It books only when every member has a current yes on the same option and the live terms still match. If anything differs (Saturday is gone, the price went from $150 to $220), it does not book: it records what changed, replaces the option with the new terms and clears both yeses. A trigger stops the app from marking anything booked on its own.

Until real vendor connections exist, the "live" answer is simulated by the `p_scenario` argument (`hold`, `nextday`, `price`).

## Privacy

- Tasks, approvals and members are visible only to the two people in a household.
- Each person can only write their own approvals.
- `private_items` are readable only by the person who wrote them, and the agent never queries that table.
- The notify function reads tasks, approvals and members with the caller's session. It uses the service role only to look up the partner's email address and to read and write `notify_log`, which no signed-in user can read. Emails never include private items.

## Calendars

Only free/busy intervals are read; titles and details of events are never requested or stored. Refresh tokens are encrypted (AES-GCM) with `CALENDAR_TOKEN_KEY` and live in `calendar_connections`, which only the edge functions (service role) can read. Connecting is two steps: the provider sends the browser to `calendar-callback`, which parks the encrypted tokens in `calendar_pending` for 10 minutes and returns to the app with `?calendar=pending&k=…`; the app then calls `calendar` → `finish`, which connects the calendar only if the signed-in person is the one who started. That stops anyone attaching someone else's calendar to their own account.

Redirect URI for both providers: `https://dmtgdhjcpjiqcrwfqscl.supabase.co/functions/v1/calendar-callback`

**Google** (console.cloud.google.com):
1. Create a project (top bar → project picker → New project).
2. APIs & Services → Library → Google Calendar API → Enable.
3. APIs & Services → OAuth consent screen (Google Auth Platform): User type **External**; app name, support email, developer email. Leave publishing status on **Testing**.
4. Audience → Test users → add both people's Google addresses. (In Testing mode only these accounts can connect, and Google expires their consent after 7 days; publish the app, which needs Google's verification for calendar scopes, to avoid reconnecting weekly.)
5. Data access → Add or remove scopes → add `openid`, `.../auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.freebusy` and `https://www.googleapis.com/auth/calendar.events`.
6. Credentials (Clients) → Create credentials → OAuth client ID → Application type **Web application** → Authorized redirect URIs → add the redirect URI above → Create. Copy the client ID and secret.

**Microsoft** (entra.microsoft.com):
1. Identity → Applications → App registrations → New registration. Name: Ampersand. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
2. Redirect URI: platform **Web**, the redirect URI above → Register. Copy the Application (client) ID.
3. Certificates & secrets → Client secrets → New client secret. Copy the **Value** now (it is shown once) and note its expiry date: connections stop refreshing when it expires.
4. API permissions → Add a permission → Microsoft Graph → Delegated permissions: `Calendars.ReadWrite`, `User.Read`, `offline_access`, `openid`, `email` → Add permissions.

**Secrets** (Supabase → Edge Functions → Secrets): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `APP_URL` (`https://www.ourampersand.app`; the app is only ever sent back to this site or localhost), and `CALENDAR_TOKEN_KEY` from `openssl rand -base64 32`. Changing or losing `CALENDAR_TOKEN_KEY` means everyone has to connect again. A provider shows as available only when its ID, secret and the key are all set.

**Deploy**:
```
supabase db push        # applies 20261124000000_ampersand_calendar.sql; apply ..._000001_ampersand_calendar_indexes.sql on its own (concurrent indexes)
supabase functions deploy calendar
supabase functions deploy calendar-callback --no-verify-jwt
supabase functions deploy agent
```
`calendar-callback` has no Supabase session (the browser arrives from Google or Microsoft); it trusts only the HMAC-signed state and answers with a redirect carrying a short fixed code, never provider text.

## Settings that live outside this repo

- Supabase → Authentication → URL Configuration: Site URL `https://www.ourampersand.app`; Redirect URLs listed exactly (`https://www.ourampersand.app/`, plus `http://localhost:<port>/` for local work). No wildcards such as `*.vercel.app`: the app sends `location.origin` as the redirect, so the allow-list is what keeps sign-in tokens on your own site.
- Supabase → Authentication → Sign In / Providers → Email: Confirm email on, Secure password change on, minimum password length 8 (the app enforces 8 too, and 72 bytes at most).
- Supabase → Authentication → Emails → SMTP Settings: custom SMTP through Resend (`smtp.resend.com`, port 465, user `resend`, password = a Resend API key, sender on `ourampersand.app`). Supabase's built-in email only reaches project team members and is limited to a few per hour, so confirmation and reset emails need this.
- Supabase → Authentication → Attack Protection: leaked-password protection on, if your plan has it.
- Supabase → Edge Functions → Secrets: `ANTHROPIC_API_KEY`. Never commit it.
- Supabase → Edge Functions → Secrets, for nudge emails: `RESEND_API_KEY` (from Resend) and `NOTIFY_FROM`, such as `Ampersand <nudges@yourdomain>`, on a domain verified in Resend. Optional: `APP_URL`, the link used when the app doesn't send its own address. Without the first two, nudges are skipped (`email_not_configured`) and nothing fails. `SUPABASE_SERVICE_ROLE_KEY` is provided to edge functions by Supabase.

The Supabase key in `index.html` is the public anon key, which is meant to be in browser code; row-level security is what protects the data.

## Sign-in

People can create an account with email and password, sign in with it, reset a forgotten password from an emailed link, and set or change it in Settings (changing it signs out other devices). The one-time email link still works as an alternative.

## Look

The palette blends Dark Jungle Green with deep emerald (`#111E18` / `#1D332A`), paired with Blue Sapphire `#19647E`, Light Sea Green `#28AFB0`, Stil De Grain Yellow `#F4D35E` and Warm Amber `#EE964B`, as CSS variables at the top of `index.html`. Sea green (circle) and warm amber (rounded square) are the two people; blue sapphire owns Private ("Just mine") mode; gold is reserved for hero capture, "you both agreed", and booking. Settings > Appearance offers a Light variant (*Sunlit linen*) built from the same colours.

The old address `ampersand-home.vercel.app` forwards to `https://www.ourampersand.app` (same path, query and sign-in tokens) from a short script at the top of the page.

## Security headers

`vercel.json` sends a Content-Security-Policy (scripts only from this site and the pinned supabase-js file, connections only to this Supabase project, no framing), plus `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and a permissions policy that allows only the microphone (voice input). supabase-js is also pinned with a Subresource Integrity hash. If you add a script, font or API host, add it to the policy, or the browser will block it. The policy keeps `'unsafe-inline'` because the app's code is inline in `index.html`.

## Deploying changes

- App: push to `main`; Vercel redeploys.
- Database: apply new files in `supabase/migrations/` (Supabase CLI: `supabase db push --remote`, or paste into Supabase SQL Editor).
- Agent: `supabase functions deploy agent`.
- Outreach: apply `20261126000000_ampersand_outreach.sql`, then `supabase functions deploy outreach` and `supabase functions deploy outreach-inbound --no-verify-jwt`. Reuses `RESEND_API_KEY`, `NOTIFY_FROM` (or `OUTREACH_FROM`), and `ANTHROPIC_API_KEY`. Works immediately with replies going to your own inbox; to capture vendor replies automatically inside Ampersand, add an inbound MX subdomain (e.g. `inbound.ourampersand.app`) pointing to Resend Receiving or a Cloudflare Email Worker webhook (`https://dmtgdhjcpjiqcrwfqscl.supabase.co/functions/v1/outreach-inbound`) and set `OUTREACH_INBOUND_DOMAIN` + `OUTREACH_WEBHOOK_SECRET` in Supabase Edge Function Secrets.
- Calendars: see [Calendars](#calendars).
- Nudges: apply `20261123000000_ampersand_notify.sql`, then `20261123000001_ampersand_notify_indexes.sql` on its own (it builds indexes concurrently), set the secrets above, then `supabase functions deploy notify`.

## Tests

`sh tests/run-agent-tests.sh` runs the agent function against a fake database and a fake Claude API. It covers a successful search, a Claude API failure, database read and write failures, unusable options, and the no-key case. Needs Node 20+.

`sh tests/run-notify-tests.sh` runs the notify function against a fake database, fake auth and a fake Resend API: sending, the agreed case, stale or missing yeses, no partner, opted out, throttling, the daily cap, email not configured, Resend failures, a failed log write, database errors, bad input, HTML escaping and the status check.

`sh tests/run-calendar-tests.sh` runs the calendar and calendar-callback functions, the agent's calendar check and `_shared/calendar.ts` against a fake database and fake Google, Microsoft and Claude APIs: status (no partner email), connect, the callback and `finish` (including someone else finishing, expiry and replay), busy merging and parsing, token refresh and revocation, add_event idempotency and partial failure, time zone maths across DST changes, encryption and state tampering.

`sh tests/run-outreach-tests.sh` runs the outreach and outreach-inbound functions against a fake database, fake Claude API and fake Resend API: quote/confirm drafting, address privacy boundaries, email validation, thread reuse (`In-Reply-To`), daily household caps, Svix webhook signature & replay verification, Resend inbound fetching, deduplication, and `apply_vendor_reply` RPC calls.

All suites: `sh tests/run-agent-tests.sh && sh tests/run-notify-tests.sh && sh tests/run-calendar-tests.sh && sh tests/run-outreach-tests.sh`
