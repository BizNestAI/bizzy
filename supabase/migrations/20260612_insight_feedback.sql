-- Feedback for Bizzi financial insights.
-- Used to tune Contractor CFO alert frequency without deleting source insight rows.

create extension if not exists pgcrypto;

create table if not exists public.insight_feedback (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  insight_id uuid not null,
  user_id uuid null,
  feedback text not null,
  notes text null,
  created_at timestamptz default now(),
  constraint insight_feedback_feedback_check
    check (feedback in ('helpful', 'not_helpful', 'too_frequent', 'not_relevant', 'acted_on'))
);

create index if not exists insight_feedback_business_insight_idx
  on public.insight_feedback (business_id, insight_id);

create index if not exists insight_feedback_business_feedback_idx
  on public.insight_feedback (business_id, feedback);

create index if not exists insight_feedback_business_created_at_idx
  on public.insight_feedback (business_id, created_at desc);
