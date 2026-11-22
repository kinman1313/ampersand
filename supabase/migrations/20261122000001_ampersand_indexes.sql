-- Indexes for Ampersand, built without locking writes.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction: apply this file on its own.
create index concurrently if not exists tasks_household_idx on public.tasks (household_id);
create index concurrently if not exists tasks_assignee_idx on public.tasks (assignee);
create index concurrently if not exists tasks_created_by_idx on public.tasks (created_by);
create index concurrently if not exists approvals_household_idx on public.approvals (household_id);
create index concurrently if not exists approvals_user_idx on public.approvals (user_id);
create index concurrently if not exists private_items_user_idx on public.private_items (user_id);
create index concurrently if not exists households_created_by_idx on public.households (created_by);
