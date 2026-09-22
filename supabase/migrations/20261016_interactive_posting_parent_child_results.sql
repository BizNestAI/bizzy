alter table public.bookkeeping_interactive_posting_commands
  add column if not exists child_operations jsonb not null default '{}'::jsonb,
  add column if not exists transaction_results jsonb not null default '{}'::jsonb;

comment on column public.bookkeeping_interactive_posting_commands.child_operations is
  'Map of bank transaction id to the durable QBO request/child operation id.';

comment on column public.bookkeeping_interactive_posting_commands.transaction_results is
  'Authoritative per-transaction posting outcomes, including safe and internal reason codes.';
