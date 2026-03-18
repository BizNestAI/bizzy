-- Make Stripe billing state mode-aware so test and live do not reuse the same
-- customer/subscription identifiers.

alter table public.business_billing
  add column if not exists stripe_customer_id_live text,
  add column if not exists stripe_customer_id_test text,
  add column if not exists stripe_subscription_id_live text,
  add column if not exists stripe_subscription_id_test text,
  add column if not exists subscription_status_live text,
  add column if not exists subscription_status_test text,
  add column if not exists plan_price_id_live text,
  add column if not exists plan_price_id_test text,
  add column if not exists current_period_end_live timestamptz,
  add column if not exists current_period_end_test timestamptz,
  add column if not exists trial_end_live timestamptz,
  add column if not exists trial_end_test timestamptz,
  add column if not exists cancel_at_period_end_live boolean,
  add column if not exists cancel_at_period_end_test boolean,
  add column if not exists last_invoice_status_live text,
  add column if not exists last_invoice_status_test text,
  add column if not exists canceled_at_live timestamptz,
  add column if not exists canceled_at_test timestamptz,
  add column if not exists last_invoice_id_live text,
  add column if not exists last_invoice_id_test text,
  add column if not exists last_payment_failed_at_live timestamptz,
  add column if not exists last_payment_failed_at_test timestamptz,
  add column if not exists plan_type_live text,
  add column if not exists plan_type_test text;
