begin;

alter table public.bizzy_memory
  add column if not exists memory_kind text null,
  add column if not exists memory_key text null,
  add column if not exists policy_version text null,
  add column if not exists source_thread_id uuid null references public.gpt_threads(id) on delete set null,
  add column if not exists source_message_id uuid null references public.gpt_messages(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

alter table public.bizzy_memory
  drop constraint if exists bizzy_memory_kind_check;
alter table public.bizzy_memory
  add constraint bizzy_memory_kind_check check (
    memory_kind is null or memory_kind in (
      'communication_preference',
      'operating_preference',
      'business_rule',
      'long_term_goal',
      'terminology_preference'
    )
  );

create unique index if not exists bizzy_memory_durable_identity_idx
  on public.bizzy_memory (user_id, business_id, memory_kind, memory_key);

drop function if exists public.match_bizzy_memory(uuid, uuid, public.vector, double precision, integer, text[]);
create function public.match_bizzy_memory(
  user_uuid uuid,
  business_uuid uuid,
  query_embedding public.vector,
  match_threshold double precision default 0.75,
  match_count integer default 3,
  tag_filter text[] default null
)
returns table(
  id uuid,
  input_text text,
  bizzy_response text,
  tags text[],
  kpis jsonb,
  similarity double precision,
  memory_kind text,
  policy_version text
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select bm.id, bm.input_text, bm.bizzy_response, bm.tags, bm.kpis,
    1 - (bm.embedding <=> query_embedding) as similarity,
    bm.memory_kind, bm.policy_version
  from public.bizzy_memory bm
  where bm.user_id = user_uuid
    and bm.business_id = business_uuid
    and bm.business_id is not null
    and bm.embedding is not null
    and bm.policy_version = 'durable-memory-v1'
    and bm.memory_kind in (
      'communication_preference',
      'operating_preference',
      'business_rule',
      'long_term_goal',
      'terminology_preference'
    )
    and (tag_filter is null or bm.tags && tag_filter)
    and (1 - (bm.embedding <=> query_embedding)) >= match_threshold
  order by bm.embedding <=> query_embedding asc
  limit match_count;
$$;

revoke all on function public.match_bizzy_memory(uuid, uuid, public.vector, double precision, integer, text[]) from public, anon, authenticated;
grant execute on function public.match_bizzy_memory(uuid, uuid, public.vector, double precision, integer, text[]) to service_role;

commit;
