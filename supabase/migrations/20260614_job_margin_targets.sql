-- Trade-level target margins for Job Costing pricing recommendations.
-- This keeps the source-controlled schema aligned with the live Supabase table.

create table if not exists public.job_margin_targets (
  business_id uuid not null,
  trade_type text not null,
  target_margin_percent numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_margin_targets_pkey primary key (business_id, trade_type),
  constraint job_margin_targets_percent_check
    check (target_margin_percent > 0 and target_margin_percent < 95)
);

alter table public.job_margin_targets
  add column if not exists business_id uuid,
  add column if not exists trade_type text,
  add column if not exists target_margin_percent numeric,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.job_margin_targets
set created_at = now()
where created_at is null;

update public.job_margin_targets
set updated_at = now()
where updated_at is null;

alter table public.job_margin_targets
  alter column business_id set not null,
  alter column trade_type set not null,
  alter column target_margin_percent set not null,
  alter column created_at set not null,
  alter column updated_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_margin_targets_pkey'
      and conrelid = 'public.job_margin_targets'::regclass
  ) then
    alter table public.job_margin_targets
      add constraint job_margin_targets_pkey primary key (business_id, trade_type);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_margin_targets_percent_check'
      and conrelid = 'public.job_margin_targets'::regclass
  ) then
    alter table public.job_margin_targets
      add constraint job_margin_targets_percent_check
      check (target_margin_percent > 0 and target_margin_percent < 95);
  end if;
end;
$$;

create index if not exists job_margin_targets_business_idx
  on public.job_margin_targets (business_id);

create or replace function public.set_job_margin_targets_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists job_margin_targets_set_updated_at on public.job_margin_targets;

create trigger job_margin_targets_set_updated_at
before update on public.job_margin_targets
for each row
execute function public.set_job_margin_targets_updated_at();
