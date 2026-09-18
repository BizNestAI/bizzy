-- Additive storage for protected loan-payment review, learning, and split posting.
-- This migration is not applied by this task.

CREATE TABLE IF NOT EXISTS public.loan_lender_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  lender_display_name text NOT NULL,
  normalized_lender text,
  provider_merchant_id text,
  descriptor_fingerprint text,
  match_specificity text NOT NULL CHECK (match_specificity IN (
    'exact_provider_lender_id',
    'exact_normalized_lender',
    'exact_descriptor_fingerprint',
    'memo_fingerprint'
  )),
  source_type text NOT NULL DEFAULT 'business_lender_profile' CHECK (source_type = 'business_lender_profile'),
  authority text NOT NULL CHECK (authority IN ('user_confirmed','bookkeeper_confirmed','admin_confirmed')),
  source_transaction_id uuid,
  source_plaid_account_id uuid,
  qbo_vendor_id text,
  actor_id uuid,
  actor_type text,
  default_principal_qbo_account_id text,
  default_interest_qbo_account_id text,
  default_fee_qbo_account_id text,
  typical_payment_amount_minor bigint,
  amount_tolerance_minor bigint,
  expected_cadence text,
  first_confirmed_at timestamptz,
  last_confirmed_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','inactive')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT loan_lender_profiles_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT loan_lender_profiles_business_source_txn_fkey
    FOREIGN KEY (business_id, source_transaction_id)
    REFERENCES public.bank_transactions (business_id, id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS loan_lender_profiles_provider_active_idx
  ON public.loan_lender_profiles (business_id, provider_merchant_id)
  WHERE status = 'active' AND provider_merchant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS loan_lender_profiles_fingerprint_active_idx
  ON public.loan_lender_profiles (business_id, descriptor_fingerprint)
  WHERE status = 'active' AND provider_merchant_id IS NULL AND descriptor_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS loan_lender_profiles_source_account_idx
  ON public.loan_lender_profiles (business_id, source_plaid_account_id)
  WHERE status = 'active' AND source_plaid_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.loan_payment_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL,
  lender_profile_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','posted','superseded','void')),
  principal_amount_minor bigint NOT NULL DEFAULT 0 CHECK (principal_amount_minor >= 0),
  principal_qbo_account_id text,
  principal_qbo_account_name text,
  interest_amount_minor bigint NOT NULL DEFAULT 0 CHECK (interest_amount_minor >= 0),
  interest_qbo_account_id text,
  interest_qbo_account_name text,
  fee_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  currency text NOT NULL DEFAULT 'USD',
  confirmed_by uuid,
  confirmed_actor_type text,
  confirmed_at timestamptz,
  posted_qbo_txn_id text,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT loan_payment_splits_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT loan_payment_splits_business_txn_fkey
    FOREIGN KEY (business_id, transaction_id)
    REFERENCES public.bank_transactions (business_id, id)
    ON DELETE CASCADE,
  CONSTRAINT loan_payment_splits_profile_fkey
    FOREIGN KEY (business_id, lender_profile_id)
    REFERENCES public.loan_lender_profiles (business_id, id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS loan_payment_splits_one_confirmed_per_txn_idx
  ON public.loan_payment_splits (business_id, transaction_id)
  WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS public.loan_payment_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  transaction_id uuid,
  lender_profile_id uuid,
  split_id uuid,
  event_type text NOT NULL,
  actor_id uuid,
  actor_type text,
  previous_state jsonb,
  next_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS loan_payment_audit_events_business_txn_idx
  ON public.loan_payment_audit_events (business_id, transaction_id, created_at DESC);

ALTER TABLE public.loan_lender_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_payment_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_payment_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.loan_lender_profiles FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.loan_payment_splits FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.loan_payment_audit_events FROM public, anon, authenticated;
GRANT ALL ON TABLE public.loan_lender_profiles TO service_role;
GRANT ALL ON TABLE public.loan_payment_splits TO service_role;
GRANT ALL ON TABLE public.loan_payment_audit_events TO service_role;
