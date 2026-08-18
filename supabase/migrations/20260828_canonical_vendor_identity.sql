-- Canonical Bizzi vendor identity and exactly-once QBO Vendor creation.
-- QBO remains authoritative for QBO entity state; these tables control
-- Bizzi canonical vendor identity, aliases, canonical-to-QBO mapping, creation
-- idempotency, and audit history.

create table if not exists public.bizzi_vendors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  display_name text not null,
  normalized_display_name text not null,
  status text not null default 'active',
  primary_evidence_type text not null,
  primary_evidence_value text,
  primary_source text not null default 'resolver',
  confidence text not null default 'medium',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bizzi_vendors_status_check
    check (status in ('active', 'needs_review', 'merged', 'disabled')),
  constraint bizzi_vendors_confidence_check
    check (confidence in ('high', 'medium', 'low')),
  constraint bizzi_vendors_evidence_type_check
    check (primary_evidence_type in ('qbo_vendor_id', 'qbo_display_name', 'plaid_merchant_entity_id', 'plaid_merchant_name', 'plaid_counterparty_name', 'approved_alias', 'memo_prefix', 'manual'))
);

create unique index if not exists bizzi_vendors_business_normalized_active_uq
  on public.bizzi_vendors (business_id, normalized_display_name)
  where status = 'active';

create index if not exists bizzi_vendors_business_status_idx
  on public.bizzi_vendors (business_id, status, created_at desc);

create table if not exists public.vendor_aliases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  canonical_vendor_id uuid not null references public.bizzi_vendors(id) on delete cascade,
  alias_type text not null,
  alias_value text not null,
  normalized_alias_value text not null,
  source text not null default 'resolver',
  confidence text not null default 'medium',
  is_strong_evidence boolean not null default false,
  is_approved boolean not null default false,
  first_transaction_id uuid references public.bank_transactions(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_aliases_type_check
    check (alias_type in ('plaid_merchant_entity_id', 'plaid_merchant_name', 'plaid_counterparty_name', 'normalized_merchant_text', 'approved_memo_prefix', 'manual_alias', 'qbo_vendor_id', 'qbo_display_name')),
  constraint vendor_aliases_confidence_check
    check (confidence in ('high', 'medium', 'low'))
);

create unique index if not exists vendor_aliases_business_alias_uq
  on public.vendor_aliases (business_id, alias_type, normalized_alias_value);

create index if not exists vendor_aliases_vendor_idx
  on public.vendor_aliases (business_id, canonical_vendor_id);

create index if not exists vendor_aliases_strong_lookup_idx
  on public.vendor_aliases (business_id, alias_type, normalized_alias_value)
  where is_strong_evidence = true and is_approved = true;

create table if not exists public.business_qbo_vendor_mappings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'production',
  canonical_vendor_id uuid not null references public.bizzi_vendors(id) on delete cascade,
  qbo_vendor_id text not null,
  qbo_display_name text not null,
  status text not null default 'active',
  mapping_source text not null default 'resolver',
  created_by text not null default 'bizzi',
  mapped_by text,
  mapped_at timestamptz not null default now(),
  disabled_at timestamptz,
  first_transaction_id uuid references public.bank_transactions(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_qbo_vendor_mappings_status_check
    check (status in ('active', 'needs_review', 'disabled')),
  constraint business_qbo_vendor_mappings_source_check
    check (mapping_source in ('resolver', 'manual', 'qbo_sync', 'creation_intent', 'backfill'))
);

create unique index if not exists business_qbo_vendor_mapping_vendor_active_uq
  on public.business_qbo_vendor_mappings (business_id, qbo_env, realm_id, canonical_vendor_id)
  where status = 'active';

create unique index if not exists business_qbo_vendor_mapping_qbo_active_uq
  on public.business_qbo_vendor_mappings (business_id, qbo_env, realm_id, qbo_vendor_id)
  where status = 'active';

create index if not exists business_qbo_vendor_mappings_business_idx
  on public.business_qbo_vendor_mappings (business_id, status, created_at desc);

create table if not exists public.qbo_vendor_name_cache (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'production',
  qbo_entity_type text not null,
  qbo_entity_id text not null,
  display_name text not null,
  normalized_display_name text not null,
  active boolean not null default true,
  raw jsonb not null default '{}',
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qbo_vendor_name_cache_entity_type_check
    check (qbo_entity_type in ('vendor', 'customer', 'employee'))
);

