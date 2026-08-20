create or replace function public.refresh_operator_request_summary(p_business_id uuid)
returns table (
  business_id uuid,
  accounting_needs_review_count integer,
  outstanding_count integer,
  answered_awaiting_review_count integer,
  reconciliation_status text,
  last_error text,
  last_reconciled_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts record;
begin
  if p_business_id is null then
    raise exception 'missing_business_id';
  end if;

  select *
  into v_counts
  from public.get_operator_request_counts_bounded(p_business_id);

  insert into public.operator_request_summaries as ors (
    business_id,
    accounting_needs_review_count,
    outstanding_count,
    answered_awaiting_review_count,
    reconciliation_status,
    last_error,
    last_reconciled_at,
    updated_at
  )
  values (
    p_business_id,
    greatest(coalesce(v_counts.accounting_needs_review_count, 0), 0)::integer,
    greatest(coalesce(v_counts.outstanding_count, 0), 0)::integer,
    greatest(coalesce(v_counts.answered_awaiting_review_count, 0), 0)::integer,
    'ok',
    null,
    now(),
    now()
  )
  on conflict on constraint operator_request_summaries_pkey do update
    set accounting_needs_review_count = excluded.accounting_needs_review_count,
        outstanding_count = excluded.outstanding_count,
        answered_awaiting_review_count = excluded.answered_awaiting_review_count,
        reconciliation_status = 'ok',
        last_error = null,
        last_reconciled_at = excluded.last_reconciled_at,
        updated_at = excluded.updated_at;

  return query
  select
    ors.business_id,
    ors.accounting_needs_review_count,
    ors.outstanding_count,
    ors.answered_awaiting_review_count,
    ors.reconciliation_status,
    ors.last_error,
    ors.last_reconciled_at,
    ors.created_at,
    ors.updated_at
  from public.operator_request_summaries ors
  where ors.business_id = p_business_id;
exception
  when others then
    insert into public.operator_request_summaries as ors (
      business_id,
      reconciliation_status,
      last_error,
      updated_at
    )
    values (
      p_business_id,
      'error',
      left(sqlerrm, 1000),
      now()
    )
    on conflict on constraint operator_request_summaries_pkey do update
      set reconciliation_status = 'error',
          last_error = left(sqlerrm, 1000),
          updated_at = now();
    raise;
end;
$$;

revoke all on function public.refresh_operator_request_summary(uuid) from public, anon, authenticated;
grant execute on function public.refresh_operator_request_summary(uuid) to service_role;
