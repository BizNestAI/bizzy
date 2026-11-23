-- Read-only pre-application baseline. Save output outside the database and compare with verify.sql.
begin read only;
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

rollback;
