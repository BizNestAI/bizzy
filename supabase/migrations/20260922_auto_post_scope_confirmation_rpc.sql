-- Auto-post scope confirmation contract.
-- 20260921 initially allowed the persisted scope value
-- 'explicit_backlog_released', while the application uses the clearer
-- canonical value 'effective_date'. Normalize compatible legacy values, then
-- enforce the two persisted scope modes used by the API.

do $$
declare
  v_unexpected text[];
begin
  update public.business_profiles
  set auto_post_scope_mode = 'effective_date'
  where auto_post_scope_mode = 'explicit_backlog_released';

  select array_agg(distinct auto_post_scope_mode order by auto_post_scope_mode)
    into v_unexpected
  from public.business_profiles
  where auto_post_scope_mode is not null
    and auto_post_scope_mode not in ('new_activity_only', 'effective_date');

  if coalesce(array_length(v_unexpected, 1), 0) > 0 then
    raise exception 'unexpected_auto_post_scope_mode_values: %', v_unexpected
      using errcode = '22023';
  end if;
end $$;

alter table public.business_profiles
  drop constraint if exists business_profiles_auto_post_scope_mode_check;

alter table public.business_profiles
  add constraint business_profiles_auto_post_scope_mode_check
  check (auto_post_scope_mode in ('new_activity_only', 'effective_date'));

alter table public.bookkeeping_auto_post_backlog_releases
  add column if not exists preview_total_count integer not null default 0,
  add column if not exists released_transaction_count integer not null default 0,
  add column if not exists blocked_transaction_count integer not null default 0,
  add column if not exists preview_fingerprint text;

create unique index if not exists bookkeeping_auto_post_backlog_releases_fingerprint_idx
  on public.bookkeeping_auto_post_backlog_releases (business_id, preview_fingerprint)
  where status = 'active' and preview_fingerprint is not null;

