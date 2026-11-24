-- POST-application, READ ONLY. psql -v expected_properties='<pre-capture JSON>'.
-- Missing baseline, false checks, no output, or any error means ABORT.
begin read only;
-- At most eight seconds; retain an already stricter session timeout.
select set_config('statement_timeout',case when setting::bigint=0 then '8000'
 else least(setting::bigint,8000)::text end,true)
from pg_settings where name='statement_timeout';

with target as (
 select p.*,jsonb_build_object(
  'signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
  'security_definer',p.prosecdef,'acl',to_jsonb(p.proacl),'configuration',to_jsonb(p.proconfig),
  'result',pg_get_function_result(p.oid),'volatility',p.provolatile,'language',l.lanname,
  'argument_names',to_jsonb(p.proargnames),'argument_defaults',pg_get_expr(p.proargdefaults,0)
 ) properties from pg_proc p join pg_language l on l.oid=p.prolang
 where p.oid=to_regprocedure('public.monthly_pending_resolution_summary(uuid,text,date,date)')
), checks as (
 select
 (select array_agg(version::text order by version) from supabase_migrations.schema_migrations)=
 array['20260808174146','20261111220000','20261117230000','20261118220000','20261118230000',
       '20261120220000','20261120233000','20261123230000','20261124000000','20261124010000'] as exact_ledger,
 exists(select 1 from supabase_migrations.schema_migrations where version='20261124010000'
  and name='bound_monthly_pending_summary_candidates') as migration_recorded,
 coalesce((select properties=:'expected_properties'::jsonb and pg_get_function_result(oid)='jsonb' from target),false) as properties_unchanged,
 coalesce((select position('r.business_id=eligible.business_id and r.plaid_env=eligible.plaid_env' in prosrc)>0
  and position('not r.is_archived and r.pending is false and r.pending_canonical_transaction_id is null' in prosrc)>0
  and position('r.pending_transaction_id=coalesce(eligible.pending_resolution_payload->>''original_plaid_transaction_id'',eligible.plaid_transaction_id)' in prosrc)>0
  and position('round(r.amount,2)=round(eligible.amount,2)' in prosrc)>0
  and position('abs(coalesce(eligible.authorized_date,eligible.date)-coalesce(r.authorized_date,r.date))<=7' in prosrc)>0 from target),false) as candidate_bounds_installed,
 coalesce((select position('public.pending_replacement_candidate(source,r)' in prosrc)>0 from target),false)
  and to_regprocedure('public.pending_replacement_candidate(public.bank_transactions,public.bank_transactions)') is not null as authority_retained
)
select *,exact_ledger and migration_recorded and properties_unchanged and candidate_bounds_installed and authority_retained as all_checks_pass,
 (select properties from target) as actual_properties from checks;

-- Same tenant/month/account-null scope as the diagnosed MRP counts endpoint.
-- No rows, descriptions, documents or provider data are returned.
with started as materialized (select clock_timestamp() as at),
populations as materialized (
 select started.at,
  (select jsonb_object_agg(s,public.count_bookkeeping_transactions_bounded(
    'cffc2183-e77c-4148-a206-d5192e090925'::uuid,s,null,'2026-11-01','2026-12-01'))
   from unnest(array['needs_review','handled','posted','matched','pending','excluded']) s) as counts,
  public.monthly_pending_resolution_summary('cffc2183-e77c-4148-a206-d5192e090925'::uuid,null,'2026-11-01','2026-12-01') as pending_summary
 from started
), finished as materialized (select *,clock_timestamp()-at as elapsed from populations)
select counts,pending_summary,elapsed,current_setting('statement_timeout') as statement_timeout,
 elapsed<interval '8 seconds' as completed_within_eight_seconds,
 (select array_agg(key order by key) from jsonb_object_keys(pending_summary) key)=
  array['operator_action_required','recent_pending','replacement_found','stale_pending']
 and (select bool_and(jsonb_typeof(value)='number' and value::text::numeric>=0) from jsonb_each(pending_summary)) as summary_result_contract_valid
from finished;
rollback;
