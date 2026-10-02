create table if not exists public.vendor_rule_learning_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  transaction_id uuid not null,
  actor_id uuid,
  actor_type text not null default 'user',
  status text not null default 'pending' check (status in ('pending','processing','completed','failed','dead_letter')),
  attempt_count integer not null default 0,
  last_error text,
  process_after timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_rule_learning_jobs_transaction_fkey
    foreign key (business_id, transaction_id)
    references public.bank_transactions(business_id, id) on delete cascade,
  constraint vendor_rule_learning_jobs_business_transaction_uq unique (business_id, transaction_id)
);

create index if not exists vendor_rule_learning_jobs_due_idx
  on public.vendor_rule_learning_jobs(process_after, business_id)
  where status in ('pending','failed');

alter table public.vendor_rule_learning_jobs enable row level security;
revoke all on public.vendor_rule_learning_jobs from public, anon, authenticated;
grant all on public.vendor_rule_learning_jobs to service_role;

create or replace function public.claim_vendor_rule_learning_jobs(
  p_worker_id text,
  p_batch_size integer default 25,
  p_business_id uuid default null,
  p_now timestamptz default now()
)
returns setof public.vendor_rule_learning_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select job.id
    from public.vendor_rule_learning_jobs job
    where job.status in ('pending', 'failed')
      and job.attempt_count < 5
      and job.process_after <= p_now
      and (p_business_id is null or job.business_id = p_business_id)
    order by job.process_after, job.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_batch_size, 25), 100))
  )
  update public.vendor_rule_learning_jobs job
  set status = 'processing',
      attempt_count = job.attempt_count + 1,
      claimed_by = p_worker_id,
      claimed_at = p_now,
      updated_at = p_now
  from due
  where job.id = due.id
  returning job.*;
end;
$$;

revoke all on function public.claim_vendor_rule_learning_jobs(text, integer, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_vendor_rule_learning_jobs(text, integer, uuid, timestamptz) to service_role;
