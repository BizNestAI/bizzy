-- Focus Bizzi Docs into tenant-scoped accounting documents without removing legacy docs.

alter table public.bizzy_docs
  add column if not exists uploaded_by_user_id uuid,
  add column if not exists year integer,
  add column if not exists month integer,
  add column if not exists document_type text,
  add column if not exists financial_account_id text,
  add column if not exists original_filename text,
  add column if not exists file_size bigint;

alter table public.bizzy_docs
  drop constraint if exists bizzy_docs_accounting_year_check,
  add constraint bizzy_docs_accounting_year_check
    check (year is null or year >= 2026);

alter table public.bizzy_docs
  drop constraint if exists bizzy_docs_accounting_month_check,
  add constraint bizzy_docs_accounting_month_check
    check (month is null or month between 1 and 12);

alter table public.bizzy_docs
  drop constraint if exists bizzy_docs_accounting_document_type_check,
  add constraint bizzy_docs_accounting_document_type_check
    check (
      document_type is null
      or document_type in (
        'bank_statement',
        'credit_card_statement',
        'loan_statement',
        'payroll_report',
        'receipt_support',
        'other_accounting_document'
      )
    );

create index if not exists bizzy_docs_business_year_month_created_idx
  on public.bizzy_docs (business_id, year, month, created_at desc)
  where storage_path is not null;

insert into storage.buckets (id, name, public)
values ('bizzy-docs', 'bizzy-docs', false)
on conflict (id) do update
set public = false;
