-- Forward repair: qualify the validator's output-column name, and make every
-- mutating close function's volatility/security contract explicit.
create or replace function public.validate_accounting_period_close_snapshot(
  p_business_id uuid,
  p_period_month date,
  p_snapshot_id uuid
)
returns table (snapshot_id uuid, snapshot_fingerprint text, account_row_count integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_snapshot public.monthly_review_qbo_pnl_snapshots%rowtype;
  v_account_count integer;
begin
  if p_business_id is null or p_period_month is null or p_snapshot_id is null then
    raise exception 'accounting_period_close_missing_identity' using errcode = '22023';
  end if;
  if p_period_month <> date_trunc('month', p_period_month)::date then
    raise exception 'accounting_period_close_month_not_normalized' using errcode = '22023';
  end if;
  select s.* into v_snapshot
  from public.monthly_review_qbo_pnl_snapshots as s
  where s.id = p_snapshot_id and s.business_id = p_business_id;
  if not found then raise exception 'accounting_period_close_snapshot_not_found' using errcode = '22023'; end if;
  if v_snapshot.accounting_method <> 'Cash' then raise exception 'accounting_period_close_snapshot_not_cash' using errcode = '22023'; end if;
  if make_date(v_snapshot.review_year, v_snapshot.review_month, 1) <> p_period_month then raise exception 'accounting_period_close_snapshot_period_mismatch' using errcode = '22023'; end if;
  if v_snapshot.status not in ('current', 'validated') then raise exception 'accounting_period_close_snapshot_not_valid' using errcode = '22023'; end if;
  if coalesce(v_snapshot.metadata->'reconciliation'->>'status', '') not in ('', 'valid') then raise exception 'accounting_period_close_snapshot_reconciliation_invalid' using errcode = '22023'; end if;
  select count(*)::integer into v_account_count
  from public.monthly_review_qbo_pnl_accounts as a
  where a.business_id = p_business_id and a.snapshot_id = p_snapshot_id;
  if v_account_count <= 0 then raise exception 'accounting_period_close_snapshot_missing_accounts' using errcode = '22023'; end if;
  snapshot_id := v_snapshot.id;
  snapshot_fingerprint := coalesce(v_snapshot.metadata->'financial_content'->>'fingerprint', v_snapshot.raw_hash);
  account_row_count := v_account_count;
  return next;
end;
$$;

alter function public.validate_accounting_period_close_snapshot(uuid, date, uuid) owner to postgres;
alter function public.record_accounting_period_close_authority(uuid, date, uuid, text, uuid, text, integer, jsonb) volatile;
alter function public.record_accounting_period_close_authority(uuid, date, uuid, text, uuid, text, integer, jsonb) set search_path to pg_catalog, public;
alter function public.record_accounting_period_close_authority(uuid, date, uuid, text, uuid, text, integer, jsonb) owner to postgres;
alter function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) volatile;
alter function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) set search_path to pg_catalog, public;
alter function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) owner to postgres;

revoke all on function public.validate_accounting_period_close_snapshot(uuid, date, uuid) from public, anon, authenticated;
revoke all on function public.record_accounting_period_close_authority(uuid, date, uuid, text, uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) from public, anon, authenticated;
grant execute on function public.validate_accounting_period_close_snapshot(uuid, date, uuid) to service_role;
grant execute on function public.record_accounting_period_close_authority(uuid, date, uuid, text, uuid, text, integer, jsonb) to service_role;
grant execute on function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) to service_role;
notify pgrst, 'reload schema';
