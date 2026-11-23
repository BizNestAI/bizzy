-- Run only in the operator-verified zwufvvrmjbymgyjntdzk SQL editor.
-- The project_ref below is attribution supplied by the operator, not proof from PostgreSQL.
begin read only;
select jsonb_pretty(jsonb_build_object(
 'project_ref','zwufvvrmjbymgyjntdzk',
 'captured_at',statement_timestamp(),
 'read_only_planning',true,
 'source','Operator-verified project SQL editor; read-only ledger capture',
 'migration_history',(select jsonb_agg(jsonb_build_object('version',version,'name',name) order by version)
   from supabase_migrations.schema_migrations)
));
rollback;
