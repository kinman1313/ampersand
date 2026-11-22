-- Ampersand: households of two, shared tasks, per-person approvals, private lists,
-- and a server-side booking check that only books on the exact terms both people approved.

-- ===== Tables =====
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our home',
  home_base text not null default 'Allen, TX',
  invite_code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  color text not null check (color in ('blue', 'orange')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id),
  unique (user_id),
  unique (household_id, color)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  project text not null default 'us' check (project in ('home', 'money', 'kids', 'weekend', 'us')),
  assignee uuid references auth.users(id) on delete set null,
  due date,
  due_reason text,
  budget_cents bigint,
  research boolean not null default false,
  status text not null default 'open' check (status in ('open', 'researching', 'booked', 'done')),
  prev_status text,
  options jsonb not null default '[]'::jsonb,
  agent_note text,
  voided jsonb,
  booking jsonb,
  research_at timestamptz,
  done_at timestamptz,
  log jsonb not null default '[]'::jsonb,
  example boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.approvals (
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  household_id uuid not null references public.households(id) on delete cascade,
  yes_option_id text,
  yes_hash text,
  passed text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

create table public.private_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title text not null check (char_length(title) between 1 and 300),
  done boolean not null default false,
  created_at timestamptz not null default now()
);

-- ===== Helpers =====
create or replace function public.my_household() returns uuid
language sql stable security definer set search_path = '' as $$
  select household_id from public.members where user_id = auth.uid() limit 1
$$;

-- The exact terms a "yes" is bound to. Must match termsHash() in index.html.
create or replace function public.terms_hash(o jsonb) returns text
language sql immutable set search_path = '' as $$
  select concat_ws('|',
    coalesce(o->>'vendor', ''), coalesce(o->>'date', ''), coalesce(o->>'start', ''),
    coalesce(o->>'end', ''), coalesce(o->>'totalCents', ''), coalesce(o->>'includes', ''))
$$;

create or replace function public.log_entry(p_log jsonb, p_who text, p_text text) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(p_log, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'at', (extract(epoch from now()) * 1000)::bigint, 'who', p_who, 'text', p_text))
$$;

-- ===== Row-level security =====
alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.tasks enable row level security;
alter table public.approvals enable row level security;
alter table public.private_items enable row level security;

create policy households_select on public.households for select to authenticated
  using (id = (select public.my_household()));
create policy households_update on public.households for update to authenticated
  using (id = (select public.my_household())) with check (id = (select public.my_household()));

create policy members_select on public.members for select to authenticated
  using (household_id = (select public.my_household()));
create policy members_update_self on public.members for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and household_id = (select public.my_household()));

create policy tasks_select on public.tasks for select to authenticated
  using (household_id = (select public.my_household()));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (household_id = (select public.my_household()));
create policy tasks_update on public.tasks for update to authenticated
  using (household_id = (select public.my_household())) with check (household_id = (select public.my_household()));
create policy tasks_delete on public.tasks for delete to authenticated
  using (household_id = (select public.my_household()));

create policy approvals_select on public.approvals for select to authenticated
  using (household_id = (select public.my_household()));
create policy approvals_insert on public.approvals for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and household_id = (select public.my_household())
    and exists (select 1 from public.tasks t where t.id = task_id and t.household_id = (select public.my_household()))
  );
create policy approvals_update on public.approvals for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and household_id = (select public.my_household()));
create policy approvals_delete on public.approvals for delete to authenticated
  using (user_id = (select auth.uid()));

-- Private items: only the person who wrote them. Not their partner, and the agent never reads this table.
create policy private_select on public.private_items for select to authenticated using (user_id = (select auth.uid()));
create policy private_insert on public.private_items for insert to authenticated with check (user_id = (select auth.uid()));
create policy private_update on public.private_items for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy private_delete on public.private_items for delete to authenticated using (user_id = (select auth.uid()));

-- ===== Guard: only the server-side booking check can book or void =====
create or replace function public.guard_task() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('amp.trusted', true), '') = 'on' then
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'booked' or new.booking is not null or new.voided is not null then
      raise exception 'Only the booking check can mark a task booked';
    end if;
    return new;
  end if;
  if new.household_id <> old.household_id then raise exception 'Tasks cannot move between households'; end if;
  if new.booking is distinct from old.booking then raise exception 'Only the booking check can change a booking'; end if;
  if new.status = 'booked' and old.booking is null then raise exception 'Only the booking check can mark a task booked'; end if;
  if new.voided is not null and new.voided is distinct from old.voided then raise exception 'Only the booking check can void approvals'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger guard_task before insert or update on public.tasks
  for each row execute function public.guard_task();

-- ===== Household setup =====
create or replace function public.create_household(p_display text, p_color text default 'blue', p_name text default 'Our home')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare h public.households%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'You are already in a household'; end if;
  if coalesce(trim(p_display), '') = '' then raise exception 'Add your name'; end if;
  if p_color not in ('blue', 'orange') then p_color := 'blue'; end if;
  insert into public.households (name, created_by) values (coalesce(nullif(trim(p_name), ''), 'Our home'), auth.uid()) returning * into h;
  insert into public.members (household_id, user_id, display_name, color) values (h.id, auth.uid(), left(trim(p_display), 40), p_color);
  return jsonb_build_object('id', h.id, 'invite_code', h.invite_code);
end $$;

