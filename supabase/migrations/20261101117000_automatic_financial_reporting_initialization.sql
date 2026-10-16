begin;

alter table public.business_financial_reporting_config_audit
  drop constraint if exists business_financial_reporting_config_audit_action_check;
alter table public.business_financial_reporting_config_audit
  add constraint business_financial_reporting_config_audit_action_check
  check (action in ('verify_qbo_identity','verify_currency','confirm_timezone','activate','invalidate','auto_initialize'));

create or replace function public.initialize_business_financial_reporting_config(
  p_business_id uuid,
  p_request_id uuid,
  p_verification_source text,
  p_provider_realm_id text,
  p_provider_schema_version text,
  p_provider_currency text,
  p_reporting_timezone text,
  p_timezone_source text,
  p_timezone_override boolean default false,
  p_actor_user_id uuid default null
) returns public.business_financial_reporting_config
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_config public.business_financial_reporting_config;
  v_active_realm text;
  v_timezone text;
  v_now timestamptz := now();
  v_previous_status text;
  v_resulting_status text;
begin
  if p_business_id is null or p_request_id is null then raise exception 'configuration_identity_required' using errcode='22023'; end if;
  if p_verification_source not in ('automatic_qbo_connection','automatic_quick_prompt','authorized_timezone_override') then raise exception 'verification_source_invalid' using errcode='22023'; end if;
  if p_timezone_source not in ('authorized_business_setting','existing_reporting_timezone','business_profile_inference','default_fallback') then raise exception 'timezone_source_invalid' using errcode='22023'; end if;
  if nullif(btrim(p_provider_realm_id),'') is null or nullif(btrim(p_provider_schema_version),'') is null then raise exception 'qbo_identity_verification_failed' using errcode='22023'; end if;
  if p_provider_currency !~ '^[A-Z]{3}$' then raise exception 'currency_verification_failed' using errcode='22023'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text, 0));
  select c.* into v_config from public.business_financial_reporting_config c where c.business_id=p_business_id for update;
  if exists(select 1 from public.business_financial_reporting_config_audit where business_id=p_business_id and request_id=p_request_id) then return v_config; end if;
  v_previous_status := v_config.status;

  select realm_id into v_active_realm from public.quickbooks_tokens
    where business_id=p_business_id and is_active=true and status='active'
    order by coalesce(last_connected_at,connected_at,created_at) desc nulls last limit 1;
  if nullif(btrim(v_active_realm),'') is null then raise exception 'qbo_identity_required' using errcode='22023'; end if;
  if p_provider_realm_id is distinct from v_active_realm then raise exception 'qbo_identity_verification_failed' using errcode='22023'; end if;

  if p_timezone_override then
    v_timezone := p_reporting_timezone;
  else
    v_timezone := coalesce(nullif(btrim(v_config.reporting_timezone),''), p_reporting_timezone);
  end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names() tz where tz.name=v_timezone) then raise exception 'timezone_confirmation_invalid' using errcode='22023'; end if;

  v_resulting_status := case when p_provider_currency='USD' then 'verified' else 'unsupported_currency' end;
  insert into public.business_financial_reporting_config(
    business_id,qbo_realm_id,provider_schema_version,reporting_timezone,home_currency,status,
    realm_verified_at,currency_verified_at,timezone_confirmed_at,verified_at,verification_source,
    invalidated_at,invalidation_reason,updated_at
  ) values (
    p_business_id,v_active_realm,btrim(p_provider_schema_version),v_timezone,p_provider_currency,
    case when p_provider_currency='USD' then 'verified' else 'unconfigured' end,
    v_now,v_now,v_now,case when p_provider_currency='USD' then v_now else null end,p_verification_source,
    null,null,v_now
  ) on conflict(business_id) do update set
    qbo_realm_id=excluded.qbo_realm_id,
    provider_schema_version=excluded.provider_schema_version,
    reporting_timezone=excluded.reporting_timezone,
    home_currency=excluded.home_currency,
    status=excluded.status,
    realm_verified_at=v_now,
    currency_verified_at=v_now,
    timezone_confirmed_at=v_now,
    verified_at=excluded.verified_at,
    verification_source=excluded.verification_source,
    invalidated_at=null,
    invalidation_reason=null,
    updated_at=v_now;

  insert into public.business_financial_reporting_config_audit(
    business_id,request_id,action,previous_status,resulting_status,verification_source,actor_user_id,details
  ) values (
    p_business_id,p_request_id,'auto_initialize',v_previous_status,v_resulting_status,p_verification_source,p_actor_user_id,
    jsonb_build_object(
      'currency_source','qbo_preferences','identity_source','qbo_company_info',
      'timezone_source',p_timezone_source,'timezone_override',p_timezone_override,
      'accounting_basis','Cash','supported_currency',p_provider_currency='USD'
    )
  );
  select c.* into v_config from public.business_financial_reporting_config c where c.business_id=p_business_id;
  return v_config;
end;
$$;

revoke all on function public.initialize_business_financial_reporting_config(uuid,uuid,text,text,text,text,text,text,boolean,uuid) from public, anon, authenticated;
grant execute on function public.initialize_business_financial_reporting_config(uuid,uuid,text,text,text,text,text,text,boolean,uuid) to service_role;

commit;
