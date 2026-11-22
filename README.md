# Ampersand

A shared to-do list for two people. Say things loosely, an agent sorts them into projects and finds real options, and nothing gets booked until both of you say yes to the exact same terms.

Live: https://ampersand-home.vercel.app

## How it fits together

| Part | Where | What it does |
|---|---|---|
| App | `index.html` | The whole front end, one static file. Talks to Supabase directly from the browser. |
| Database | `supabase/migrations/` | Households of two, tasks, per-person approvals, private lists, row-level security, and the booking check. |
| Agent | `supabase/functions/agent/` | Edge function that calls Claude to sort spoken to-dos into tasks and to research options with live web search. |

Hosting: Vercel serves `index.html` as a static site. Supabase project: `ampersand` (`dmtgdhjcpjiqcrwfqscl`).

## The booking rule

A "yes" is bound to a hash of the option's exact terms: vendor, date, start, end, all-in total and what's included (`termsHash()` in `index.html`, `public.terms_hash()` in SQL; keep them identical).

`public.book_task()` runs on the server. It books only when every member has a current yes on the same option and the live terms still match. If anything differs (Saturday is gone, the price went from $150 to $220), it does not book: it records what changed, replaces the option with the new terms and clears both yeses. A trigger stops the app from marking anything booked on its own.

Until real vendor connections exist, the "live" answer is simulated by the `p_scenario` argument (`hold`, `nextday`, `price`).

## Privacy

- Tasks, approvals and members are visible only to the two people in a household.
- Each person can only write their own approvals.
- `private_items` are readable only by the person who wrote them, and the agent never queries that table.

## Settings that live outside this repo

- Supabase → Authentication → URL Configuration: Site URL and Redirect URLs set to the live address.
- Supabase → Edge Functions → Secrets: `ANTHROPIC_API_KEY`. Never commit it.

The Supabase key in `index.html` is the public anon key, which is meant to be in browser code; row-level security is what protects the data.

## Deploying changes

- App: push to `main`; Vercel redeploys.
- Database: apply new files in `supabase/migrations/` (Supabase CLI: `supabase db push`).
- Agent: `supabase functions deploy agent`.

## Tests

`sh tests/run-agent-tests.sh` runs the agent function against a fake database and a fake Claude API. It covers a successful search, a Claude API failure, database read and write failures, unusable options, and the no-key case. Needs Node 20+.
