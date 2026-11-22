-- Indexes for notify_log, built without locking writes.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction: apply this file on its own.
-- notify_log_recent_idx serves the per-task throttle (recipient, task, kind, last 6 hours)
-- and, through its leading column, the per-recipient daily cap.
create index concurrently if not exists notify_log_recent_idx on public.notify_log (recipient, task_id, kind, sent_at desc);
create index concurrently if not exists notify_log_household_idx on public.notify_log (household_id);
create index concurrently if not exists notify_log_task_idx on public.notify_log (task_id);
