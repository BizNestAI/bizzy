alter table public.report_metadata
  add column if not exists monthly_review_published_at timestamptz,
  add column if not exists monthly_review_published_by uuid,
  add column if not exists monthly_review_run_id uuid references public.monthly_review_runs(id) on delete set null,
  add column if not exists monthly_review_source text not null default 'system';

create index if not exists report_metadata_monthly_review_published_idx
  on public.report_metadata (business_id, year desc, month desc)
  where monthly_review_published_at is not null;
