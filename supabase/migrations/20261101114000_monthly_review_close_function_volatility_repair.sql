-- The snapshot validator is a pure projection. STABLE functions cannot take row locks.
-- Atomic serialization remains in finalize_monthly_admin_review_close's run-row lock.
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
  select * into v_snapshot
  from public.monthly_review_qbo_pnl_snapshots
  where id = p_snapshot_id and business_id = p_business_id;
  if not found then raise exception 'accounting_period_close_snapshot_not_found' using errcode = '22023'; end if;
  if v_snapshot.accounting_method <> 'Cash' then raise exception 'accounting_period_close_snapshot_not_cash' using errcode = '22023'; end if;
  if make_date(v_snapshot.review_year, v_snapshot.review_month, 1) <> p_period_month then raise exception 'accounting_period_close_snapshot_period_mismatch' using errcode = '22023'; end if;
  if v_snapshot.status not in ('current', 'validated') then raise exception 'accounting_period_close_snapshot_not_valid' using errcode = '22023'; end if;
  if coalesce(v_snapshot.metadata->'reconciliation'->>'status', '') not in ('', 'valid') then raise exception 'accounting_period_close_snapshot_reconciliation_invalid' using errcode = '22023'; end if;
  select count(*)::integer into v_account_count
  from public.monthly_review_qbo_pnl_accounts
  where business_id = p_business_id and snapshot_id = p_snapshot_id;
  if v_account_count <= 0 then raise exception 'accounting_period_close_snapshot_missing_accounts' using errcode = '22023'; end if;
  snapshot_id := v_snapshot.id;
  snapshot_fingerprint := coalesce(v_snapshot.raw_hash, concat_ws('|', v_snapshot.id::text, v_snapshot.business_id::text, v_snapshot.review_year::text, v_snapshot.review_month::text, v_snapshot.accounting_method, v_snapshot.revenue::text, v_snapshot.cogs::text, v_snapshot.expenses::text, v_snapshot.net_profit::text, v_snapshot.pulled_at::text));
  account_row_count := v_account_count;
  return next;
end;
$$;

-- The finalizer mutates, locks, stamps, and audits, so its volatility is explicit.
-- A replay/concurrent waiter returns the existing finalized projection after acquiring the run lock.
create or replace function public.finalize_monthly_admin_review_close(
  p_run_id uuid,
  p_business_id uuid,
  p_review_month date,
  p_actor_user_id uuid,
  p_actor_email text,
  p_notes text,
  p_snapshot_id uuid,
  p_pending_transaction_count integer,
  p_readiness_evidence jsonb,
  p_evidence_snapshot jsonb,
  p_evidence_hash text,
  p_readiness_score numeric
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := timezone('utc'::text, now());
  v_run public.monthly_review_runs%rowtype;
  v_stamp public.financial_monthly_review_stamps%rowtype;
  v_close public.accounting_period_closes%rowtype;
  v_previous_status text;
begin
  if p_run_id is null or p_business_id is null or p_review_month is null or p_snapshot_id is null then
    raise exception 'monthly_review_close_missing_identity' using errcode = '22023';
  end if;
  select * into v_run
  from public.monthly_review_runs
  where id = p_run_id and business_id = p_business_id and review_month = date_trunc('month', p_review_month)::date
  for update;
  if not found then raise exception 'monthly_review_close_run_not_found' using errcode = '22023'; end if;

  if v_run.active_editor_user_id is not null
    and v_run.active_editor_expires_at > v_now
    and v_run.active_editor_user_id <> p_actor_user_id then
    raise exception 'monthly_review_close_active_editor_conflict' using errcode = '40001';
  end if;

  if v_run.status = 'finalized' then
    select * into v_stamp from public.financial_monthly_review_stamps
      where business_id = p_business_id and review_month = date_trunc('month', p_review_month)::date;
    select * into v_close from public.accounting_period_closes
      where business_id = p_business_id and period_month = date_trunc('month', p_review_month)::date and is_active is true and status = 'approved'
      order by close_version desc limit 1;
    if v_stamp.id is null or v_close.id is null then raise exception 'monthly_review_close_partial_finalization_state' using errcode = '55000'; end if;
    return jsonb_build_object('run_id', v_run.id, 'stamp_id', v_stamp.id, 'accounting_period_close_id', v_close.id, 'approved_snapshot_id', v_close.approved_snapshot_id, 'authority_type', v_close.authority_type, 'close_version', v_close.close_version, 'idempotent', true);
  end if;

  v_previous_status := v_run.status;
  update public.monthly_review_runs set status = 'finalized', finalized_by = p_actor_user_id, finalized_at = v_now, notes = p_notes, evidence_snapshot = coalesce(p_evidence_snapshot, '{}'::jsonb), evidence_hash = p_evidence_hash, readiness_score = coalesce(p_readiness_score, readiness_score), updated_at = v_now where id = p_run_id returning * into v_run;
  insert into public.financial_monthly_review_stamps (business_id, review_month, status, reviewed_by, reviewer_user_id, completed_at, notes, updated_at)
  values (p_business_id, date_trunc('month', p_review_month)::date, 'finalized', coalesce(nullif(p_actor_email, ''), p_actor_user_id::text), p_actor_user_id, v_now, p_notes, v_now)
  on conflict (business_id, review_month) do update set status = excluded.status, reviewed_by = excluded.reviewed_by, reviewer_user_id = excluded.reviewer_user_id, completed_at = excluded.completed_at, notes = excluded.notes, updated_at = excluded.updated_at
  returning * into v_stamp;
  select * into v_close from public.record_accounting_period_close_authority(p_business_id, date_trunc('month', p_review_month)::date, p_snapshot_id, 'admin_approved', p_actor_user_id, 'monthly_admin_review', p_pending_transaction_count, coalesce(p_readiness_evidence, '{}'::jsonb));
  insert into public.monthly_review_audit_events (run_id, business_id, review_month, actor_user_id, actor_email, event_type, section_key, previous_value, next_value, notes)
  values (p_run_id, p_business_id, date_trunc('month', p_review_month)::date, p_actor_user_id, p_actor_email, 'finalized', 'period_close', jsonb_build_object('status', v_previous_status), jsonb_build_object('status', 'finalized', 'accounting_period_close_id', v_close.id, 'approved_snapshot_id', p_snapshot_id, 'authority_type', 'admin_approved', 'close_version', v_close.close_version, 'readiness_score', p_readiness_score, 'request_id', p_readiness_evidence->>'request_id'), p_notes);
  return jsonb_build_object('run_id', v_run.id, 'stamp_id', v_stamp.id, 'accounting_period_close_id', v_close.id, 'approved_snapshot_id', p_snapshot_id, 'authority_type', v_close.authority_type, 'close_version', v_close.close_version, 'idempotent', false);
end;
$$;

alter function public.validate_accounting_period_close_snapshot(uuid, date, uuid) owner to postgres;
alter function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) owner to postgres;
revoke all on function public.validate_accounting_period_close_snapshot(uuid, date, uuid) from public, anon, authenticated;
revoke all on function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) from public, anon, authenticated;
grant execute on function public.validate_accounting_period_close_snapshot(uuid, date, uuid) to service_role;
grant execute on function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) to service_role;
notify pgrst, 'reload schema';
