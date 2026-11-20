-- Read-only supplement to the public catalog export. No password/token fields.
-- Verify the project in the authenticated dashboard before running this query.
begin transaction read only;
set local lock_timeout='2s';
set local statement_timeout='30s';
select jsonb_build_object(
 'captured_at',statement_timestamp(),'database',current_database(),
 'columns',(select jsonb_agg(jsonb_build_object(
  'relation',c.oid::regclass::text,'name',a.attname,'ordinal',a.attnum,
  'acl',a.attacl,'type',format_type(a.atttypid,a.atttypmod),
  'collation',case when a.attcollation<>0 then a.attcollation::regcollation::text end))
  from pg_attribute a join pg_class c on c.oid=a.attrelid
  where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped),
 'roles',(select jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,
  'inherit',rolinherit,'create_role',rolcreaterole,'create_db',rolcreatedb,
  'login',rolcanlogin,'replication',rolreplication,'bypass_rls',rolbypassrls,
  'config',(select jsonb_agg(setting) from unnest(rolconfig) setting where setting ~ '^(search_path|statement_timeout|lock_timeout|idle_in_transaction_session_timeout|row_security|default_transaction_read_only|pgrst\.db_schemas|pgrst\.db_extra_search_path|pgrst\.db_pre_request)='))) from pg_roles where rolname !~ '^pg_'),
 'memberships',(select jsonb_agg(jsonb_build_object('role',r.rolname,'member',u.rolname,
  'grantor',g.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option))
  from pg_auth_members m join pg_roles r on r.oid=m.roleid
  join pg_roles u on u.oid=m.member join pg_roles g on g.oid=m.grantor),
 'schemas',(select jsonb_agg(jsonb_build_object('name',nspname,
  'owner',pg_get_userbyid(nspowner),'acl',nspacl)) from pg_namespace
  where nspname in ('public','auth','extensions')),
 'external_auth_uid',(select jsonb_build_object('definition',pg_get_functiondef(p.oid),
  'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig)
  from pg_proc p where p.oid=to_regprocedure('auth.uid()')),
 'enums',(select jsonb_agg(jsonb_build_object('type',t.oid::regtype::text,
  'label',e.enumlabel,'sort_order',e.enumsortorder)) from pg_enum e join pg_type t on t.oid=e.enumtypid
  where t.typnamespace='public'::regnamespace),
 'extensions',(select jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,
  'schema',n.nspname)) from pg_extension e join pg_namespace n on n.oid=e.extnamespace),
 'relation_kinds',(select jsonb_agg(jsonb_build_object('relation',c.oid::regclass::text,
  'kind',c.relkind)) from pg_class c where c.relnamespace='public'::regnamespace
  and c.relkind in ('r','p','v','m')),
 'sequences',(select jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,
  'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,'type',format_type(s.seqtypid,null),
  'start',s.seqstart,'increment',s.seqincrement,'min',s.seqmin,'max',s.seqmax,
  'cache',s.seqcache,'cycle',s.seqcycle)) from pg_sequence s join pg_class c on c.oid=s.seqrelid
  where c.relnamespace='public'::regnamespace),
 'default_acls',(select jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(a.defaclrole),
  'schema',case when a.defaclnamespace<>0 then a.defaclnamespace::regnamespace::text end,
  'object_type',a.defaclobjtype,'acl',a.defaclacl)) from pg_default_acl a
  where a.defaclnamespace in (0,'public'::regnamespace::oid))
);
rollback;
