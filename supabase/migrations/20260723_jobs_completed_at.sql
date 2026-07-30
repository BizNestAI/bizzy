alter table public.jobs
  add column if not exists completed_at timestamp with time zone null;

create index if not exists jobs_business_status_idx
  on public.jobs using btree (business_id, status);

create index if not exists jobs_business_completed_at_idx
  on public.jobs using btree (business_id, completed_at desc)
  where completed_at is not null;
