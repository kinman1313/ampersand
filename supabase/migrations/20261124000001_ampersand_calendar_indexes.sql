-- Indexes for the calendar tables, built without locking writes.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction: apply this file on its own.
-- The primary keys already serve lookups by (user_id, provider) and by task_id.
-- calendar_connections_household_idx serves the household cascade delete.
-- calendar_events_user_idx serves disconnect (delete by user and provider) and the auth.users cascade.
-- calendar_pending_expires_idx serves the cleanup of expired rows; the uid and household indexes serve the cascades.
create index concurrently if not exists calendar_connections_household_idx on public.calendar_connections (household_id);
create index concurrently if not exists calendar_events_user_idx on public.calendar_events (user_id, provider);
create index concurrently if not exists calendar_pending_expires_idx on public.calendar_pending (expires_at);
create index concurrently if not exists calendar_pending_uid_idx on public.calendar_pending (uid);
create index concurrently if not exists calendar_pending_household_idx on public.calendar_pending (household_id);
