-- Auto-post effective-date scope.
-- This keeps routine posting automatic while requiring a one-time audited
-- scope decision before historical Handled rows are enrolled.

alter table public.business_profiles
  drop constraint if exists business_profiles_auto_post_scope_mode_check;

alter table public.business_profiles
  add constraint business_profiles_auto_post_scope_mode_check
  check (auto_post_scope_mode in ('new_activity_only', 'effective_date', 'explicit_backlog_released'));

alter table public.bookkeeping_auto_post_backlog_releases
  add column if not exists preview_total_count integer not null default 0,
  add column if not exists released_transaction_count integer not null default 0,
  add column if not exists blocked_transaction_count integer not null default 0;

comment on column public.business_profiles.auto_post_scope_mode is
  'Auto-post scope policy. new_activity_only posts newly handled activity only; effective_date enrolls reviewed eligible rows dated on or after auto_post_effective_date. explicit_backlog_released is a legacy accepted value.';

comment on column public.bookkeeping_auto_post_backlog_releases.preview_total_count is
  'Total handled rows shown in the reviewed scope preview.';

comment on column public.bookkeeping_auto_post_backlog_releases.released_transaction_count is
  'Count of fully eligible transaction IDs enrolled by this audited release.';

comment on column public.bookkeeping_auto_post_backlog_releases.blocked_transaction_count is
  'Count of previewed rows excluded from automatic posting by safety checks.';

notify pgrst, 'reload schema';
