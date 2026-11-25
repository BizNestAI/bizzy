begin read only;
select version,name from supabase_migrations.schema_migrations where version='20261124050000';
select p.oid::regprocedure as signature,pg_get_userbyid(p.proowner) as owner,p.prosecdef,p.proconfig,p.proacl,
 has_function_privilege('service_role',p.oid,'execute') as service_execute,
 not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute') as customers_denied,
 position('undone_split_recovery_active_claim' in p.prosrc)>0 as active_claim_fence,
 position('provider_evidence_requires_reconciliation' in p.prosrc)>0 as provider_fence,
 position('undone_split_recovery_not_finalized' in p.prosrc)>0 as atomic_result_fence
from pg_proc p where p.oid=to_regprocedure('public.reconcile_undone_split_pre_provider(uuid,uuid,uuid,jsonb,jsonb,text)');
rollback;
