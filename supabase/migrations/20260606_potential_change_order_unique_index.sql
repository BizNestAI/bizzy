create unique index if not exists potential_change_orders_business_job_trigger_title_uidx
  on public.potential_change_orders (business_id, job_id, trigger_type, title);
