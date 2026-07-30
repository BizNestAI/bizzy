-- Draft client-facing text for Change Order Tracker.

alter table public.job_change_orders
  add column if not exists draft_client_message text null,
  add column if not exists draft_scope_summary text null;