create unique index if not exists qbo_vendor_name_cache_entity_uq
  on public.qbo_vendor_name_cache (business_id, qbo_env, realm_id, qbo_entity_type, qbo_entity_id);

create index if not exists qbo_vendor_name_cache_name_idx
  on public.qbo_vendor_name_cache (business_id, qbo_env, realm_id, normalized_display_name);

create table if not exists public.qbo_vendor_creation_intents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'production',
  canonical_vendor_id uuid not null references public.bizzi_vendors(id) on delete cascade,
  desired_display_name text not null,
  request_id text not null,
  status text not null default 'processing',
  attempt_count integer not null default 0,
  processing_started_at timestamptz,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  qbo_vendor_id text,
  qbo_display_name text,
  payload_summary jsonb,
  response_summary jsonb,
  last_error jsonb,
  first_transaction_id uuid references public.bank_transactions(id) on delete set null,
  created_by text not null default 'bizzi',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qbo_vendor_creation_intents_status_check
    check (status in ('processing', 'unknown', 'created', 'mapped_existing', 'needs_review', 'failed')),
  unique (business_id, qbo_env, realm_id, canonical_vendor_id),
  unique (business_id, qbo_env, realm_id, request_id)
);

create index if not exists qbo_vendor_creation_intents_processing_idx
  on public.qbo_vendor_creation_intents (business_id, status, lease_expires_at)
  where status in ('processing', 'unknown', 'failed');

create table if not exists public.vendor_mapping_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text,
  qbo_env text not null default 'production',
  canonical_vendor_id uuid references public.bizzi_vendors(id) on delete set null,
  qbo_vendor_id text,
  qbo_display_name text,
  event_type text not null,
  source text not null default 'resolver',
  transaction_id uuid references public.bank_transactions(id) on delete set null,
  actor text not null default 'bizzi',
  reason text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint vendor_mapping_events_type_check
    check (event_type in ('canonical_vendor_created', 'alias_learned', 'existing_qbo_vendor_reused', 'qbo_vendor_created', 'conflict_detected', 'manual_link', 'override', 'creation_claimed', 'creation_unknown', 'creation_failed', 'needs_review'))
);

create index if not exists vendor_mapping_events_business_idx
  on public.vendor_mapping_events (business_id, created_at desc);

alter table if exists public.bank_transactions
  add column if not exists canonical_vendor_id uuid references public.bizzi_vendors(id) on delete set null;

create index if not exists bank_transactions_canonical_vendor_idx
  on public.bank_transactions (business_id, canonical_vendor_id)
  where canonical_vendor_id is not null;