create or replace function public.confirm_auto_post_effective_date_scope(
  p_business_id uuid,
  p_scope_mode text,
  p_effective_date date,
  p_requested_by uuid,
  p_transaction_ids uuid[],
  p_preview_total_count integer,
  p_released_transaction_count integer,
  p_blocked_transaction_count integer,
  p_preview_fingerprint text,
  p_enabled_at timestamptz default null,
  p_release_metadata jsonb default '{}'::jsonb
)
returns table (
  business_id uuid,
  auto_post_scope_mode text,
  auto_post_effective_date date,
  historical_backlog_status text,
  release_id uuid,
  release_status text,
  preview_total_count integer,
  released_transaction_count integer,
  blocked_transaction_count integer,
  preview_fingerprint text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business public.business_profiles%rowtype;
  v_release_id uuid;
  v_now timestamptz := timezone('utc'::text, now());
  v_scope_mode text := lower(coalesce(p_scope_mode, ''));
  v_transaction_ids uuid[] := coalesce(p_transaction_ids, '{}'::uuid[]);
begin
  if p_business_id is null then
    raise exception 'missing_business_id' using errcode = '22023';
  end if;

  if v_scope_mode <> 'effective_date' then
    raise exception 'invalid_scope_mode' using errcode = '22023';
  end if;

  if p_effective_date is null then
    raise exception 'invalid_effective_date' using errcode = '22023';
  end if;

  if nullif(trim(coalesce(p_preview_fingerprint, '')), '') is null then
    raise exception 'preview_required' using errcode = '22023';
  end if;

  if coalesce(p_preview_total_count, -1) < 0
     or coalesce(p_released_transaction_count, -1) < 0
     or coalesce(p_blocked_transaction_count, -1) < 0 then
    raise exception 'invalid_preview_counts' using errcode = '22023';
  end if;

  if cardinality(v_transaction_ids) <> coalesce(p_released_transaction_count, 0) then
    raise exception 'released_transaction_count_mismatch' using errcode = '22023';
  end if;

  select *
    into v_business
  from public.business_profiles
  where id = p_business_id
  for update;

  if not found then
    raise exception 'business_not_found' using errcode = '22023';
  end if;

  select id
    into v_release_id
  from public.bookkeeping_auto_post_backlog_releases r
  where r.business_id = p_business_id
    and r.status = 'active'
    and r.preview_fingerprint = p_preview_fingerprint
  limit 1;

  if v_release_id is null then
    insert into public.bookkeeping_auto_post_backlog_releases (
      business_id,
      release_start_date,
      release_end_date,
      transaction_ids,
      status,
      requested_by,
      requested_at,
      release_metadata,
      preview_total_count,
      released_transaction_count,
      blocked_transaction_count,
      preview_fingerprint
    )
    values (
      p_business_id,
      p_effective_date,
      null,
      v_transaction_ids,
      'active',
      p_requested_by,
      v_now,
      coalesce(p_release_metadata, '{}'::jsonb) || jsonb_build_object(
        'preview_fingerprint', p_preview_fingerprint,
        'scope_mode', 'effective_date'
      ),
      coalesce(p_preview_total_count, 0),
      coalesce(p_released_transaction_count, 0),
      coalesce(p_blocked_transaction_count, 0),
      p_preview_fingerprint
    )
    returning id into v_release_id;
  end if;

  update public.business_profiles
  set auto_post_to_quickbooks = true,
      auto_post_enabled_at = coalesce(auto_post_enabled_at, p_enabled_at, v_now),
      auto_post_scope_mode = 'effective_date',
      auto_post_effective_date = p_effective_date,
      historical_backlog_status = 'released',
      backlog_reviewed_at = v_now,
      backlog_reviewed_by = p_requested_by,
      backlog_released_at = v_now,
      backlog_released_by = p_requested_by
  where id = p_business_id;

  return query
  select
    p_business_id,
    'effective_date'::text,
    p_effective_date,
    'released'::text,
    r.id,
    r.status,
    r.preview_total_count,
    r.released_transaction_count,
    r.blocked_transaction_count,
    r.preview_fingerprint
  from public.bookkeeping_auto_post_backlog_releases r
  where r.id = v_release_id;
end;
$$;

revoke all on function public.confirm_auto_post_effective_date_scope(uuid, text, date, uuid, uuid[], integer, integer, integer, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.confirm_auto_post_effective_date_scope(uuid, text, date, uuid, uuid[], integer, integer, integer, text, timestamptz, jsonb)
  to service_role;

comment on column public.business_profiles.auto_post_scope_mode is
  'Auto-post scope policy. Persisted values are new_activity_only and effective_date.';

comment on column public.bookkeeping_auto_post_backlog_releases.preview_total_count is
  'Total handled rows shown in the reviewed scope preview.';

comment on column public.bookkeeping_auto_post_backlog_releases.released_transaction_count is
  'Count of fully eligible transaction IDs enrolled by this audited release.';

comment on column public.bookkeeping_auto_post_backlog_releases.blocked_transaction_count is
  'Count of previewed rows excluded from automatic posting by safety checks.';

comment on column public.bookkeeping_auto_post_backlog_releases.preview_fingerprint is
  'Deterministic fingerprint of the previewed eligible population acknowledged before release.';

notify pgrst, 'reload schema';

-- Verification after application:
-- select pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.business_profiles'::regclass
--   and conname = 'business_profiles_auto_post_scope_mode_check';
--
-- select column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'bookkeeping_auto_post_backlog_releases'
--   and column_name in ('preview_total_count', 'released_transaction_count', 'blocked_transaction_count', 'preview_fingerprint')
-- order by column_name;
--
-- Rollback, only if no rows use effective_date:
-- do $$
-- begin
--   if exists (select 1 from public.business_profiles where auto_post_scope_mode = 'effective_date') then
--     raise exception 'rollback_blocked_effective_date_rows_exist';
--   end if;
-- end $$;
-- alter table public.business_profiles drop constraint if exists business_profiles_auto_post_scope_mode_check;
-- alter table public.business_profiles add constraint business_profiles_auto_post_scope_mode_check
--   check (auto_post_scope_mode in ('new_activity_only', 'explicit_backlog_released'));
-- drop function if exists public.confirm_auto_post_effective_date_scope(uuid, text, date, uuid, uuid[], integer, integer, integer, text, timestamptz, jsonb);
