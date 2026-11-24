-- Read-only PRE-application capture. Preserve this JSON for verify.sql.
begin read only;
select jsonb_build_object(
 'signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
 'security_definer',p.prosecdef,'acl',to_jsonb(p.proacl),'configuration',to_jsonb(p.proconfig),
 'result',pg_get_function_result(p.oid),'volatility',p.provolatile,'language',l.lanname,
 'argument_names',to_jsonb(p.proargnames),'argument_defaults',pg_get_expr(p.proargdefaults,0)
) as expected_properties
from pg_proc p join pg_language l on l.oid=p.prolang
where p.oid=to_regprocedure('public.monthly_pending_resolution_summary(uuid,text,date,date)');
rollback;
