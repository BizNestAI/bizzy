begin;

alter table public.bizzy_memory
  add column if not exists business_id uuid null references public.business_profiles(id) on delete cascade;

create index if not exists bizzy_memory_business_user_created_idx
  on public.bizzy_memory (business_id, user_id, created_at desc)
  where business_id is not null;

drop policy if exists bizzy_memory_own_user_select on public.bizzy_memory;
create policy bizzy_memory_business_member_select
on public.bizzy_memory for select to authenticated
using (
  business_id is not null
  and user_id = auth.uid()
  and public.is_member(auth.uid(), business_id)
);

drop function if exists public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]);
create function public.match_bizzy_memory(
  user_uuid uuid,
  business_uuid uuid,
  query_embedding public.vector,
  match_threshold double precision default 0.75,
  match_count integer default 3,
  tag_filter text[] default null
)
returns table(id uuid, input_text text, bizzy_response text, tags text[], kpis jsonb, similarity double precision)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select bm.id, bm.input_text, bm.bizzy_response, bm.tags, bm.kpis,
    1 - (bm.embedding <=> query_embedding) as similarity
  from public.bizzy_memory bm
  where bm.user_id = user_uuid
    and bm.business_id = business_uuid
    and bm.business_id is not null
    and bm.embedding is not null
    and (tag_filter is null or bm.tags && tag_filter)
    and (1 - (bm.embedding <=> query_embedding)) >= match_threshold
  order by bm.embedding <=> query_embedding asc
  limit match_count;
$$;

revoke all on function public.match_bizzy_memory(uuid, uuid, public.vector, double precision, integer, text[]) from public, anon, authenticated;
grant execute on function public.match_bizzy_memory(uuid, uuid, public.vector, double precision, integer, text[]) to service_role;

alter table public.gpt_messages
  add column if not exists message_kind text not null default 'conversation';
alter table public.gpt_messages
  drop constraint if exists gpt_messages_message_kind_check;
alter table public.gpt_messages
  add constraint gpt_messages_message_kind_check
  check (message_kind in ('conversation', 'operational_error'));
create index if not exists gpt_messages_thread_conversation_idx
  on public.gpt_messages (thread_id, created_at desc)
  where message_kind = 'conversation';

commit;
