-- Calendars: each person can connect a Google and/or an Outlook calendar, for conflict checks and for
-- adding bookings to their calendar. Safe to run twice. Touches households (one new column) and three new tables;
-- tasks, members and their policies are unchanged.

-- The household's time zone (IANA name, such as America/Chicago). The app sets it from the browser when it is null.
-- households_update already lets members update their own household, so this needs no new policy.
alter table public.households add column if not exists timezone text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'households_timezone_check' and conrelid = 'public.households'::regclass) then
    alter table public.households add constraint households_timezone_check
      check (timezone is null or timezone ~ '^[A-Za-z0-9_+/-]{1,64}$');
  end if;
end $$;

-- One row per person and provider. Tokens are encrypted by the edge functions (AES-GCM, "iv.ciphertext" in base64)
-- with a key the database never sees. Read and written only by the calendar, calendar-callback and agent
-- edge functions with the service role; the browser never sees a token.
create table if not exists public.calendar_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  account_email text,
  refresh_token_enc text not null,
  access_token_enc text,
  access_expires_at timestamptz,
  check_conflicts boolean not null default true,
  add_bookings boolean not null default true,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error text,
  primary key (user_id, provider)
);

-- Which bookings were already added to whose calendar, so adding is idempotent.
create table if not exists public.calendar_events (
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  event_id text not null,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id, provider)
);

-- A connection waiting for its owner to confirm it. The callback can't know who is in the browser that
-- finishes the provider's consent screen, so it parks the encrypted tokens here under a random key k and sends
-- the browser back with k. The calendar function's `finish` action, called with the person's own session,
-- moves the row to calendar_connections only if they are the same person who started connecting.
-- Without this, someone could start connecting for their own account and get their partner (or anyone) to open
-- the consent link, attaching that person's calendar to their own account. Rows expire after 10 minutes.
create table if not exists public.calendar_pending (
  k text primary key,
  uid uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  refresh_token_enc text not null,
  access_token_enc text,
  access_expires_at timestamptz,
  account_email text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

-- Row-level security on with no policies: signed-in users and anon can do nothing here.
-- The service role bypasses RLS. The revoke is a second lock in case a policy is ever added by mistake.
-- None of these tables has a serial column, so there are no sequences to revoke.
alter table public.calendar_connections enable row level security;
alter table public.calendar_events enable row level security;
alter table public.calendar_pending enable row level security;
revoke all on table public.calendar_connections from anon, authenticated;
revoke all on table public.calendar_events from anon, authenticated;
revoke all on table public.calendar_pending from anon, authenticated;

-- Indexes for these tables are in 20261124000001_ampersand_calendar_indexes.sql (built concurrently, so applied on their own).
