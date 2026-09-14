-- Add executable, structured match conditions to existing vendor rules.
-- Missing conditions preserve existing unconditional vendor-rule behavior.

alter table if exists public.vendor_rules
  add column if not exists match_conditions jsonb;

comment on column public.vendor_rules.match_conditions is
  'Optional executable rule predicates. Version 1 uses signed integer minor units for amount.exact_minor; direction remains enforced by direction_hint.';
