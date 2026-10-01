-- Read-only Bizzi memory schema verification. This statement reads catalogs
-- only and returns explicit PASS/FAIL checks followed by FINAL VERDICT.
with
rpc as (
  select p.oid, p.prosecdef, p.proowner, p.proconfig,
    pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.oid = to_regprocedure('public.match_bizzy_memory(uuid,uuid,public.vector,double precision,integer,text[])')
),
checks(check_name, passed, evidence) as (
  values
    ('column: bizzy_memory.business_id uuid nullable', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='bizzy_memory' and column_name='business_id' and data_type='uuid' and is_nullable='YES'
    ), 'runtime tenant scope'),
    ('column: bizzy_memory.memory_kind text nullable', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='bizzy_memory' and column_name='memory_kind' and data_type='text' and is_nullable='YES'
    ), 'durable category'),
    ('column: bizzy_memory.memory_key text nullable', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='bizzy_memory' and column_name='memory_key' and data_type='text' and is_nullable='YES'
    ), 'supersession key'),
    ('column: bizzy_memory.policy_version text nullable', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='bizzy_memory' and column_name='policy_version' and data_type='text' and is_nullable='YES'
    ), 'retrieval policy gate'),
    ('column: bizzy_memory.updated_at timestamptz not null default', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='bizzy_memory' and column_name='updated_at' and data_type='timestamp with time zone' and is_nullable='NO' and column_default is not null
    ), 'supersession timestamp'),
    ('column: gpt_messages.message_kind constrained text', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='gpt_messages' and column_name='message_kind' and data_type='text' and is_nullable='NO' and column_default is not null
    ), 'operational-message exclusion'),
    ('column: gpt_messages.structured_references jsonb', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='gpt_messages' and column_name='structured_references' and data_type='jsonb'
    ), 'bounded continuity'),
    ('column: gpt_messages.message_role_position smallint not null', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='gpt_messages' and column_name='message_role_position' and data_type='smallint' and is_nullable='NO'
    ), 'deterministic role ordering'),
    ('column: gpt_messages.message_sequence bigint identity', exists (
      select 1 from information_schema.columns where table_schema='public' and table_name='gpt_messages' and column_name='message_sequence' and data_type='bigint' and is_identity='YES'
    ), 'stable ordering tie-breaker'),
    ('constraint: durable memory kinds', exists (
      select 1 from pg_constraint where conrelid='public.bizzy_memory'::regclass and conname='bizzy_memory_kind_check' and pg_get_constraintdef(oid) like '%communication_preference%'
    ), 'approved durable categories'),
    ('constraint: message kinds', exists (
      select 1 from pg_constraint where conrelid='public.gpt_messages'::regclass and conname='gpt_messages_message_kind_check' and pg_get_constraintdef(oid) like '%operational_error%'
    ), 'conversation or operational error'),
    ('constraint: message role positions', exists (
      select 1 from pg_constraint where conrelid='public.gpt_messages'::regclass and conname='gpt_messages_role_position_check'
    ), 'positions 0, 1, or 2'),
    ('index: tenant-scoped durable identity unique', exists (
      select 1 from pg_indexes where schemaname='public' and indexname='bizzy_memory_durable_identity_idx' and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%user_id, business_id, memory_kind, memory_key%'
    ), 'user and business supersession scope'),
    ('index: deterministic conversation order', exists (
      select 1 from pg_indexes where schemaname='public' and indexname='gpt_messages_thread_conversation_order_idx' and indexdef like '%message_role_position%' and indexdef like '%message_sequence%'
    ), 'thread history ordering'),
    ('foreign keys: source thread/message set null', (
      select count(*)=2 from pg_constraint where conrelid='public.bizzy_memory'::regclass and conname in ('bizzy_memory_source_thread_id_fkey','bizzy_memory_source_message_id_fkey') and confdeltype='n'
    ), 'durable facts survive source deletion'),
    ('foreign key: business deletion cascades', exists (
      select 1 from pg_constraint where conrelid='public.bizzy_memory'::regclass and conname='bizzy_memory_business_id_fkey' and confdeltype='c'
    ), 'business erasure'),
    ('RLS: bizzy_memory enabled', exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='bizzy_memory' and c.relrowsecurity
    ), 'row security enabled'),
    ('policy: own user and business membership', exists (
      select 1 from pg_policies where schemaname='public' and tablename='bizzy_memory' and policyname='bizzy_memory_business_member_select' and cmd='SELECT' and qual like '%user_id = auth.uid()%' and qual like '%is_member(auth.uid(), business_id)%'
    ), 'authenticated direct-read isolation'),
    ('RPC: exact signature exists once', (select count(*)=1 from rpc), 'business-aware vector matcher'),
    ('RPC: security definer', coalesce((select bool_and(prosecdef) from rpc), false), 'privileged bounded matcher'),
    ('RPC: owner postgres', coalesce((select bool_and(pg_get_userbyid(proowner)='postgres') from rpc), false), 'expected owner'),
    ('RPC: fixed safe search_path', coalesce((select bool_and(proconfig @> array['search_path=pg_catalog, public']) from rpc), false), 'pg_catalog, public'),
    ('RPC: mandatory user/business filters', coalesce((select bool_and(definition like '%bm.user_id = user_uuid%' and definition like '%bm.business_id = business_uuid%') from rpc), false), 'tenant row filters'),
    ('RPC: membership or ownership validation', coalesce((select bool_and(definition like '%business_profiles%' and definition like '%user_business_link%' and definition like '%bp.user_id = user_uuid%' and definition like '%ubl.user_id = user_uuid%') from rpc), false), 'database consistency defense'),
    ('RPC: durable policy filters', coalesce((select bool_and(definition like '%durable-memory-v1%' and definition like '%communication_preference%' and definition like '%terminology_preference%') from rpc), false), 'version and kind restrictions'),
    ('RPC grant: service_role execute', coalesce((select bool_and(has_function_privilege('service_role', oid, 'EXECUTE')) from rpc), false), 'server-only execution'),
    ('RPC grant: anon denied', coalesce((select bool_and(not has_function_privilege('anon', oid, 'EXECUTE')) from rpc), false), 'no anonymous execution'),
    ('RPC grant: authenticated denied', coalesce((select bool_and(not has_function_privilege('authenticated', oid, 'EXECUTE')) from rpc), false), 'no browser execution'),
    ('RPC grant: PUBLIC denied', coalesce((select bool_and(not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee=0 and acl.privilege_type='EXECUTE'
    )) from rpc r join pg_proc p on p.oid=r.oid), false), 'no implicit execution')
),
results as (
  select check_name, case when passed then 'PASS' else 'FAIL' end as result, evidence
  from checks
),
final as (
  select 'FINAL VERDICT'::text as check_name,
    case when bool_and(passed) then 'PASS' else 'FAIL' end as result,
    format('%s passed; %s failed', count(*) filter (where passed), count(*) filter (where not passed)) as evidence
  from checks
)
select * from results
union all
select * from final
order by case when check_name='FINAL VERDICT' then 1 else 0 end, check_name;
