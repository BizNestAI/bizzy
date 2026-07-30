alter table public.monthly_review_runs
  add column if not exists active_editor_user_id uuid,
  add column if not exists active_editor_email text,
  add column if not exists active_editor_started_at timestamptz,
  add column if not exists active_editor_expires_at timestamptz;

create index if not exists monthly_review_runs_active_editor_idx
  on public.monthly_review_runs (active_editor_expires_at)
  where active_editor_expires_at is not null;
