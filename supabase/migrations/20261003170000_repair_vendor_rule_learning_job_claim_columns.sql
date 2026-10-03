-- Repair installations where vendor_rule_learning_jobs predated the retry
-- worker migration. CREATE TABLE IF NOT EXISTS does not add missing columns to
-- an already-existing relation, so make the worker lease contract additive.

alter table public.vendor_rule_learning_jobs
  add column if not exists claimed_by text,
  add column if not exists claimed_at timestamptz,
  add column if not exists completed_at timestamptz;

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
