alter table public.monthly_review_qbo_pnl_snapshots
  drop constraint if exists monthly_review_qbo_pnl_snapshots_status_check;

alter table public.monthly_review_qbo_pnl_snapshots
  add constraint monthly_review_qbo_pnl_snapshots_status_check
  check (status in ('building', 'validated', 'current', 'superseded', 'invalidated', 'failed'));
