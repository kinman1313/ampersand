-- Allow a signed-in user to leave their current household (for example, if they
-- accidentally created a solo household before entering their partner's invite code).
-- If no members remain in the household afterward, delete the now-empty household.
create or replace function public.leave_household()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  hh uuid := public.my_household();
  remaining int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if hh is null then raise exception 'You are not in a household'; end if;

  delete from public.approvals where household_id = hh and user_id = auth.uid();
  delete from public.members where household_id = hh and user_id = auth.uid();

  select count(*) into remaining from public.members where household_id = hh;
  if remaining = 0 then
    delete from public.households where id = hh;
  end if;

  return jsonb_build_object('left', true, 'deleted_household', remaining = 0);
end $$;

grant execute on function public.leave_household() to authenticated;
