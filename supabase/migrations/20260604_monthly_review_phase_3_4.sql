alter table public.monthly_review_runs
  add column if not exists assigned_reviewer_id uuid,
  add column if not exists assigned_reviewer_email text,
  add column if not exists assignment_notes text,
  add column if not exists evidence_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists evidence_hash text,
  add column if not exists readiness_score numeric not null default 0,
  add column if not exists last_reminder_at timestamptz;

alter table public.monthly_review_sections
  add column if not exists evidence_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists evidence_hash text;

create table if not exists public.monthly_review_audit_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.monthly_review_runs(id) on delete cascade,
  business_id uuid references public.business_profiles(id) on delete cascade,
  review_month date,
  actor_user_id uuid,
  actor_email text,
  event_type text not null,
  section_key text,
  previous_value jsonb,
  next_value jsonb,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.monthly_review_reminders (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.monthly_review_runs(id) on delete cascade,
  business_id uuid references public.business_profiles(id) on delete cascade,
  review_month date not null,
  reminder_type text not null default 'manual',
  message text,
  assigned_reviewer_email text,
  due_at timestamptz,
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists monthly_review_audit_events_run_idx
  on public.monthly_review_audit_events (run_id, created_at desc);

create index if not exists monthly_review_audit_events_business_month_idx
  on public.monthly_review_audit_events (business_id, review_month, created_at desc);

create index if not exists monthly_review_reminders_run_idx
  on public.monthly_review_reminders (run_id, created_at desc);

create index if not exists monthly_review_reminders_business_month_idx
  on public.monthly_review_reminders (business_id, review_month, created_at desc);

alter table public.monthly_review_audit_events enable row level security;
alter table public.monthly_review_reminders enable row level security;

-- No authenticated RLS policies are intentionally defined here.
-- Internal admin APIs use the service role and enforce access in application code.
