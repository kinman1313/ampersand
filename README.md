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

The palette is Dark Jungle Green `#1F271B` (the background), Blue Sapphire `#19647E`, Light Sea Green `#28AFB0`, Stil De Grain Yellow `#F4D35E` and Big Foot Feet `#EE964B`, as CSS variables at the top of `index.html`. Sea green and orange are the two people; yellow is the primary action and "you both agreed". Settings > Appearance offers a Light variant built from the same colours.

The old address `ampersand-home.vercel.app` forwards to `https://www.ourampersand.app` (same path, query and sign-in tokens) from a short script at the top of the page.

## Security headers

`vercel.json` sends a Content-Security-Policy (scripts only from this site and the pinned supabase-js file, connections only to this Supabase project, no framing), plus `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and a permissions policy that allows only the microphone (voice input). supabase-js is also pinned with a Subresource Integrity hash. If you add a script, font or API host, add it to the policy, or the browser will block it. The policy keeps `'unsafe-inline'` because the app's code is inline in `index.html`.

## Deploying changes

- App: push to `main`; Vercel redeploys.
- Database: apply new files in `supabase/migrations/` (Supabase CLI: `supabase db push`).
- Agent: `supabase functions deploy agent`.
- Nudges: apply `20261123000000_ampersand_notify.sql`, then `20261123000001_ampersand_notify_indexes.sql` on its own (it builds indexes concurrently), set the secrets above, then `supabase functions deploy notify`.

## Tests

`sh tests/run-agent-tests.sh` runs the agent function against a fake database and a fake Claude API. It covers a successful search, a Claude API failure, database read and write failures, unusable options, and the no-key case. Needs Node 20+.

`sh tests/run-notify-tests.sh` runs the notify function against a fake database, fake auth and a fake Resend API: sending, the agreed case, stale or missing yeses, no partner, opted out, throttling, the daily cap, email not configured, Resend failures, a failed log write, database errors, bad input, HTML escaping and the status check.

Both suites: `sh tests/run-agent-tests.sh && sh tests/run-notify-tests.sh`
