-- Lightweight Bid Builder site photo/file attachment metadata.
-- Photo analysis is intentionally not implemented here.

create extension if not exists pgcrypto;

create table if not exists public.bid_attachments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  bid_estimate_id uuid not null,
  file_url text not null,
  storage_bucket text null,
  storage_path text null,
  file_name text null,
  mime_type text null,
  notes text null,
  extraction_status text default 'not_started',
  extracted_summary text null,
  created_at timestamptz default now(),
  constraint bid_attachments_bid_estimate_id_fkey
    foreign key (bid_estimate_id) references public.bid_estimates (id) on delete cascade
);

create index if not exists bid_attachments_business_bid_estimate_idx
  on public.bid_attachments (business_id, bid_estimate_id);

alter table if exists public.bid_attachments
  add column if not exists storage_bucket text null,
  add column if not exists storage_path text null;
