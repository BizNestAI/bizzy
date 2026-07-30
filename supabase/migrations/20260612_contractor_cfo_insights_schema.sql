-- Contractor CFO insights production compatibility.
-- Ensures the canonical insights table has the fields required by the
-- deterministic financial alert engine and live InsightsRail.

create extension if not exists pgcrypto;

create table if not exists public.insights (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now()
);

alter table public.insights
  add column if not exists business_id uuid null,
  add column if not exists user_id uuid null,
  add column if not exists module text not null default 'contractor_cfo',
  add column if not exists type text not null default 'insight',
  add column if not exists title text null,
  add column if not exists body text null,
  add column if not exists severity text null,
  add column if not exists category text null,
  add column if not exists confidence_score numeric null,
  add column if not exists metrics jsonb not null default '[]'::jsonb,
  add column if not exists recommended_actions jsonb not null default '[]'::jsonb,
  add column if not exists primary_cta jsonb null,
  add column if not exists primary_cta_label text null,
  add column if not exists primary_cta_action text null,
  add column if not exists primary_cta_payload jsonb null,
  add column if not exists secondary_cta jsonb null,
  add column if not exists secondary_cta_label text null,
  add column if not exists secondary_cta_action text null,
  add column if not exists secondary_cta_payload jsonb null,
  add column if not exists tags text[] null,
  add column if not exists source_event_id text null,
  add column if not exists dedupe_key text null,
  add column if not exists trigger_source text null,
  add column if not exists source_refs jsonb not null default '[]'::jsonb,
  add column if not exists expires_at timestamptz null,
  add column if not exists snoozed_until timestamptz null,
  add column if not exists dismissed_at timestamptz null,
  add column if not exists status text null,
  add column if not exists is_read boolean not null default false,
  add column if not exists read_at timestamptz null,
  add column if not exists account_id text null;

update public.insights
set module = 'contractor_cfo'
where module in ('accounting', 'financials', 'bizzy') or module is null;

create index if not exists insights_business_module_created_at_idx
  on public.insights (business_id, module, created_at desc);

create index if not exists insights_business_dedupe_key_idx
  on public.insights (business_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists insights_business_source_event_id_idx
  on public.insights (business_id, source_event_id)
  where source_event_id is not null;

create index if not exists insights_business_status_idx
  on public.insights (business_id, status)
  where status is not null;

create index if not exists insights_business_snoozed_until_idx
  on public.insights (business_id, snoozed_until)
  where snoozed_until is not null;

create index if not exists insights_business_expires_at_idx
  on public.insights (business_id, expires_at)
  where expires_at is not null;
