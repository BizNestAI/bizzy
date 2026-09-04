-- Tax Profile first-save contract repair.
-- Unknown optional planning facts must be nullable so a sparse draft profile can
-- be saved without fabricating zeros or default reserve preferences.

alter table if exists public.tax_profiles
  alter column federal_withholding_ytd drop default,
  alter column federal_withholding_ytd drop not null,
  alter column state_withholding_ytd drop default,
  alter column state_withholding_ytd drop not null,
  alter column health_insurance_deduction_ytd drop default,
  alter column health_insurance_deduction_ytd drop not null,
  alter column retirement_contributions_ytd drop default,
  alter column retirement_contributions_ytd drop not null,
  alter column hsa_contributions_ytd drop default,
  alter column hsa_contributions_ytd drop not null,
  alter column reserve_buffer_percent drop default,
  alter column reserve_buffer_percent drop not null;

comment on column public.tax_profiles.federal_withholding_ytd is
  'Optional user-provided year-to-date federal withholding. NULL means unknown/not provided; 0 means explicitly zero.';
comment on column public.tax_profiles.state_withholding_ytd is
  'Optional user-provided year-to-date state withholding. NULL means unknown/not provided; 0 means explicitly zero.';
comment on column public.tax_profiles.health_insurance_deduction_ytd is
  'Optional user-provided year-to-date self-employed health insurance deduction input. NULL means unknown/not provided; 0 means explicitly zero.';
comment on column public.tax_profiles.retirement_contributions_ytd is
  'Optional user-provided year-to-date retirement contribution planning input. NULL means unknown/not provided; 0 means explicitly zero.';
comment on column public.tax_profiles.hsa_contributions_ytd is
  'Optional user-provided year-to-date HSA contribution planning input. NULL means unknown/not provided; 0 means explicitly zero.';
comment on column public.tax_profiles.reserve_buffer_percent is
  'Optional user-provided planning reserve buffer stored by the application as a decimal ratio. NULL means no reserve preference was provided; 0 means explicitly zero.';

-- Verification:
-- select column_name, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'tax_profiles'
--   and column_name in (
--     'federal_withholding_ytd',
--     'state_withholding_ytd',
--     'health_insurance_deduction_ytd',
--     'retirement_contributions_ytd',
--     'hsa_contributions_ytd',
--     'reserve_buffer_percent'
--   )
-- order by column_name;

-- Rollback, only if current rows are compatible with the old default/not-null
-- contract and product explicitly accepts treating unknown facts as defaults:
-- alter table public.tax_profiles
--   alter column federal_withholding_ytd set default 0,
--   alter column federal_withholding_ytd set not null,
--   alter column state_withholding_ytd set default 0,
--   alter column state_withholding_ytd set not null,
--   alter column health_insurance_deduction_ytd set default 0,
--   alter column health_insurance_deduction_ytd set not null,
--   alter column retirement_contributions_ytd set default 0,
--   alter column retirement_contributions_ytd set not null,
--   alter column hsa_contributions_ytd set default 0,
--   alter column hsa_contributions_ytd set not null,
--   alter column reserve_buffer_percent set default 5,
--   alter column reserve_buffer_percent set not null;

notify pgrst, 'reload schema';
