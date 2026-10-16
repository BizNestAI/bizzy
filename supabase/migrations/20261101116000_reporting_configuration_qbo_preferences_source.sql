begin;

-- Additive provenance expansion only. Existing configuration and audit rows are
-- preserved; the function signature and mutation lifecycle remain unchanged.
create or replace function public.mutate_business_financial_reporting_config(
  p_business_id uuid,p_action text,p_request_id uuid,p_verification_source text,
  p_provider_realm_id text default null,p_provider_schema_version text default null,
  p_provider_currency text default null,p_reporting_timezone text default null,p_actor_user_id uuid default null
) returns public.business_financial_reporting_config
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_config public.business_financial_reporting_config;
  v_active_realm text;
  v_now timestamptz := now();
  v_previous_status text;
  v_resulting_status text;
  v_canonical_timezone text;
begin
  if p_business_id is null or p_request_id is null then raise exception 'configuration_identity_required' using errcode='22023'; end if;
  if p_action not in ('verify_qbo_identity','verify_currency','confirm_timezone','activate','invalidate') then raise exception 'configuration_action_invalid' using errcode='22023'; end if;
  if nullif(btrim(p_verification_source),'') is null then raise exception 'verification_source_required' using errcode='22023'; end if;
  select c.* into v_config from public.business_financial_reporting_config c where c.business_id=p_business_id for update;
  if exists(select 1 from public.business_financial_reporting_config_audit where business_id=p_business_id and request_id=p_request_id) then return v_config; end if;
  v_previous_status := v_config.status;
  select realm_id into v_active_realm from public.quickbooks_tokens
    where business_id=p_business_id and is_active=true and status='active'
    order by coalesce(last_connected_at,connected_at,created_at) desc nulls last limit 1;
  if p_action <> 'invalidate' and nullif(btrim(v_active_realm),'') is null then raise exception 'qbo_identity_required' using errcode='22023'; end if;

  if p_action='verify_qbo_identity' then
    if p_verification_source not in ('qbo_company_info','qbo_preferences','qbo_report_header') or p_provider_realm_id is distinct from v_active_realm or nullif(btrim(p_provider_schema_version),'') is null then
      raise exception 'qbo_identity_verification_failed' using errcode='22023';
    end if;
    insert into public.business_financial_reporting_config(business_id,qbo_realm_id,provider_schema_version,realm_verified_at,status,verified_at,invalidated_at,invalidation_reason,updated_at)
      values(p_business_id,v_active_realm,btrim(p_provider_schema_version),v_now,'unconfigured',null,null,null,v_now)
      on conflict(business_id) do update set qbo_realm_id=excluded.qbo_realm_id,provider_schema_version=excluded.provider_schema_version,
        realm_verified_at=v_now,status='unconfigured',verified_at=null,invalidated_at=null,invalidation_reason=null,updated_at=v_now;
  elsif p_action='verify_currency' then
    if p_verification_source not in ('qbo_company_info','qbo_preferences','qbo_report_header') or v_config.qbo_realm_id is distinct from v_active_realm or p_provider_realm_id is distinct from v_active_realm or p_provider_currency !~ '^[A-Z]{3}$' then
      raise exception 'currency_verification_failed' using errcode='22023';
    end if;
    update public.business_financial_reporting_config set home_currency=p_provider_currency,currency_verified_at=v_now,status='unconfigured',verified_at=null,updated_at=v_now where business_id=p_business_id;
  elsif p_action='confirm_timezone' then
    if p_verification_source <> 'authorized_business_setting' or nullif(btrim(p_reporting_timezone),'') is null then raise exception 'timezone_confirmation_invalid' using errcode='22023'; end if;
    select tz.name into v_canonical_timezone
      from pg_catalog.pg_timezone_names() tz
      where pg_catalog.lower(tz.name)=pg_catalog.lower(pg_catalog.btrim(p_reporting_timezone))
      order by (tz.name=pg_catalog.btrim(p_reporting_timezone)) desc, tz.name
      limit 1;
    if v_canonical_timezone is null then raise exception 'timezone_confirmation_invalid' using errcode='22023'; end if;
    update public.business_financial_reporting_config set reporting_timezone=v_canonical_timezone,timezone_confirmed_at=v_now,status='unconfigured',verified_at=null,updated_at=v_now where business_id=p_business_id;
  elsif p_action='activate' then
    select tz.name into v_canonical_timezone
      from pg_catalog.pg_timezone_names() tz
      where tz.name=v_config.reporting_timezone
      limit 1;
    if v_config.qbo_realm_id is distinct from v_active_realm or nullif(btrim(v_config.provider_schema_version),'') is null or
       v_config.realm_verified_at is null or v_config.home_currency !~ '^[A-Z]{3}$' or v_config.currency_verified_at is null or
       v_canonical_timezone is null or v_config.timezone_confirmed_at is null then
      raise exception 'reporting_configuration_incomplete' using errcode='22023';
    end if;
    update public.business_financial_reporting_config set status='verified',verified_at=v_now,verification_source=p_verification_source,invalidated_at=null,invalidation_reason=null,updated_at=v_now where business_id=p_business_id;
  else
    insert into public.business_financial_reporting_config(business_id,status,invalidated_at,invalidation_reason,updated_at)
      values(p_business_id,'invalidated',v_now,p_verification_source,v_now)
      on conflict(business_id) do update set status='invalidated',verified_at=null,invalidated_at=v_now,invalidation_reason=p_verification_source,updated_at=v_now;
  end if;
  select c.* into v_config from public.business_financial_reporting_config c where c.business_id=p_business_id;
  v_resulting_status := case when v_config.status='invalidated' then 'invalidated'
    when v_config.qbo_realm_id is null or v_config.realm_verified_at is null or nullif(btrim(v_config.provider_schema_version),'') is null then 'qbo_identity_required'
    when v_config.home_currency is null or v_config.currency_verified_at is null then 'currency_verification_required'
    when v_config.reporting_timezone is null or v_config.timezone_confirmed_at is null then 'timezone_confirmation_required'
    when v_config.status='verified' then 'verified' else 'timezone_confirmation_required' end;
  insert into public.business_financial_reporting_config_audit(business_id,request_id,action,previous_status,resulting_status,verification_source,actor_user_id,details)
    values(p_business_id,p_request_id,p_action,v_previous_status,v_resulting_status,p_verification_source,p_actor_user_id,
      jsonb_build_object('active_qbo_realm_verified',v_active_realm is not null,'provider_identity_supplied',p_provider_realm_id is not null));
  return v_config;
end;
$$;

revoke all on function public.mutate_business_financial_reporting_config(uuid,text,uuid,text,text,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.mutate_business_financial_reporting_config(uuid,text,uuid,text,text,text,text,text,uuid) to service_role;

commit;
