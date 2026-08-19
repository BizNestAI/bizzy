-- Business-scoped claim helper for immediate post-Plaid bookkeeping wakeups.
-- Keeps the existing global claim RPC intact for recurring catch-up workers.

create or replace function public.claim_bookkeeping_processing_requests_for_business(
  p_business_id uuid,
  p_worker_id text,
  p_batch_size integer,
  p_now timestamp with time zone
) returns setof public.bookkeeping_processing_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
    from public.bookkeeping_processing_requests
    where business_id = p_business_id
      and (
        status in ('pending', 'failed')
        or (
          status = 'processing'
          and locked_at is not null
          and locked_at < p_now - interval '10 minutes'
        )
      )
      and process_after <= p_now
      and attempt_count < max_attempts
    order by priority desc, process_after asc, created_at asc
    limit greatest(1, least(coalesce(p_batch_size, 25), 250))
    for update skip locked
  )
  update public.bookkeeping_processing_requests r
     set status = 'processing',
         locked_at = p_now,
         locked_by = p_worker_id,
         attempt_count = coalesce(r.attempt_count, 0) + 1,
         error_code = null,
         error_message = null,
         updated_at = p_now
    from candidates
   where r.id = candidates.id
  returning r.*;
end;
$$;

revoke all on function public.claim_bookkeeping_processing_requests_for_business(uuid, text, integer, timestamp with time zone) from public;
revoke all on function public.claim_bookkeeping_processing_requests_for_business(uuid, text, integer, timestamp with time zone) from anon;
revoke all on function public.claim_bookkeeping_processing_requests_for_business(uuid, text, integer, timestamp with time zone) from authenticated;
grant execute on function public.claim_bookkeeping_processing_requests_for_business(uuid, text, integer, timestamp with time zone) to service_role;
