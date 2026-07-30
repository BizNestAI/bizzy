create table if not exists public.tax_recalculation_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  tax_year integer not null,
  event_type text not null,
  trigger_source text not null,
  priority text not null default 'normal',
  status text not null default 'pending',
  event_id text not null,
  correlation_id text null,
  source_record_id text null,
  source_table text null,
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  process_after timestamptz not null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz null,
  locked_by text null,
  completed_at timestamptz null,
  calculation_run_id uuid null references public.tax_calculation_runs(id),
  outcome text null,
  error_code text null,
  error_message text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_recalc_status_check check (status in ('pending', 'processing', 'completed', 'skipped', 'failed', 'dead_letter')),
  constraint tax_recalc_priority_check check (priority in ('critical', 'high', 'normal', 'low'))
);

create unique index if not exists tax_recalculation_requests_event_id_uidx
  on public.tax_recalculation_requests (event_id);

create index if not exists tax_recalculation_requests_due_idx
  on public.tax_recalculation_requests (status, process_after);

create index if not exists tax_recalculation_requests_business_year_status_idx
  on public.tax_recalculation_requests (business_id, tax_year, status);

create index if not exists tax_recalculation_requests_locked_idx
  on public.tax_recalculation_requests (locked_at);

create index if not exists tax_recalculation_requests_last_event_idx
  on public.tax_recalculation_requests (last_event_at desc);

create or replace function public.touch_tax_recalculation_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tax_recalculation_requests_updated_at on public.tax_recalculation_requests;
create trigger trg_tax_recalculation_requests_updated_at
before update on public.tax_recalculation_requests
for each row
execute function public.touch_tax_recalculation_requests_updated_at();

create or replace function public.claim_tax_recalculation_requests(
  p_worker_id text,
  p_batch_size integer default 10,
  p_now timestamptz default now()
)
returns setof public.tax_recalculation_requests
language plpgsql
security definer
as $$
begin
  return query
  with claimable as (
    select id
    from public.tax_recalculation_requests
    where status in ('pending', 'failed')
      and process_after <= p_now
      and attempt_count < max_attempts
      and (
        locked_at is null
        or locked_at < p_now - interval '30 minutes'
      )
    order by
      case priority
        when 'critical' then 4
        when 'high' then 3
        when 'normal' then 2
        else 1
      end desc,
      process_after asc
    for update skip locked
    limit greatest(1, least(coalesce(p_batch_size, 10), 100))
  )
  update public.tax_recalculation_requests r
     set status = 'processing',
         locked_at = p_now,
         locked_by = p_worker_id,
         attempt_count = r.attempt_count + 1,
         updated_at = p_now
    from claimable
   where r.id = claimable.id
  returning r.*;
end;
$$;
