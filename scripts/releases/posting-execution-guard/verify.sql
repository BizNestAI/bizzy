-- Read-only AFTER any separately authorized application. Compare metadata with
-- the pre-application export; only this function's body should change.
begin read only;
select version,name from supabase_migrations.schema_migrations where version='20261124000000';
select p.oid::regprocedure as signature,pg_get_userbyid(p.proowner) as owner,
 p.proacl,p.prosecdef,p.provolatile,p.proconfig,
 position('or b.direction is null or b.direction not in (''OUTFLOW'',''INFLOW'')' in p.prosrc)>0 as direction_guard,
 position('or coalesce(x->>''taxonomy_type'','''') not in (''loan_payment'',''statement_credit'',''cc_payment'')' in p.prosrc)>0 as taxonomy_guard,
 position('shape:=public.canonical_posting_shape(c,p_env);' in p.prosrc)>0 as canonical_retained,
 position('posting_shape_changed' in p.prosrc)>0 as binding_retained,
 position('public.statement_pending_authority(b)' in p.prosrc)>0 as statement_authority_retained,
 position('foreign_or_stale_posting_lease' in p.prosrc)>0 as lease_guard_retained,
 position('ambiguous_prior_attempt' in p.prosrc)>0 as attempt_guard_retained
from pg_proc p where p.oid=to_regprocedure('public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)');
rollback;
