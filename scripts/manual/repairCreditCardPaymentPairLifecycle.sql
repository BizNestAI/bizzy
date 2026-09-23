-- GUARDED, EXPLICIT REPAIR TEMPLATE. This file is never run by migrations or
-- application startup. Do not run without reviewing the read-only audit first.
-- Execute in a transaction after replacing the two UUID placeholders. The call
-- reuses the same locking, validation, uniqueness, audit, and atomic lifecycle
-- path as customer/admin confirmation. Any failed validation rolls back.
begin;

select public.confirm_credit_card_payment_pair_atomic(
  '<BUSINESS_UUID>'::uuid,
  '<PAIR_UUID>'::uuid,
  'guarded_operator_repair',
  'partial_pair_repair'
);

-- Inspect both legs and the two audit rows before changing this to COMMIT.
rollback;
