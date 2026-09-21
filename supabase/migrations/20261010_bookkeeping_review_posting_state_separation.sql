-- Keep the human review decision independent from the downstream QBO posting lifecycle.
-- Legacy `status` remains for compatibility; these columns are the durable state-machine evidence.

alter table if exists public.transaction_categorizations
  add column if not exists review_status text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_reopened_at timestamptz,
  add column if not exists review_reopen_reason text,
  add column if not exists posting_status text;

update public.transaction_categorizations
set
  review_status = case
    when status in ('approved', 'auto_approved', 'handled', 'failed', 'posted', 'matched_existing_qbo', 'ignored') then 'handled'
    else 'needs_review'
  end,
  reviewed_at = case
    when status in ('approved', 'auto_approved', 'handled', 'failed', 'posted', 'matched_existing_qbo', 'ignored')
      then coalesce(decided_at, posted_at, updated_at, created_at)
    else reviewed_at
  end,
  posting_status = case
    when status = 'posted' or qbo_txn_id is not null then 'posted'
    when status = 'matched_existing_qbo' then 'not_scheduled'
    when status = 'failed' or post_error is not null then 'posting_failed'
    when coalesce((meta ->> 'posting_in_progress')::boolean, false) then 'posting'
    when post_after is not null then 'scheduled'
    else 'not_scheduled'
  end
where review_status is null or posting_status is null;

alter table public.transaction_categorizations
  alter column review_status set default 'needs_review',
  alter column review_status set not null,
  alter column posting_status set default 'not_scheduled',
  alter column posting_status set not null;

alter table public.transaction_categorizations
  drop constraint if exists transaction_categorizations_review_status_check,
  add constraint transaction_categorizations_review_status_check
    check (review_status in ('needs_review', 'handled')),
  drop constraint if exists transaction_categorizations_posting_status_check,
  add constraint transaction_categorizations_posting_status_check
    check (posting_status in ('not_scheduled', 'scheduled', 'posting', 'posting_failed', 'posted'));

create or replace function public.enforce_bookkeeping_review_posting_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_explicit_undo boolean := false;
  v_documented_reopen boolean :=
    coalesce((new.meta ->> 'review_reopen_authorized')::boolean, false)
    and nullif(new.meta ->> 'review_reopen_reason', '') is not null;
begin
  if tg_op = 'UPDATE' then
    v_explicit_undo :=
      new.decided_by = 'user'
      and new.final_qbo_account_id is null
      and new.final_qbo_account_name is null
      and new.post_error is null
      and new.decided_at is distinct from old.decided_at;
  end if;

  if tg_op = 'UPDATE'
     and (old.status = 'posted' or old.qbo_txn_id is not null or old.posted_at is not null)
     and new.status in ('needs_review', 'uncategorized') then
    -- Undo never voids a QBO entity. A posted row cannot become reviewable or
    -- post-eligible again while durable posting evidence remains.
    new.status := old.status;
    new.review_status := 'handled';
    new.reviewed_at := old.reviewed_at;
    new.final_qbo_account_id := old.final_qbo_account_id;
    new.final_qbo_account_name := old.final_qbo_account_name;
    new.final_canonical_account_key := old.final_canonical_account_key;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  elsif tg_op = 'UPDATE'
     and old.review_status = 'handled'
     and new.status in ('needs_review', 'uncategorized')
     and not v_explicit_undo
     and not v_documented_reopen then
    -- Stale suggestion/sync/worker writes may update operational metadata, but
    -- they may not erase a completed human review decision.
    new.status := old.status;
    new.review_status := 'handled';
    new.reviewed_at := old.reviewed_at;
    new.final_qbo_account_id := old.final_qbo_account_id;
    new.final_qbo_account_name := old.final_qbo_account_name;
    new.final_canonical_account_key := old.final_canonical_account_key;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  elsif new.status in ('approved', 'auto_approved', 'handled', 'failed', 'posted', 'matched_existing_qbo', 'ignored') then
    new.review_status := 'handled';
    new.reviewed_at := coalesce(old.reviewed_at, new.decided_at, new.posted_at, now());
  else
    new.review_status := 'needs_review';
    if tg_op = 'UPDATE' and old.review_status = 'handled' then
      new.review_reopened_at := now();
      new.review_reopen_reason := coalesce(new.meta ->> 'review_reopen_reason', 'user_undo');
    end if;
  end if;

  new.posting_status := case
    when new.status = 'posted' or new.qbo_txn_id is not null then 'posted'
    when new.status = 'matched_existing_qbo' then 'not_scheduled'
    when new.status = 'failed' or new.post_error is not null then 'posting_failed'
    when coalesce((new.meta ->> 'posting_in_progress')::boolean, false) then 'posting'
    when new.post_after is not null then 'scheduled'
    else 'not_scheduled'
  end;
  return new;
end;
$$;

drop trigger if exists trg_enforce_bookkeeping_review_posting_state on public.transaction_categorizations;
create trigger trg_enforce_bookkeeping_review_posting_state
before insert or update on public.transaction_categorizations
for each row execute function public.enforce_bookkeeping_review_posting_state();

create index if not exists transaction_categorizations_review_posting_idx
  on public.transaction_categorizations (business_id, review_status, posting_status);

create table if not exists public.bookkeeping_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  previous_review_status text,
  new_review_status text not null,
  previous_posting_status text,
  new_posting_status text not null,
  previous_legacy_status text,
  new_legacy_status text not null,
  actor text,
  reason text,
  posting_attempt_id text,
  plaid_pending_transaction_id text,
  created_at timestamptz not null default now()
);

alter table public.bookkeeping_lifecycle_events enable row level security;
revoke all on table public.bookkeeping_lifecycle_events from anon, authenticated;
grant select, insert on table public.bookkeeping_lifecycle_events to service_role;

create index if not exists bookkeeping_lifecycle_events_transaction_idx
  on public.bookkeeping_lifecycle_events (business_id, transaction_id, created_at desc);

create or replace function public.audit_bookkeeping_lifecycle_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.review_status is distinct from new.review_status
     or old.posting_status is distinct from new.posting_status
     or old.status is distinct from new.status then
    insert into public.bookkeeping_lifecycle_events (
      business_id,
      transaction_id,
      previous_review_status,
      new_review_status,
      previous_posting_status,
      new_posting_status,
      previous_legacy_status,
      new_legacy_status,
      actor,
      reason,
      posting_attempt_id,
      plaid_pending_transaction_id
    ) values (
      new.business_id,
      new.transaction_id,
      old.review_status,
      new.review_status,
      old.posting_status,
      new.posting_status,
      old.status,
      new.status,
      coalesce(new.decided_by, new.meta ->> 'lifecycle_actor', 'system'),
      coalesce(new.meta ->> 'review_reopen_reason', new.post_error, new.reason, 'state_transition'),
      coalesce(new.meta ->> 'post_intent_id', new.meta ->> 'post_idempotency_key'),
      new.meta ->> 'pending_transaction_id'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_audit_bookkeeping_lifecycle_transition on public.transaction_categorizations;
create trigger trg_audit_bookkeeping_lifecycle_transition
after update on public.transaction_categorizations
for each row execute function public.audit_bookkeeping_lifecycle_transition();
