alter table public.report_metadata
  add column if not exists publication_status text not null default 'not_published',
  add column if not exists publication_request_id uuid,
  add column if not exists publication_failure_code text,
  add column if not exists monthly_review_source_snapshot_id uuid references public.monthly_review_qbo_pnl_snapshots(id) on delete restrict,
  add column if not exists monthly_review_source_fingerprint text;

update public.report_metadata
set publication_status = case
  when monthly_review_published_at is not null and storage_path is not null then 'published'
  else 'not_published'
end
where publication_status = 'not_published';

alter table public.report_metadata
  drop constraint if exists report_metadata_publication_status_check,
  add constraint report_metadata_publication_status_check
  check (publication_status in ('not_published', 'publishing', 'published', 'failed'));

create unique index if not exists report_metadata_publication_request_uq
  on public.report_metadata (business_id, publication_request_id)
  where publication_request_id is not null;

create index if not exists report_metadata_monthly_source_snapshot_idx
  on public.report_metadata (business_id, year, month, accounting_method, monthly_review_source_snapshot_id);
