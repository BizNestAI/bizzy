alter table if exists public.tax_payments
  add column if not exists idempotency_key text null,
  add column if not exists payment_fingerprint text null,
  add column if not exists request_id text null,
  add column if not exists source_event_id text null,
  add column if not exists created_by uuid null,
  add column if not exists updated_at timestamptz null,
  add column if not exists voided_at timestamptz null,
  add column if not exists void_reason text null;

create unique index if not exists tax_payments_business_idempotency_uidx
  on public.tax_payments (business_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists tax_payments_business_source_event_uidx
  on public.tax_payments (business_id, source_event_id)
  where source_event_id is not null;

create index if not exists tax_payments_business_fingerprint_idx
  on public.tax_payments (business_id, payment_fingerprint)
  where payment_fingerprint is not null;

create index if not exists tax_payments_active_apply_idx
  on public.tax_payments (business_id, tax_year, jurisdiction, payment_type, status)
  where voided_at is null;
