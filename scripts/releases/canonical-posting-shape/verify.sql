-- Read-only post-application inspection. Every required row/check must exist and pass.
-- Compare owner/ACL/configuration with a pre-application export of these queries.
begin read only;
select version,name from supabase_migrations.schema_migrations where version='20261123230000';

with required(signature,service_execute) as (values
 ('public.canonical_manual_posting_identity(uuid,uuid,text,text,text,text)',false),
 ('public.assert_canonical_manual_actor(uuid,uuid,text)',false),
 ('public.canonical_approval_renewal_context(uuid,uuid,text,uuid,text,text)',true),
 ('public.validate_canonical_approval_renewal(public.transaction_categorizations,jsonb,uuid,text)',false),
 ('public.inspect_existing_split_schedule(uuid,uuid,text)',true),
 ('public.bind_existing_split_schedule(uuid,uuid,uuid,text,timestamp with time zone,uuid,text)',true),
 ('public.canonical_posting_shape(public.transaction_categorizations,text)',false),
 ('public.canonical_posting_eligibility(uuid,uuid,text,text)',true),
 ('public.bind_canonical_posting_schedule()',false),
 ('public.serialize_confirmed_split_edit()',false),
 ('public.return_posting_to_review(uuid,uuid,timestamp with time zone,text)',true)
)
select r.signature,p.oid is not null as installed,pg_get_userbyid(p.proowner) as owner,
 p.prosecdef as security_definer,p.proconfig,
 case when p.oid is not null then not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute') else false end as browser_execute_denied,
 case when p.oid is not null then has_function_privilege('service_role',p.oid,'execute')=r.service_execute else false end as service_privilege_matches,
 case when p.oid is not null then not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') else false end as public_execute_denied
from required r left join pg_proc p on p.oid=to_regprocedure(r.signature);

with checks(label,signature,marker) as (values
 ('canonical SQL compiler','public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)','public.canonical_posting_shape'),
 ('split execution binding','public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)','posting_shape_changed'),
 ('statement settlement authority retained','public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)','public.statement_pending_authority(b)'),
 ('admission material fingerprint','public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamp with time zone,text,timestamp with time zone,uuid,date,text)','public.canonical_posting_shape'),
 ('admission statement fence retained','public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamp with time zone,text,timestamp with time zone,uuid,date,text)','public.lock_statement_pending_ids'),
 ('execution delegates to technical guard','public.check_auto_post_technical_integrity(uuid,uuid,text,jsonb)','public.auto_post_technical_block'),
 ('split account validation','public.canonical_posting_shape(public.transaction_categorizations,text)','invalid_split_account'),
 ('split balance validation','public.canonical_posting_shape(public.transaction_categorizations,text)','split_transaction_total_mismatch'),
 ('split approval snapshot','public.serialize_confirmed_split_edit()','approved_material'),
 ('fresh approval lifecycle epoch','public.canonical_approval_renewal_context(uuid,uuid,text,uuid,text,text)','review_reopened_at'),
 ('fresh approval identity validation','public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)','public.validate_canonical_approval_renewal'),
 ('non-rescheduling binding','public.bind_existing_split_schedule(uuid,uuid,uuid,text,timestamp with time zone,uuid,text)','existing_schedule_was_modified'),
 ('binding job unchanged','public.sync_bookkeeping_posting_job()','existing_schedule_binding'),
 ('split claim serialization','public.serialize_confirmed_split_edit()','split_posting_in_progress'),
 ('atomic documented reopen','public.return_posting_to_review(uuid,uuid,timestamp with time zone,text)','review_reopen_authorized'),
 ('posting lock exclusion fence','public.acquire_posting_lock(uuid,uuid,timestamp with time zone,integer,text)','public.lock_bookkeeping_exclusion_identity'),
 ('posting claim exclusion fence','public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamp with time zone,integer)','public.lock_bookkeeping_exclusion_identity'),
 ('exclusion account fence','public.lock_bookkeeping_exclusion_identity(uuid,uuid)','public.lock_statement_pending_account')
)
select c.label,p.oid is not null as installed,coalesce(position(c.marker in p.prosrc)>0,false) as marker_present
from checks c left join pg_proc p on p.oid=to_regprocedure(c.signature);

select n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and t.tgname in ('a_bind_canonical_posting_schedule','a_serialize_confirmed_split_edit');

-- Existing fences: capture before application and compare afterward. Only
-- auto_post_technical_block, admit_handled_auto_post, approve_bookkeeping_with_admission
-- and sync_bookkeeping_posting_job bodies should change.
with required(signature) as (values
 ('public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)'),
 ('public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamp with time zone,text,timestamp with time zone,uuid,date,text)'),
 ('public.sync_bookkeeping_posting_job()'),
 ('public.check_auto_post_technical_integrity(uuid,uuid,text,jsonb)'),
 ('public.acquire_posting_lock(uuid,uuid,timestamp with time zone,integer,text)'),
 ('public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamp with time zone,integer)'),
 ('public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)'),
 ('public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text)'),
 ('public.exclude_handled_bookkeeping_transaction(uuid,uuid,text,text,text,text)'),
 ('public.statement_pending_authority(public.bank_transactions,boolean)'),
 ('public.check_statement_pending_posting(uuid,uuid,jsonb)'),
 ('public.lock_statement_pending_ids(uuid,uuid[])'),
 ('public.lock_bookkeeping_exclusion_identity(uuid,uuid)')
)
select r.signature,p.oid is not null as installed,pg_get_userbyid(p.proowner) as owner,
 p.proacl,p.proconfig,p.prosecdef,p.provolatile,
 case when p.oid is not null then md5(pg_get_functiondef(p.oid)) end as definition_fingerprint
from required r left join pg_proc p on p.oid=to_regprocedure(r.signature);

select is_nullable='NO' as decided_by_still_not_null from information_schema.columns
where table_schema='public' and table_name='transaction_categorizations' and column_name='decided_by';
select prosrc !~* 'decided_by[[:space:]]*=[[:space:]]*null' as return_preserves_not_null_actor,
 position('updated_at=p_updated_at' in prosrc)>0 as return_uses_compare_and_swap,
 position('for update' in lower(prosrc))>0 as return_locks_identity
from pg_proc where oid=to_regprocedure('public.return_posting_to_review(uuid,uuid,timestamp with time zone,text)');
rollback;
