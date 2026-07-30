drop function if exists public.acquire_posting_lock(uuid, uuid, timestamptz, integer, text);
drop function if exists public.acquire_posting_lock(uuid, uuid, text, integer, text);

create or replace function public.acquire_posting_lock(
  p_business_id uuid,
  p_transaction_id uuid,
  p_now_iso text,
  p_lock_stale_seconds integer default 600,
  p_idempotency_key text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(nullif(p_now_iso, '')::timestamptz, now());
  v_row_count integer := 0;
begin
  update public.transaction_categorizations
  set
    last_post_attempt_at = v_now,
    meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
      'posting_in_progress', true,
      'posting_started_at', v_now,
      'post_idempotency_key', p_idempotency_key
    )
  where business_id = p_business_id
    and transaction_id = p_transaction_id
    and qbo_txn_id is null
    and (
      lower(coalesce(meta->>'posting_in_progress', 'false')) <> 'true'
      or last_post_attempt_at is null
      or last_post_attempt_at < v_now - make_interval(secs => greatest(coalesce(p_lock_stale_seconds, 600), 1))
    );

  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

grant execute on function public.acquire_posting_lock(uuid, uuid, text, integer, text) to authenticated;
grant execute on function public.acquire_posting_lock(uuid, uuid, text, integer, text) to service_role;
