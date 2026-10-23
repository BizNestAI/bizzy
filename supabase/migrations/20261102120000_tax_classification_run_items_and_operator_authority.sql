-- Exact Tax evaluation membership and explicit Bizzi operator authority.
-- Forward-only. This migration does not enqueue work or alter classifications.

create table if not exists public.tax_classification_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.tax_classification_runs(id) on delete cascade,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  tax_year integer not null check (tax_year between 2000 and 2100),
  stable_transaction_id uuid not null references public.bank_transactions(id) on delete restrict,
  source_fingerprint text not null check (length(trim(source_fingerprint)) > 0),
  membership_snapshot_at timestamptz not null default now(),
  lifecycle_state text not null default 'queued' check (lifecycle_state in (
    'queued', 'retry_scheduled', 'processing', 'completed', 'superseded',
    'blocked_bookkeeping', 'blocked_customer_fact', 'blocked_tax_mapping',
    'blocked_professional_review', 'failed_retryable', 'failed_terminal'
  )),
  safe_reason_code text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, stable_transaction_id),
  check (last_attempt_at is null or last_attempt_at >= membership_snapshot_at),
  check (completed_at is null or completed_at >= membership_snapshot_at),
  check (next_retry_at is null or lifecycle_state in ('retry_scheduled', 'failed_retryable')),
  check ((lease_owner is null) = (lease_expires_at is null))
);

create index if not exists tax_classification_run_items_tenant_run_idx
  on public.tax_classification_run_items (business_id, tax_year, run_id, created_at);
create index if not exists tax_classification_run_items_lifecycle_idx
  on public.tax_classification_run_items (business_id, tax_year, lifecycle_state, next_retry_at);
create unique index if not exists tax_classification_run_items_active_version_uidx
  on public.tax_classification_run_items (business_id, tax_year, stable_transaction_id, source_fingerprint)
  where lifecycle_state in ('queued', 'retry_scheduled', 'processing', 'failed_retryable');

create or replace function public.guard_tax_classification_run_item_identity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_run_business_id uuid;
  v_run_tax_year integer;
  v_transaction_business_id uuid;
begin
  select business_id, tax_year into v_run_business_id, v_run_tax_year
  from public.tax_classification_runs where id = new.run_id;
  select business_id into v_transaction_business_id
  from public.bank_transactions where id = new.stable_transaction_id;
  if v_run_business_id is distinct from new.business_id or v_run_tax_year is distinct from new.tax_year
     or v_transaction_business_id is distinct from new.business_id then
    raise exception 'tax classification run-item tenant/year mismatch';
  end if;
  if tg_op = 'UPDATE' and (new.run_id is distinct from old.run_id
     or new.business_id is distinct from old.business_id
     or new.tax_year is distinct from old.tax_year
     or new.stable_transaction_id is distinct from old.stable_transaction_id
     or new.source_fingerprint is distinct from old.source_fingerprint
     or new.membership_snapshot_at is distinct from old.membership_snapshot_at) then
    raise exception 'tax classification run-item membership is immutable';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tax_classification_run_items_identity_guard on public.tax_classification_run_items;
create trigger tax_classification_run_items_identity_guard
before insert or update on public.tax_classification_run_items
for each row execute function public.guard_tax_classification_run_item_identity();

create or replace function public.create_tax_classification_run_with_items(
  p_run jsonb,
  p_items jsonb
)
returns public.tax_classification_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.tax_classification_runs;
  v_item jsonb;
  v_count integer := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
begin
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or v_count < 1 then
    raise exception 'exact run membership is required';
  end if;
  if coalesce((p_run->>'queued_count')::integer, -1) <> v_count then
    raise exception 'run total must equal exact membership';
  end if;

  insert into public.tax_classification_runs (
    business_id, tax_year, trigger_source, status, total_eligible, queued_count,
    source_fingerprint, rules_version, process_after, metadata
  ) values (
    (p_run->>'business_id')::uuid, (p_run->>'tax_year')::integer,
    p_run->>'trigger_source', coalesce(p_run->>'status', 'queued'),
    coalesce((p_run->>'total_eligible')::integer, v_count), v_count,
    p_run->>'source_fingerprint', p_run->>'rules_version',
    coalesce((p_run->>'process_after')::timestamptz, now()),
    coalesce(p_run->'metadata', '{}'::jsonb) || jsonb_build_object('exact_membership', true)
  ) returning * into v_run;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    insert into public.tax_classification_run_items (
      run_id, business_id, tax_year, stable_transaction_id, source_fingerprint,
      membership_snapshot_at, lifecycle_state
    ) values (
      v_run.id, v_run.business_id, v_run.tax_year,
      (v_item->>'stable_transaction_id')::uuid, v_item->>'source_fingerprint',
      coalesce((v_item->>'membership_snapshot_at')::timestamptz, now()), 'queued'
    );
  end loop;

  if (select count(*) from public.tax_classification_run_items where run_id = v_run.id) <> v_run.queued_count then
    raise exception 'run membership count mismatch';
  end if;
  return v_run;
end;
$$;

alter table public.tax_classification_run_items enable row level security;
alter table public.tax_classification_run_items force row level security;
revoke all on table public.tax_classification_run_items from public, anon, authenticated;
grant select, insert, update on table public.tax_classification_run_items to service_role;
revoke all on function public.create_tax_classification_run_with_items(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_tax_classification_run_with_items(jsonb, jsonb) to service_role;
revoke all on function public.guard_tax_classification_run_item_identity() from public, anon, authenticated;
grant execute on function public.guard_tax_classification_run_item_identity() to service_role;

comment on table public.tax_classification_run_items is
  'Immutable exact membership for a Tax classification run. Lifecycle fields are service-controlled.';
comment on column public.tax_classification_run_items.safe_reason_code is
  'Allowlisted internal reason code only; never a raw provider or database error.';
comment on column public.transaction_tax_classifications.classification_status is
  'Authority includes needs_review, needs_tax_review, auto_classified, user_confirmed, bizzi_operator_confirmed, cpa_confirmed and excluded.';

alter table public.tax_classification_overrides
  drop constraint if exists tax_classification_overrides_source_check;
alter table public.tax_classification_overrides
  add constraint tax_classification_overrides_source_check
  check (override_source in ('user', 'cpa', 'admin', 'bizzi_operator', 'system_correction', 'system_repair'));