do $$
begin
  if exists (
    select 1
    from public.vendor_aliases va
    left join public.bizzi_vendors v
      on v.id = va.canonical_vendor_id
     and v.business_id = va.business_id
    where v.id is null
  ) then
    raise exception 'cross_business_vendor_aliases_detected';
  end if;

  if exists (
    select 1
    from public.business_qbo_vendor_mappings m
    left join public.bizzi_vendors v
      on v.id = m.canonical_vendor_id
     and v.business_id = m.business_id
    where v.id is null
  ) then
    raise exception 'cross_business_qbo_vendor_mappings_detected';
  end if;

  if exists (
    select 1
    from public.qbo_vendor_creation_intents i
    left join public.bizzi_vendors v
      on v.id = i.canonical_vendor_id
     and v.business_id = i.business_id
    where v.id is null
  ) then
    raise exception 'cross_business_qbo_vendor_creation_intents_detected';
  end if;

  if exists (
    select 1
    from public.vendor_mapping_events e
    left join public.bizzi_vendors v
      on v.id = e.canonical_vendor_id
     and v.business_id = e.business_id
    where e.canonical_vendor_id is not null
      and v.id is null
  ) then
    raise exception 'cross_business_vendor_mapping_events_detected';
  end if;

  if exists (
    select 1
    from public.bank_transactions bt
    left join public.bizzi_vendors v
      on v.id = bt.canonical_vendor_id
     and v.business_id = bt.business_id
    where bt.canonical_vendor_id is not null
      and v.id is null
  ) then
    raise exception 'cross_business_bank_transaction_canonical_vendor_links_detected';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bizzi_vendors'::regclass
      and conname = 'bizzi_vendors_business_id_id_uq'
  ) then
    alter table public.bizzi_vendors
      add constraint bizzi_vendors_business_id_id_uq unique (business_id, id);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendor_aliases'::regclass
      and conname = 'vendor_aliases_business_vendor_fk'
  ) then
    alter table public.vendor_aliases
      add constraint vendor_aliases_business_vendor_fk
      foreign key (business_id, canonical_vendor_id)
      references public.bizzi_vendors (business_id, id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_qbo_vendor_mappings'::regclass
      and conname = 'business_qbo_vendor_mappings_business_vendor_fk'
  ) then
    alter table public.business_qbo_vendor_mappings
      add constraint business_qbo_vendor_mappings_business_vendor_fk
      foreign key (business_id, canonical_vendor_id)
      references public.bizzi_vendors (business_id, id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.qbo_vendor_creation_intents'::regclass
      and conname = 'qbo_vendor_creation_intents_business_vendor_fk'
  ) then
    alter table public.qbo_vendor_creation_intents
      add constraint qbo_vendor_creation_intents_business_vendor_fk
      foreign key (business_id, canonical_vendor_id)
      references public.bizzi_vendors (business_id, id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendor_mapping_events'::regclass
      and conname = 'vendor_mapping_events_business_vendor_fk'
  ) then
    alter table public.vendor_mapping_events
      add constraint vendor_mapping_events_business_vendor_fk
      foreign key (business_id, canonical_vendor_id)
      references public.bizzi_vendors (business_id, id)
      on delete set null (canonical_vendor_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bank_transactions'::regclass
      and conname = 'bank_transactions_business_canonical_vendor_fk'
  ) then
    alter table public.bank_transactions
      add constraint bank_transactions_business_canonical_vendor_fk
      foreign key (business_id, canonical_vendor_id)
      references public.bizzi_vendors (business_id, id)
      on delete set null (canonical_vendor_id);
  end if;
end;
$$;

