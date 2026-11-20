-- OPERATOR READ-ONLY EXPORT. No application tables/rows, tokens or providers.
-- Run against zwufvvrmjbymgyjntdzk and save the JSON result locally.
-- Required to refresh the dated partial catalog fixture before release approval.
begin transaction read only;
set local lock_timeout='2s';
set local statement_timeout='30s';
select jsonb_build_object(
 'database',current_database(),'captured_at',statement_timestamp(),
 'functions',(select jsonb_agg(jsonb_build_object(
   'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
   'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig,
   'security_definer',p.prosecdef,'volatility',p.provolatile,'parallel',p.proparallel))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind in ('f','p')),
 'relations',(select jsonb_agg(jsonb_build_object(
   'name',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,
   'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions,
   'view',case when c.relkind in ('v','m') then pg_get_viewdef(c.oid,true) end))
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p','v','m')),
 'columns',(select jsonb_agg(jsonb_build_object(
   'relation',a.attrelid::regclass::text,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
   'default',pg_get_expr(d.adbin,d.adrelid)))
  from pg_attribute a join pg_class c on c.oid=a.attrelid
  join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname='public' and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(jsonb_build_object('relation',conrelid::regclass::text,
   'name',conname,'definition',pg_get_constraintdef(oid,true),'validated',convalidated))
  from pg_constraint where connamespace='public'::regnamespace),
 'indexes',(select jsonb_agg(jsonb_build_object('relation',i.indrelid::regclass::text,
   'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid))
  from pg_index i join pg_class c on c.oid=i.indrelid where c.relnamespace='public'::regnamespace),
 'triggers',(select jsonb_agg(jsonb_build_object('relation',t.tgrelid::regclass::text,
   'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true)))
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where not t.tgisinternal and c.relnamespace='public'::regnamespace),
 'policies',(select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname='public'),
 'default_acls',(select jsonb_agg(to_jsonb(a)) from pg_default_acl a
  where a.defaclnamespace in (0,'public'::regnamespace::oid)),
 'dependencies',(select jsonb_agg(jsonb_build_object('object',pg_describe_object(d.classid,d.objid,d.objsubid),
  'depends_on',pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid),'type',d.deptype))
  from pg_depend d where d.classid='pg_proc'::regclass and d.objid in
  (select oid from pg_proc where pronamespace='public'::regnamespace)),
 'migration_history',(select jsonb_agg(jsonb_build_object('version',version,'name',name) order by version)
  from supabase_migrations.schema_migrations)
);
rollback;
