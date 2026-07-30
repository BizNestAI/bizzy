create table if not exists public.financial_monthly_review_stamps (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  review_month date not null,
  status text not null default 'finalized' check (status in ('completed', 'closed', 'finalized')),
  reviewed_by text,
  reviewer_user_id uuid,
  completed_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_monthly_review_stamps_month_start
    check (review_month = date_trunc('month', review_month)::date),
  constraint financial_monthly_review_stamps_unique_month
    unique (business_id, review_month)
);

create index if not exists financial_monthly_review_stamps_business_month_idx
  on public.financial_monthly_review_stamps (business_id, review_month desc);

alter table public.financial_monthly_review_stamps enable row level security;

drop policy if exists "Users can read completed monthly review stamps for their businesses"
  on public.financial_monthly_review_stamps;

create policy "Users can read completed monthly review stamps for their businesses"
  on public.financial_monthly_review_stamps
  for select
  to authenticated
  using (
    status in ('completed', 'closed', 'finalized')
    and exists (
      select 1
      from public.user_business_link ubl
      where ubl.business_id = financial_monthly_review_stamps.business_id
        and ubl.user_id = auth.uid()
    )
  );

grant select on public.financial_monthly_review_stamps to authenticated;
