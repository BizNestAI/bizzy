-- Controlled replacement-card repair and cursor bootstrap.
-- All tables are service-role only; no provider call or live repair is performed by this migration.

alter table public.plaid_items
  add column if not exists sync_lease_owner text,
  add column if not exists sync_lease_acquired_at timestamptz,
  add column if not exists sync_lease_expires_at timestamptz;

alter table public.bank_sync_runs drop constraint if exists bank_sync_runs_status_check;
alter table public.bank_sync_runs
  add column if not exists worker_id text,
  add column if not exists lease_acquired_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists failure_code text,
  add column if not exists error_message text,
  add constraint bank_sync_runs_status_check
    check (status in ('running','completed','failed','abandoned','ok','error'));

create or replace function public.claim_plaid_sync_lease(
  p_business_id uuid, p_item_id uuid, p_owner text, p_ttl_seconds integer default 300
) returns boolean language plpgsql security definer set search_path = public as $$
declare affected_rows integer;
begin
  update public.plaid_items
     set sync_in_progress = true,
         sync_started_at = now(),
         sync_lease_owner = p_owner,
         sync_lease_acquired_at = now(),
         sync_lease_expires_at = now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 1800)))
   where id = p_item_id and business_id = p_business_id
     and (
       (sync_lease_owner is null and (coalesce(sync_in_progress, false) = false or sync_started_at is null or sync_started_at + make_interval(secs => greatest(30, least(p_ttl_seconds, 1800))) <= now()))
       or sync_lease_expires_at <= now()
       or sync_lease_owner = p_owner
     );
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end $$;

create or replace function public.release_plaid_sync_lease(
  p_business_id uuid, p_item_id uuid, p_owner text
) returns boolean language plpgsql security definer set search_path = public as $$
declare affected_rows integer;
begin
  update public.plaid_items
     set sync_in_progress = false, sync_started_at = null,
         sync_lease_owner = null, sync_lease_acquired_at = null, sync_lease_expires_at = null
   where id = p_item_id and business_id = p_business_id and sync_lease_owner = p_owner;
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end $$;

revoke all on function public.claim_plaid_sync_lease(uuid,uuid,text,integer) from public, anon, authenticated;
revoke all on function public.release_plaid_sync_lease(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_plaid_sync_lease(uuid,uuid,text,integer) to service_role;
grant execute on function public.release_plaid_sync_lease(uuid,uuid,text) to service_role;

create table if not exists public.plaid_recovery_batches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  plaid_env text not null,
  plaid_item_id text not null,
  original_cursor text,
  staged_next_cursor text,
  cutoff_date date not null,
  status text not null default 'staging' check (status in ('staging','preview_ready','lineage_confirmation_required','imported_held','released','failed','abandoned')),
  posting_hold boolean not null default true,
  summary jsonb not null default '{}'::jsonb,
  failure_code text,
  failure_detail text,
  created_by uuid,
  released_by uuid,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, plaid_env, plaid_item_id, id)
);

create table if not exists public.plaid_recovery_batch_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.plaid_recovery_batches(id) on delete cascade,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  plaid_transaction_id text,
  pending_transaction_id text,
  plaid_account_id text,
  physical_account_id uuid,
  change_type text not null check (change_type in ('added','modified','removed')),
  disposition text not null check (disposition in ('exact_existing','pending_replacement','represented','historical_discrepancy','new_after_cutoff','probable_duplicate','ambiguous','removed_existing')),
  transaction_date date,
  authorized_date date,
  payload jsonb not null default '{}'::jsonb,
  admitted_transaction_id uuid,
  created_at timestamptz not null default now(),
  unique (batch_id, change_type, plaid_transaction_id)
);

create table if not exists public.plaid_account_lineage_decisions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  plaid_env text not null,
  physical_account_id uuid not null,
  prior_plaid_account_id text not null,
  replacement_plaid_account_id text not null,
  qbo_account_id text not null,
  status text not null default 'confirmed' check (status in ('confirmed','reversed')),
  source text not null,
  actor_user_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid,
  unique (business_id, plaid_env, replacement_plaid_account_id)
);

create table if not exists public.plaid_replacement_account_candidates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  plaid_env text not null,
  plaid_item_id text not null,
  plaid_account_id text not null,
  account_snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  unique (business_id, plaid_env, plaid_item_id, plaid_account_id)
);

alter table public.bank_transactions add column if not exists plaid_recovery_batch_id uuid references public.plaid_recovery_batches(id);
alter table public.transaction_categorizations add column if not exists posting_hold_batch_id uuid references public.plaid_recovery_batches(id);

create index if not exists plaid_recovery_batches_item_idx on public.plaid_recovery_batches (business_id, plaid_env, plaid_item_id, created_at desc);
create index if not exists plaid_recovery_rows_disposition_idx on public.plaid_recovery_batch_rows (business_id, batch_id, disposition);
create index if not exists transaction_categorizations_posting_hold_idx on public.transaction_categorizations (business_id, posting_hold_batch_id) where posting_hold_batch_id is not null;

alter table public.plaid_recovery_batches enable row level security;
alter table public.plaid_recovery_batch_rows enable row level security;
alter table public.plaid_account_lineage_decisions enable row level security;
alter table public.plaid_replacement_account_candidates enable row level security;
revoke all on table public.plaid_recovery_batches, public.plaid_recovery_batch_rows, public.plaid_account_lineage_decisions, public.plaid_replacement_account_candidates from public, anon, authenticated;
grant all on table public.plaid_recovery_batches, public.plaid_recovery_batch_rows, public.plaid_account_lineage_decisions, public.plaid_replacement_account_candidates to service_role;
