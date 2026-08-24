create or replace function public.promote_monthly_review_qbo_pnl_snapshot(
  p_business_id uuid,
  p_review_year integer,
  p_review_month integer,
  p_snapshot_id uuid,
  p_status text default 'current'
)
returns public.monthly_review_qbo_pnl_snapshots
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_snapshot public.monthly_review_qbo_pnl_snapshots;
begin
  if p_business_id is null or p_snapshot_id is null then
    raise exception 'missing_snapshot_promotion_identity'
      using errcode = '22023';
  end if;

  perform 1
  from public.monthly_review_qbo_pnl_snapshots
  where business_id = p_business_id
    and review_year = p_review_year
    and review_month = p_review_month
  for update;

  select *
    into v_snapshot
  from public.monthly_review_qbo_pnl_snapshots
  where id = p_snapshot_id
    and business_id = p_business_id
    and review_year = p_review_year
    and review_month = p_review_month
  for update;

  if not found then
    raise exception 'snapshot_candidate_not_found'
      using errcode = 'P0002';
  end if;

  if v_snapshot.is_current is true or v_snapshot.status not in ('building', 'validated') then
    raise exception 'snapshot_candidate_not_promotable'
      using errcode = '22023';
  end if;

  update public.monthly_review_qbo_pnl_snapshots
     set is_current = false,
         status = 'superseded',
         updated_at = now()
   where business_id = p_business_id
     and review_year = p_review_year
     and review_month = p_review_month
     and is_current is true
     and id <> p_snapshot_id;

  update public.monthly_review_qbo_pnl_snapshots
     set is_current = true,
         status = coalesce(nullif(p_status, ''), 'current'),
         updated_at = now()
   where id = p_snapshot_id
     and business_id = p_business_id
  returning * into v_snapshot;

  return v_snapshot;
end;
$$;

revoke all on function public.promote_monthly_review_qbo_pnl_snapshot(uuid, integer, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.promote_monthly_review_qbo_pnl_snapshot(uuid, integer, integer, uuid, text) to service_role;

comment on function public.promote_monthly_review_qbo_pnl_snapshot(uuid, integer, integer, uuid, text) is
  'Atomically promotes a validated Monthly Review QBO P&L snapshot to current for one business/month. Service-role only.';
