-- Durable bridge from authoritative bookkeeping account changes to Tax.
-- The trigger runs in the same transaction as transaction_categorizations so
-- a process restart cannot strand a committed GL reclassification.
create table if not exists public.tax_bookkeeping_change_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (char_length(event_key) between 1 and 200),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  tax_year integer not null check (tax_year between 2000 and 2200),
  source_revision text not null check (char_length(source_revision) between 1 and 128),
  status text not null default 'pending' check (status in ('pending','processing','completed','failed','dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 20),
  process_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tax_bookkeeping_change_outbox_due_idx
  on public.tax_bookkeeping_change_outbox(status, process_after);
create index if not exists tax_bookkeeping_change_outbox_scope_idx
  on public.tax_bookkeeping_change_outbox(business_id, tax_year, transaction_id, status);

alter table public.tax_bookkeeping_change_outbox enable row level security;
alter table public.tax_bookkeeping_change_outbox force row level security;
revoke all on table public.tax_bookkeeping_change_outbox from public, anon, authenticated;
revoke all on table public.tax_bookkeeping_change_outbox from service_role;
grant select, insert, update on table public.tax_bookkeeping_change_outbox to service_role;
alter table public.tax_bookkeeping_change_outbox owner to postgres;

create or replace function public.enqueue_tax_bookkeeping_account_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_date date;
  v_revision text;
  v_key text;
begin
  if new.final_qbo_account_id is not distinct from old.final_qbo_account_id
     and new.final_qbo_account_name is not distinct from old.final_qbo_account_name then
    return new;
  end if;
  select bt.date into v_date
  from public.bank_transactions bt
  where bt.id = new.transaction_id and bt.business_id = new.business_id;
  if v_date is null then
    raise exception 'tax outbox transaction scope mismatch';
  end if;
  v_revision := encode(extensions.digest(concat_ws('|', new.business_id::text, new.transaction_id::text,
    coalesce(new.final_qbo_account_id::text,''), coalesce(new.final_qbo_account_name,''),
    coalesce(new.updated_at::text, now()::text)), 'sha256'), 'hex');
  v_key := 'bookkeeping-tax:' || new.business_id::text || ':' || new.transaction_id::text || ':' || v_revision;
  insert into public.tax_bookkeeping_change_outbox
    (event_key, business_id, transaction_id, tax_year, source_revision)
  values (v_key, new.business_id, new.transaction_id, extract(year from v_date)::integer, v_revision)
  on conflict (event_key) do nothing;
  return new;
end;
$$;

drop trigger if exists transaction_categorizations_tax_outbox on public.transaction_categorizations;
create trigger transaction_categorizations_tax_outbox
after update of final_qbo_account_id, final_qbo_account_name on public.transaction_categorizations
for each row execute function public.enqueue_tax_bookkeeping_account_change();

create or replace function public.claim_tax_bookkeeping_change_outbox(
  p_worker_id text, p_batch_size integer default 10, p_now timestamptz default now()
) returns setof public.tax_bookkeeping_change_outbox
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query with claimable as (
    select id from public.tax_bookkeeping_change_outbox
    where status in ('pending','failed') and process_after <= p_now
      and attempt_count < max_attempts
      and (locked_at is null or locked_at < p_now - interval '30 minutes')
    order by process_after, created_at for update skip locked
    limit greatest(1, least(coalesce(p_batch_size,10),50))
  ) update public.tax_bookkeeping_change_outbox o
    set status='processing', locked_at=p_now, locked_by=p_worker_id,
        attempt_count=o.attempt_count+1, updated_at=p_now
    from claimable where o.id=claimable.id returning o.*;
end;
$$;

revoke all on function public.enqueue_tax_bookkeeping_account_change() from public, anon, authenticated;
revoke all on function public.claim_tax_bookkeeping_change_outbox(text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_tax_bookkeeping_account_change() to service_role;
grant execute on function public.claim_tax_bookkeeping_change_outbox(text,integer,timestamptz) to service_role;
alter function public.enqueue_tax_bookkeeping_account_change() owner to postgres;
alter function public.claim_tax_bookkeeping_change_outbox(text,integer,timestamptz) owner to postgres;