create or replace function public.claim_qbo_vendor_creation_intent(
  p_business_id uuid,
  p_realm_id text,
  p_qbo_env text,
  p_canonical_vendor_id uuid,
  p_desired_display_name text,
  p_request_id text,
  p_first_transaction_id uuid default null,
  p_payload_summary jsonb default null,
  p_now timestamptz default now(),
  p_lease_seconds integer default 600
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.qbo_vendor_creation_intents;
  v_inserted integer := 0;
begin
  if p_business_id is null or p_canonical_vendor_id is null then
    raise exception 'missing_vendor_creation_identity';
  end if;
  if p_realm_id is null or length(trim(p_realm_id)) = 0 then
    raise exception 'missing_qbo_realm_id';
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 or length(p_request_id) > 50 then
    raise exception 'invalid_qbo_vendor_request_id';
  end if;

  insert into public.qbo_vendor_creation_intents (
    business_id,
    realm_id,
    qbo_env,
    canonical_vendor_id,
    desired_display_name,
    request_id,
    status,
    attempt_count,
    processing_started_at,
    lease_expires_at,
    last_attempt_at,
    first_transaction_id,
    payload_summary,
    created_at,
    updated_at
  )
  values (
    p_business_id,
    p_realm_id,
    coalesce(p_qbo_env, 'production'),
    p_canonical_vendor_id,
    p_desired_display_name,
    p_request_id,
    'processing',
    1,
    p_now,
    p_now + make_interval(secs => p_lease_seconds),
    p_now,
    p_first_transaction_id,
    p_payload_summary,
    p_now,
    p_now
  )
  on conflict (business_id, qbo_env, realm_id, canonical_vendor_id) do nothing;
  get diagnostics v_inserted = row_count;

  select *
    into v_row
  from public.qbo_vendor_creation_intents
  where business_id = p_business_id
    and qbo_env = coalesce(p_qbo_env, 'production')
    and realm_id = p_realm_id
    and canonical_vendor_id = p_canonical_vendor_id
  for update;

  if not found then
    raise exception 'vendor_creation_intent_claim_failed';
  end if;

  if v_row.status in ('created', 'mapped_existing') and v_row.qbo_vendor_id is not null then
    return jsonb_build_object('claimed', false, 'already_mapped', true, 'intent', to_jsonb(v_row));
  end if;

  if v_inserted > 0 then
    return jsonb_build_object('claimed', true, 'already_mapped', false, 'intent', to_jsonb(v_row));
  end if;

  if v_row.status = 'processing'
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > p_now
     and coalesce(v_row.request_id, p_request_id) = p_request_id
     and v_row.last_attempt_at is not null
     and v_row.last_attempt_at <> p_now then
    return jsonb_build_object('claimed', false, 'already_mapped', false, 'intent', to_jsonb(v_row));
  end if;

  update public.qbo_vendor_creation_intents
     set status = 'processing',
         desired_display_name = coalesce(desired_display_name, p_desired_display_name),
         request_id = coalesce(request_id, p_request_id),
         attempt_count = coalesce(attempt_count, 0) + 1,
         processing_started_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         last_attempt_at = p_now,
         payload_summary = coalesce(payload_summary, p_payload_summary),
         updated_at = p_now
   where business_id = p_business_id
     and qbo_env = coalesce(p_qbo_env, 'production')
     and realm_id = p_realm_id
     and canonical_vendor_id = p_canonical_vendor_id
     and (request_id is null or request_id = p_request_id)
  returning * into v_row;

  if not found then
    raise exception 'vendor_creation_request_id_mismatch';
  end if;

  return jsonb_build_object('claimed', true, 'already_mapped', false, 'intent', to_jsonb(v_row));
end;
$$;

revoke all on function public.claim_qbo_vendor_creation_intent(uuid, text, text, uuid, text, text, uuid, jsonb, timestamptz, integer) from public;
revoke all on function public.claim_qbo_vendor_creation_intent(uuid, text, text, uuid, text, text, uuid, jsonb, timestamptz, integer) from anon;
revoke all on function public.claim_qbo_vendor_creation_intent(uuid, text, text, uuid, text, text, uuid, jsonb, timestamptz, integer) from authenticated;
grant execute on function public.claim_qbo_vendor_creation_intent(uuid, text, text, uuid, text, text, uuid, jsonb, timestamptz, integer) to service_role;

create or replace function public.claim_canonical_vendor_by_strong_alias(
  p_business_id uuid,
  p_alias_type text,
  p_alias_value text,
  p_normalized_alias_value text,
  p_display_name text,
  p_normalized_display_name text,
  p_primary_evidence_type text,
  p_primary_evidence_value text,
  p_primary_source text default 'resolver',
  p_confidence text default 'high',
  p_transaction_id uuid default null,
  p_alias_source text default 'resolver',
  p_alias_confidence text default 'high',
  p_alias_metadata jsonb default '{}',
  p_vendor_metadata jsonb default '{}',
  p_now timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vendor public.bizzi_vendors;
  v_alias public.vendor_aliases;
  v_inserted_vendor_id uuid;
  v_alias_inserted integer := 0;
  v_lock_key text;
begin
  if p_business_id is null then
    raise exception 'missing_business_id';
  end if;
  if p_alias_type is null
     or p_normalized_alias_value is null
     or length(trim(p_normalized_alias_value)) = 0 then
    raise exception 'missing_strong_alias';
  end if;
  if p_alias_type not in ('plaid_merchant_entity_id', 'qbo_vendor_id') then
    raise exception 'unsupported_strong_alias_type:%', p_alias_type;
  end if;
  if p_display_name is null
     or length(trim(p_display_name)) = 0
     or p_normalized_display_name is null
     or length(trim(p_normalized_display_name)) = 0 then
    raise exception 'missing_canonical_vendor_name';
  end if;

  v_lock_key := p_business_id::text || ':' || p_alias_type || ':' || p_normalized_alias_value;
  perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

  select va.*
    into v_alias
  from public.vendor_aliases va
  where va.business_id = p_business_id
    and va.alias_type = p_alias_type
    and va.normalized_alias_value = p_normalized_alias_value
    and va.is_strong_evidence = true
    and va.is_approved = true
  for update;

  if found then
    select *
      into v_vendor
    from public.bizzi_vendors
    where id = v_alias.canonical_vendor_id
      and business_id = p_business_id;

    if found then
      return jsonb_build_object(
        'claimed', false,
        'created', false,
        'canonical_vendor', to_jsonb(v_vendor),
        'alias', to_jsonb(v_alias)
      );
    end if;

    raise exception 'strong_alias_owner_missing:%', v_alias.canonical_vendor_id;
  end if;

  select *
    into v_vendor
  from public.bizzi_vendors
  where business_id = p_business_id
    and normalized_display_name = p_normalized_display_name
    and status = 'active'
  for update;

  if found then
    insert into public.vendor_aliases (
      business_id,
      canonical_vendor_id,
      alias_type,
      alias_value,
      normalized_alias_value,
      source,
      confidence,
      is_strong_evidence,
      is_approved,
      first_transaction_id,
      metadata,
      created_at,
      updated_at
    )
    values (
      p_business_id,
      v_vendor.id,
      p_alias_type,
      p_alias_value,
      p_normalized_alias_value,
      coalesce(p_alias_source, 'resolver'),
      coalesce(p_alias_confidence, 'high'),
      true,
      true,
      p_transaction_id,
      coalesce(p_alias_metadata, '{}'::jsonb),
      p_now,
      p_now
    )
    on conflict (business_id, alias_type, normalized_alias_value) do nothing;

    select va.*
      into v_alias
    from public.vendor_aliases va
    where va.business_id = p_business_id
      and va.alias_type = p_alias_type
      and va.normalized_alias_value = p_normalized_alias_value;

    if not found or v_alias.canonical_vendor_id <> v_vendor.id then
      raise exception 'strong_alias_claim_conflict';
    end if;

    insert into public.vendor_mapping_events (
      business_id,
      canonical_vendor_id,
      event_type,
      source,
      transaction_id,
      actor,
      reason,
      metadata,
      created_at
    )
    values (
      p_business_id,
      v_vendor.id,
      'alias_learned',
      coalesce(p_alias_source, 'resolver'),
      p_transaction_id,
      'bizzi',
      'strong_alias_attached_to_existing_canonical_vendor',
      jsonb_build_object('alias_type', p_alias_type),
      p_now
    );

    return jsonb_build_object(
      'claimed', true,
      'created', false,
      'canonical_vendor', to_jsonb(v_vendor),
      'alias', to_jsonb(v_alias)
    );
  end if;

  insert into public.bizzi_vendors (
    business_id,
    display_name,
    normalized_display_name,
    status,
    primary_evidence_type,
    primary_evidence_value,
    primary_source,
    confidence,
    metadata,
    created_at,
    updated_at
  )
  values (
    p_business_id,
    p_display_name,
    p_normalized_display_name,
    'active',
    p_primary_evidence_type,
    p_primary_evidence_value,
    coalesce(p_primary_source, 'resolver'),
    coalesce(p_confidence, 'high'),
    coalesce(p_vendor_metadata, '{}'::jsonb),
    p_now,
    p_now
  )
  returning * into v_vendor;

  v_inserted_vendor_id := v_vendor.id;

  insert into public.vendor_aliases (
    business_id,
    canonical_vendor_id,
    alias_type,
    alias_value,
    normalized_alias_value,
    source,
    confidence,
    is_strong_evidence,
    is_approved,
    first_transaction_id,
    metadata,
    created_at,
    updated_at
  )
  values (
    p_business_id,
    v_vendor.id,
    p_alias_type,
    p_alias_value,
    p_normalized_alias_value,
    coalesce(p_alias_source, 'resolver'),
    coalesce(p_alias_confidence, 'high'),
    true,
    true,
    p_transaction_id,
    coalesce(p_alias_metadata, '{}'::jsonb),
    p_now,
    p_now
  )
  on conflict (business_id, alias_type, normalized_alias_value) do nothing;
  get diagnostics v_alias_inserted = row_count;

  if v_alias_inserted = 0 then
    select va.*
      into v_alias
    from public.vendor_aliases va
    where va.business_id = p_business_id
      and va.alias_type = p_alias_type
      and va.normalized_alias_value = p_normalized_alias_value;

    if not found then
      raise exception 'strong_alias_claim_failed';
    end if;

    if v_inserted_vendor_id is not null and v_alias.canonical_vendor_id <> v_inserted_vendor_id then
      update public.bizzi_vendors
         set status = 'merged',
             metadata = coalesce(metadata, '{}'::jsonb) ||
                        jsonb_build_object(
                          'merged_into_canonical_vendor_id', v_alias.canonical_vendor_id,
                          'merge_reason', 'lost_strong_alias_claim',
                          'merged_at', p_now
                        ),
             updated_at = p_now
       where id = v_inserted_vendor_id
         and business_id = p_business_id
         and status = 'active';
    end if;

    select *
      into v_vendor
    from public.bizzi_vendors
    where id = v_alias.canonical_vendor_id
      and business_id = p_business_id;

    return jsonb_build_object(
      'claimed', false,
      'created', false,
      'canonical_vendor', to_jsonb(v_vendor),
      'alias', to_jsonb(v_alias)
    );
  end if;

  select *
    into v_alias
  from public.vendor_aliases
  where business_id = p_business_id
    and alias_type = p_alias_type
    and normalized_alias_value = p_normalized_alias_value;

  insert into public.vendor_mapping_events (
    business_id,
    canonical_vendor_id,
    event_type,
    source,
    transaction_id,
    actor,
    reason,
    metadata,
    created_at
  )
  values (
    p_business_id,
    v_vendor.id,
    'canonical_vendor_created',
    coalesce(p_primary_source, 'resolver'),
    p_transaction_id,
    'bizzi',
    'strong_alias_claim_created_canonical_vendor',
    jsonb_build_object('alias_type', p_alias_type, 'display_name', p_display_name),
    p_now
  );

  insert into public.vendor_mapping_events (
    business_id,
    canonical_vendor_id,
    event_type,
    source,
    transaction_id,
    actor,
    reason,
    metadata,
    created_at
  )
  values (
    p_business_id,
    v_vendor.id,
    'alias_learned',
    coalesce(p_alias_source, 'resolver'),
    p_transaction_id,
    'bizzi',
    'strong_alias_claimed',
    jsonb_build_object('alias_type', p_alias_type),
    p_now
  );

  return jsonb_build_object(
    'claimed', true,
    'created', true,
    'canonical_vendor', to_jsonb(v_vendor),
    'alias', to_jsonb(v_alias)
  );
end;
$$;

revoke all on function public.claim_canonical_vendor_by_strong_alias(uuid, text, text, text, text, text, text, text, text, text, uuid, text, text, jsonb, jsonb, timestamptz) from public;
revoke all on function public.claim_canonical_vendor_by_strong_alias(uuid, text, text, text, text, text, text, text, text, text, uuid, text, text, jsonb, jsonb, timestamptz) from anon;
revoke all on function public.claim_canonical_vendor_by_strong_alias(uuid, text, text, text, text, text, text, text, text, text, uuid, text, text, jsonb, jsonb, timestamptz) from authenticated;
grant execute on function public.claim_canonical_vendor_by_strong_alias(uuid, text, text, text, text, text, text, text, text, text, uuid, text, text, jsonb, jsonb, timestamptz) to service_role;

-- Conservative backfill: preserve exact known QBO links and strong provider
-- identities, but do not fuzzy-merge historical memo variants.
insert into public.bizzi_vendors (
  business_id,
  display_name,
  normalized_display_name,
  primary_evidence_type,
  primary_evidence_value,
  primary_source,
  confidence,
  metadata
)
select distinct on (qvc.business_id, lower(regexp_replace(qvc.vendor_name, '[^a-zA-Z0-9]+', ' ', 'g')))
  qvc.business_id,
  qvc.vendor_name,
  lower(trim(regexp_replace(qvc.vendor_name, '[^a-zA-Z0-9]+', ' ', 'g'))),
  'qbo_vendor_id',
  qvc.qbo_entity_id,
  'backfill',
  'high',
  jsonb_build_object('source_table', 'qbo_vendor_creations')
from public.qbo_vendor_creations qvc
where qvc.qbo_entity_type = 'vendor'
  and qvc.vendor_name is not null
on conflict do nothing;

insert into public.vendor_aliases (
  business_id,
  canonical_vendor_id,
  alias_type,
  alias_value,
  normalized_alias_value,
  source,
  confidence,
  is_strong_evidence,
  is_approved,
  metadata
)
select
  v.business_id,
  v.id,
  'qbo_vendor_id',
  v.primary_evidence_value,
  lower(v.primary_evidence_value),
  'backfill',
  'high',
  true,
  true,
  jsonb_build_object('source_table', 'qbo_vendor_creations')
from public.bizzi_vendors v
where v.primary_evidence_type = 'qbo_vendor_id'
  and v.primary_evidence_value is not null
on conflict do nothing;

insert into public.vendor_aliases (
  business_id,
  canonical_vendor_id,
  alias_type,
  alias_value,
  normalized_alias_value,
  source,
  confidence,
  is_strong_evidence,
  is_approved,
  metadata
)
select
  v.business_id,
  v.id,
  'qbo_display_name',
  v.display_name,
  v.normalized_display_name,
  'backfill',
  'high',
  true,
  true,
  jsonb_build_object('source_table', 'qbo_vendor_creations')
from public.bizzi_vendors v
where v.primary_evidence_type = 'qbo_vendor_id'
on conflict do nothing;

insert into public.business_qbo_vendor_mappings (
  business_id,
  realm_id,
  qbo_env,
  canonical_vendor_id,
  qbo_vendor_id,
  qbo_display_name,
  status,
  mapping_source,
  first_transaction_id,
  metadata
)
select distinct on (qvc.business_id, qvc.qbo_entity_id)
  qvc.business_id,
  coalesce((qvc.meta->>'realm_id'), 'unknown'),
  coalesce((qvc.meta->>'qbo_env'), 'production'),
  v.id,
  qvc.qbo_entity_id,
  qvc.vendor_name,
  'active',
  'backfill',
  qvc.source_transaction_id,
  jsonb_build_object('source_table', 'qbo_vendor_creations', 'requires_realm_confirmation', (qvc.meta->>'realm_id') is null)
from public.qbo_vendor_creations qvc
join public.bizzi_vendors v
  on v.business_id = qvc.business_id
 and v.primary_evidence_type = 'qbo_vendor_id'
 and v.primary_evidence_value = qvc.qbo_entity_id
where qvc.qbo_entity_type = 'vendor'
  and qvc.qbo_entity_id is not null
  and qvc.vendor_name is not null
on conflict do nothing;

insert into public.vendor_mapping_events (
  business_id,
  realm_id,
  qbo_env,
  canonical_vendor_id,
  qbo_vendor_id,
  qbo_display_name,
  event_type,
  source,
  transaction_id,
  actor,
  reason,
  metadata
)
select
  m.business_id,
  m.realm_id,
  m.qbo_env,
  m.canonical_vendor_id,
  m.qbo_vendor_id,
  m.qbo_display_name,
  'existing_qbo_vendor_reused',
  'backfill',
  m.first_transaction_id,
  'bizzi',
  'conservative_qbo_vendor_creation_backfill',
  m.metadata
from public.business_qbo_vendor_mappings m
where m.mapping_source = 'backfill'
on conflict do nothing;

update public.bank_transactions bt
   set canonical_vendor_id = v.id
from public.bizzi_vendors v
where bt.canonical_vendor_id is null
  and bt.business_id = v.business_id
  and bt.qbo_entity_type = 'vendor'
  and bt.qbo_entity_id = v.primary_evidence_value
  and v.primary_evidence_type = 'qbo_vendor_id';

alter table public.bizzi_vendors enable row level security;
alter table public.vendor_aliases enable row level security;
alter table public.business_qbo_vendor_mappings enable row level security;
alter table public.qbo_vendor_name_cache enable row level security;
alter table public.qbo_vendor_creation_intents enable row level security;
alter table public.vendor_mapping_events enable row level security;

revoke all on table public.bizzi_vendors from public;
revoke all on table public.vendor_aliases from public;
revoke all on table public.business_qbo_vendor_mappings from public;
revoke all on table public.qbo_vendor_name_cache from public;
revoke all on table public.qbo_vendor_creation_intents from public;
revoke all on table public.vendor_mapping_events from public;

revoke all on table public.bizzi_vendors from anon;
revoke all on table public.vendor_aliases from anon;
revoke all on table public.business_qbo_vendor_mappings from anon;
revoke all on table public.qbo_vendor_name_cache from anon;
revoke all on table public.qbo_vendor_creation_intents from anon;
revoke all on table public.vendor_mapping_events from anon;

revoke all on table public.bizzi_vendors from authenticated;
revoke all on table public.vendor_aliases from authenticated;
revoke all on table public.business_qbo_vendor_mappings from authenticated;
revoke all on table public.qbo_vendor_name_cache from authenticated;
revoke all on table public.qbo_vendor_creation_intents from authenticated;
revoke all on table public.vendor_mapping_events from authenticated;

grant all on table public.bizzi_vendors to service_role;
grant all on table public.vendor_aliases to service_role;
grant all on table public.business_qbo_vendor_mappings to service_role;
grant all on table public.qbo_vendor_name_cache to service_role;
grant all on table public.qbo_vendor_creation_intents to service_role;
grant all on table public.vendor_mapping_events to service_role;
