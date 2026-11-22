-- Partner nudges: an email to the other person when one of you needs them to come back.
-- Safe to run twice. Touches members and a new table only; tasks and its guard_task trigger are unchanged.

-- Each person can turn nudge emails off. members_update_self already lets a member update
-- any column of their own row (it is a row policy with no column list), so this needs no new policy.
alter table public.members add column if not exists notify_email boolean not null default true;

-- What was sent, for throttling. Written and read only by the notify edge function with the service role.
create table if not exists public.notify_log (
  id bigserial primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  recipient uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  kind text not null check (kind in ('yes', 'agreed', 'options')),
  sent_at timestamptz not null default now()
);

-- Row-level security on with no policies: signed-in users and anon can do nothing here.
-- The service role bypasses RLS. The revoke is a second lock in case a policy is ever added by mistake.
alter table public.notify_log enable row level security;
revoke all on table public.notify_log from anon, authenticated;
revoke all on sequence public.notify_log_id_seq from anon, authenticated;

-- Indexes for this table are in 20261123000001_ampersand_notify_indexes.sql (built concurrently, so applied on their own).
