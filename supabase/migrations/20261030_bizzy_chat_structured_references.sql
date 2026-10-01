alter table public.gpt_messages
  add column if not exists structured_references jsonb null;

comment on column public.gpt_messages.structured_references is
  'Bounded, tenant-scoped conversation references: at most one job, eight transactions, one merchant, and one period.';
