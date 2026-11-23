-- Email vendor outreach: draft and send quote requests or booking confirmations to suggested vendors,
-- track replies in threaded conversations, and update task options while enforcing public.terms_hash().
-- Safe to run twice (idempotent).

-- Optional household contact info used ONLY when confirming an agreed booking (never in quote requests).
alter table public.households add column if not exists contact_phone text;
alter table public.households add column if not exists service_address text;

-- One thread per (task, option, vendor) outreach conversation.
create table if not exists public.vendor_threads (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  option_id text not null,
  vendor_name text not null,
  vendor_email text not null,
  reply_token text not null unique,
  kind text not null default 'quote' check (kind in ('quote', 'confirm')),
  status text not null default 'sent' check (status in ('sent', 'replied', 'quoted', 'confirmed', 'declined')),
  subject text not null default '',
  last_message_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_threads_household_task_idx on public.vendor_threads (household_id, task_id);
create index if not exists vendor_threads_reply_token_idx on public.vendor_threads (reply_token);

-- Individual outbound and inbound emails in a vendor thread.
create table if not exists public.vendor_messages (
  id bigserial primary key,
  thread_id uuid not null references public.vendor_threads(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  direction text not null check (direction in ('outbound', 'inbound')),
  from_addr text not null,
  to_addr text not null,
  subject text not null default '',
  body_text text not null,
  message_id text,
  parsed jsonb,
  created_at timestamptz not null default now()
);

create index if not exists vendor_messages_thread_idx on public.vendor_messages (thread_id, created_at);
create index if not exists vendor_messages_household_dir_idx on public.vendor_messages (household_id, direction, created_at desc);
create unique index if not exists vendor_messages_thread_msgid_uniq on public.vendor_messages (thread_id, message_id) where message_id is not null;

-- RLS: household members can read their own threads and messages; only Edge Functions (service role) write.
alter table public.vendor_threads enable row level security;
alter table public.vendor_messages enable row level security;

drop policy if exists vendor_threads_select on public.vendor_threads;
create policy vendor_threads_select on public.vendor_threads for select to authenticated
  using (household_id = (select public.my_household()));

drop policy if exists vendor_messages_select on public.vendor_messages;
create policy vendor_messages_select on public.vendor_messages for select to authenticated
  using (household_id = (select public.my_household()));

revoke insert, update, delete on table public.vendor_threads from anon, authenticated;
revoke insert, update, delete on table public.vendor_messages from anon, authenticated;
revoke all on sequence public.vendor_messages_id_seq from anon, authenticated;

-- Enable live updates for both partners when a vendor replies or an email is sent.
do $$
begin
  alter publication supabase_realtime add table public.vendor_threads;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.vendor_messages;
exception when duplicate_object then null;
end $$;

-- Server-only RPC called by outreach-inbound after verifying webhook signature and parsing a vendor's reply.
-- Enforces Ampersand's exact-terms rule (public.terms_hash) and guard_task trigger safely.
create or replace function public.apply_vendor_reply(
  p_thread_id uuid,
  p_outcome text,
  p_quote jsonb default '{}'::jsonb,
  p_summary text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  th public.vendor_threads%rowtype;
  t public.tasks%rowtype;
  opt jsonb;
  live jsonb;
  diffs jsonb := '[]'::jsonb;
  n_members int;
  agreed_count int := 0;
  any_yes int := 0;
  new_id text;
  summary text := left(coalesce(trim(p_summary), ''), 240);
  clean_outcome text := case when p_outcome in ('quoted', 'confirmed', 'declined', 'info') then p_outcome else 'info' end;
begin
  select * into th from public.vendor_threads where id = p_thread_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'thread_not_found'); end if;

  select * into t from public.tasks where id = th.task_id and household_id = th.household_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'task_not_found'); end if;

  -- Locate the option tied to this thread
  select o into opt
  from jsonb_array_elements(coalesce(t.options, '[]'::jsonb)) o
  where o->>'id' = th.option_id
  limit 1;

  if opt is null then
    update public.vendor_threads set status = case when clean_outcome = 'declined' then 'declined' else 'replied' end, updated_at = now() where id = th.id;
    update public.tasks set log = public.log_entry(t.log, 'agent', th.vendor_name || ' replied: ' || coalesce(nullif(summary, ''), 'see email thread.')) where id = t.id;
    return jsonb_build_object('ok', true, 'applied', 'logged_only');
  end if;

  -- Build merged live terms from any valid fields extracted from the vendor reply
  live := opt;
  if p_quote is not null and jsonb_typeof(p_quote) = 'object' then
    if (p_quote->>'date') ~ '^\d{4}-\d{2}-\d{2}$' then
      live := jsonb_set(live, '{date}', to_jsonb(p_quote->>'date'));
    end if;
    if (p_quote->>'start') ~ '^\d{1,2}:\d{2}$' then
      live := jsonb_set(live, '{start}', to_jsonb(p_quote->>'start'));
    end if;
    if (p_quote->>'end') ~ '^\d{1,2}:\d{2}$' then
      live := jsonb_set(live, '{end}', to_jsonb(p_quote->>'end'));
    end if;
    if (p_quote->>'totalCents') ~ '^\d+$' and (p_quote->>'totalCents')::bigint > 0 then
      live := jsonb_set(live, '{totalCents}', to_jsonb((p_quote->>'totalCents')::bigint));
    end if;
    if coalesce(trim(p_quote->>'includes'), '') <> '' then
      live := jsonb_set(live, '{includes}', to_jsonb(left(trim(p_quote->>'includes'), 140)));
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('field', f, 'was', opt->f, 'now', live->f)), '[]'::jsonb) into diffs
  from unnest(array['vendor', 'date', 'start', 'end', 'totalCents', 'includes']) f
  where (opt->f) is distinct from (live->f);

  select count(*) into n_members from public.members where household_id = th.household_id;
  select count(*) into any_yes from public.approvals where task_id = t.id and yes_option_id = opt->>'id';
  select count(*) into agreed_count
  from public.members m
  join public.approvals a on a.user_id = m.user_id and a.task_id = t.id
  where m.household_id = th.household_id and a.yes_option_id = opt->>'id' and a.yes_hash = public.terms_hash(opt);

  -- Case 1: Vendor confirmed an agreed booking
  if clean_outcome = 'confirmed' and th.kind = 'confirm' and t.status not in ('booked', 'done') then
    if n_members >= 2 and agreed_count = n_members and jsonb_array_length(diffs) = 0 then
      perform set_config('amp.trusted', 'on', true);
      update public.tasks set
        status = 'booked',
        voided = null,
        booking = jsonb_build_object(
          'optionId', opt->>'id', 'hash', public.terms_hash(opt),
          'confirmation', 'EMAIL-' || upper(substr(md5(gen_random_uuid()::text), 1, 5)),
          'capCents', (opt->>'totalCents')::bigint, 'vendor', opt->>'vendor',
          'date', opt->>'date', 'start', opt->>'start', 'end', opt->>'end',
          'via', 'email', 'threadId', th.id,
          'at', (extract(epoch from now()) * 1000)::bigint, 'by', 'vendor'),
        log = public.log_entry(t.log, 'agent', th.vendor_name || ' confirmed by email on the exact approved terms.')
      where id = t.id;
      perform set_config('amp.trusted', '', true);
      update public.vendor_threads set status = 'confirmed', updated_at = now() where id = th.id;
      return jsonb_build_object('ok', true, 'applied', 'booked');
    elsif jsonb_array_length(diffs) > 0 then
      -- Vendor confirmed/countered with changed terms: void existing yeses and show diff
      new_id := 'o' || substr(md5(gen_random_uuid()::text), 1, 8);
      live := live || jsonb_build_object('id', new_id, 'priceIsEstimate', false, 'verifiedQuote', true, 'requoted', true,
        'was', jsonb_build_object('date', opt->>'date', 'start', opt->>'start', 'end', opt->>'end', 'totalCents', opt->'totalCents'));
      perform set_config('amp.trusted', 'on', true);
      update public.tasks set
        status = 'open',
        options = (select jsonb_agg(case when x.o->>'id' = opt->>'id' then live else x.o end order by x.ord)
                   from jsonb_array_elements(t.options) with ordinality as x(o, ord)),
        voided = jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint, 'vendor', opt->>'vendor', 'diffs', diffs, 'by', 'vendor'),
        log = public.log_entry(t.log, 'agent', th.vendor_name || ' replied with different terms — both yeses were cleared.')
      where id = t.id;
      update public.approvals set yes_option_id = null, yes_hash = null, updated_at = now() where task_id = t.id;
      perform set_config('amp.trusted', '', true);
      update public.vendor_threads set option_id = new_id, status = 'quoted', updated_at = now() where id = th.id;
      return jsonb_build_object('ok', true, 'applied', 'voided_drift', 'diffs', diffs);
    end if;
  end if;

  -- Case 2: Vendor replied with a verified quote (or updated terms)
  if clean_outcome = 'quoted' and t.status not in ('booked', 'done') then
    if jsonb_array_length(diffs) > 0 and any_yes > 0 then
      new_id := 'o' || substr(md5(gen_random_uuid()::text), 1, 8);
      live := live || jsonb_build_object('id', new_id, 'priceIsEstimate', false, 'verifiedQuote', true, 'requoted', true,
        'was', jsonb_build_object('date', opt->>'date', 'start', opt->>'start', 'end', opt->>'end', 'totalCents', opt->'totalCents'));
      perform set_config('amp.trusted', 'on', true);
      update public.tasks set
        status = 'open',
        options = (select jsonb_agg(case when x.o->>'id' = opt->>'id' then live else x.o end order by x.ord)
                   from jsonb_array_elements(t.options) with ordinality as x(o, ord)),
        voided = jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint, 'vendor', opt->>'vendor', 'diffs', diffs, 'by', 'vendor'),
        log = public.log_entry(t.log, 'agent', th.vendor_name || ' sent a verified quote with updated terms: ' || coalesce(nullif(summary, ''), 'review the updated option.'))
      where id = t.id;
      update public.approvals set yes_option_id = null, yes_hash = null, updated_at = now() where task_id = t.id;
      perform set_config('amp.trusted', '', true);
      update public.vendor_threads set option_id = new_id, status = 'quoted', updated_at = now() where id = th.id;
      return jsonb_build_object('ok', true, 'applied', 'quoted_changed', 'diffs', diffs);
    else
      live := live || jsonb_build_object('priceIsEstimate', false, 'verifiedQuote', true);
      if summary <> '' then live := live || jsonb_build_object('quoteNote', summary); end if;
      update public.tasks set
        options = (select jsonb_agg(case when x.o->>'id' = opt->>'id' then live else x.o end order by x.ord)
                   from jsonb_array_elements(t.options) with ordinality as x(o, ord)),
        log = public.log_entry(t.log, 'agent', th.vendor_name || ' sent a verified quote: ' || coalesce(nullif(summary, ''), 'see email thread.'))
      where id = t.id;
      update public.vendor_threads set status = 'quoted', updated_at = now() where id = th.id;
      return jsonb_build_object('ok', true, 'applied', 'quoted');
    end if;
  end if;

  -- Case 3: Declined or general info reply
  update public.vendor_threads set status = case when clean_outcome = 'declined' then 'declined' else 'replied' end, updated_at = now() where id = th.id;
  update public.tasks set
    log = public.log_entry(t.log, 'agent', th.vendor_name || case when clean_outcome = 'declined' then ' declined: ' else ' replied: ' end || coalesce(nullif(summary, ''), 'see email thread.'))
  where id = t.id;
  return jsonb_build_object('ok', true, 'applied', clean_outcome);
end $$;

revoke execute on function public.apply_vendor_reply(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_vendor_reply(uuid, text, jsonb, text) to service_role;
