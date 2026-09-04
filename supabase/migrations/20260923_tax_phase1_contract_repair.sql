-- Tax Phase 1 contract repair.
-- Adds the canonical review-state column expected by deduction drilldown RPCs.
-- This migration does not create classifications, calculate tax liability, or
-- backfill production transaction tax treatment.

alter table if exists public.transaction_tax_classifications
  add column if not exists requires_review boolean;

do $$
begin
  if to_regclass('public.transaction_tax_classifications') is not null then
    update public.transaction_tax_classifications
    set requires_review = true
    where requires_review is null;
  end if;
end $$;

alter table if exists public.transaction_tax_classifications
  alter column requires_review set default true;

alter table if exists public.transaction_tax_classifications
  alter column requires_review set not null;

do $$
begin
  if to_regclass('public.transaction_tax_classifications') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'transaction_tax_classifications'
         and column_name = 'requires_review'
     ) then
    comment on column public.transaction_tax_classifications.requires_review is
      'True when the tax classification still requires human review. Defaults to true so unknown/new classifications are conservative.';
  end if;
end $$;

notify pgrst, 'reload schema';

-- Read-only verification after application:
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'transaction_tax_classifications'
--   and column_name = 'requires_review';
--
-- select count(*) as null_requires_review_rows
-- from public.transaction_tax_classifications
-- where requires_review is null;
--
-- Rollback, only after deploying code that no longer reads requires_review:
-- alter table if exists public.transaction_tax_classifications
--   drop column if exists requires_review;
