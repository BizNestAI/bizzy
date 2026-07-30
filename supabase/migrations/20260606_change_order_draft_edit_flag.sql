alter table public.job_change_orders
  add column if not exists draft_client_message_edited boolean not null default false;