create or replace function public.join_household(p_code text, p_display text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare h public.households%rowtype; n int; c text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'You are already in a household'; end if;
  if coalesce(trim(p_display), '') = '' then raise exception 'Add your name'; end if;
  select * into h from public.households where invite_code = upper(trim(p_code));
  if not found then raise exception 'That invite code did not match a household'; end if;
  select count(*) into n from public.members where household_id = h.id;
  if n >= 2 then raise exception 'That household already has two people'; end if;
  c := case when exists (select 1 from public.members where household_id = h.id and color = 'blue') then 'orange' else 'blue' end;
  insert into public.members (household_id, user_id, display_name, color) values (h.id, auth.uid(), left(trim(p_display), 40), c);
  return jsonb_build_object('id', h.id);
end $$;

-- ===== The booking check =====
-- Books only if every member has a current "yes" on the same option and the live terms still match those exact terms.
-- p_scenario simulates the vendor's live answer until real vendor integrations exist: 'hold' | 'nextday' | 'price'.
create or replace function public.book_task(p_task uuid, p_scenario text default 'hold')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  hh uuid := public.my_household();
  t public.tasks%rowtype;
  n_members int;
  opt jsonb;
  live jsonb;
  diffs jsonb;
  tot bigint;
  new_id text;
  who text := auth.uid()::text;
begin
  if hh is null then raise exception 'You are not in a household'; end if;
  select * into t from public.tasks where id = p_task and household_id = hh for update;
  if not found then raise exception 'Task not found'; end if;
  if t.status in ('booked', 'done') then raise exception 'This task is already %', t.status; end if;

  select count(*) into n_members from public.members where household_id = hh;
  if n_members < 2 then raise exception 'Both of you need to join before anything can be booked'; end if;

  select o into opt
  from jsonb_array_elements(t.options) o
  where (
    select count(*) from public.members m
    join public.approvals a on a.user_id = m.user_id and a.task_id = t.id
    where m.household_id = hh and a.yes_option_id = o->>'id' and a.yes_hash = public.terms_hash(o)
  ) = n_members
  limit 1;
  if opt is null then raise exception 'You both need to say yes to the same option, on its current terms, before booking'; end if;

  -- Live quote (simulated)
  live := opt;
  if p_scenario = 'nextday' then
    live := jsonb_set(live, '{date}', to_jsonb(to_char((opt->>'date')::date + 1, 'YYYY-MM-DD')));
  elsif p_scenario = 'price' then
    tot := (opt->>'totalCents')::bigint;
    live := jsonb_set(live, '{totalCents}', to_jsonb(tot + greatest(2000, (round(tot * 0.47 / 1000.0) * 1000)::bigint)));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('field', f, 'was', opt->f, 'now', live->f)), '[]'::jsonb) into diffs
  from unnest(array['vendor', 'date', 'start', 'end', 'totalCents', 'includes']) f
  where (opt->f) is distinct from (live->f);

  perform set_config('amp.trusted', 'on', true);

  if jsonb_array_length(diffs) = 0 then
    update public.tasks set
      status = 'booked',
      voided = null,
      booking = jsonb_build_object(
        'optionId', opt->>'id', 'hash', public.terms_hash(opt),
        'confirmation', 'AMP-' || upper(substr(md5(gen_random_uuid()::text), 1, 5)),
        'capCents', (opt->>'totalCents')::bigint, 'vendor', opt->>'vendor',
        'date', opt->>'date', 'start', opt->>'start', 'end', opt->>'end',
        'at', (extract(epoch from now()) * 1000)::bigint, 'by', who),
      log = public.log_entry(t.log, 'agent', 'Re-checked the live terms: they matched what you both approved. Booked, with payment capped at the approved total.')
    where id = t.id;
    perform set_config('amp.trusted', '', true);
    return jsonb_build_object('booked', true);
  end if;

  new_id := 'o' || substr(md5(gen_random_uuid()::text), 1, 8);
  live := live || jsonb_build_object('id', new_id, 'requoted', true,
    'was', jsonb_build_object('date', opt->>'date', 'start', opt->>'start', 'end', opt->>'end', 'totalCents', opt->'totalCents'));

  update public.tasks set
    status = 'open',
    options = (select jsonb_agg(case when x.o->>'id' = opt->>'id' then live else x.o end order by x.ord)
               from jsonb_array_elements(t.options) with ordinality as x(o, ord)),
    voided = jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint, 'vendor', opt->>'vendor', 'diffs', diffs, 'by', who),
    log = public.log_entry(t.log, 'agent', 'Did not book: the live terms no longer matched what you both approved. Both yeses were cleared.')
  where id = t.id;

  update public.approvals set yes_option_id = null, yes_hash = null, updated_at = now() where task_id = t.id;
  perform set_config('amp.trusted', '', true);
  return jsonb_build_object('booked', false, 'diffs', diffs);
end $$;

revoke execute on function public.create_household(text, text, text) from public, anon;
revoke execute on function public.join_household(text, text) from public, anon;
revoke execute on function public.book_task(uuid, text) from public, anon;
revoke execute on function public.my_household() from public, anon;
grant execute on function public.create_household(text, text, text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;
grant execute on function public.book_task(uuid, text) to authenticated;
grant execute on function public.my_household() to authenticated;

-- ===== Realtime =====
alter table public.tasks replica identity full;
alter table public.approvals replica identity full;
alter table public.members replica identity full;
alter table public.private_items replica identity full;
alter publication supabase_realtime add table public.tasks, public.approvals, public.members, public.private_items;
