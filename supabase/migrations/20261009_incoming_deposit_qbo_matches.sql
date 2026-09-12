-- Launch-safe one-to-one matching between incoming Plaid deposits and existing QBO bank-affecting sales activity.
-- This migration is intentionally additive except for widening transaction_categorizations.status.

ALTER TABLE IF EXISTS job_revenue_documents
  ADD COLUMN IF NOT EXISTS amount_minor bigint,
  ADD COLUMN IF NOT EXISTS open_balance_minor bigint,
  ADD COLUMN IF NOT EXISTS deposit_account_ref jsonb,
  ADD COLUMN IF NOT EXISTS payment_ref_num text,
  ADD COLUMN IF NOT EXISTS payment_method_ref jsonb,
  ADD COLUMN IF NOT EXISTS linked_payment_ids text[],
  ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz;

ALTER TABLE IF EXISTS job_payment_records
  ADD COLUMN IF NOT EXISTS amount_minor bigint,
  ADD COLUMN IF NOT EXISTS unapplied_amount_minor bigint,
  ADD COLUMN IF NOT EXISTS customer_ref jsonb,
  ADD COLUMN IF NOT EXISTS payment_ref_num text,
  ADD COLUMN IF NOT EXISTS payment_method_ref jsonb,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS linked_invoice_ids text[],
  ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz;

ALTER TABLE IF EXISTS job_revenue_evidence
  ADD COLUMN IF NOT EXISTS qbo_txn_date date,
  ADD COLUMN IF NOT EXISTS amount_minor bigint,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS deposit_account_ref jsonb,
  ADD COLUMN IF NOT EXISTS private_note text,
  ADD COLUMN IF NOT EXISTS line_descriptions text[],
  ADD COLUMN IF NOT EXISTS line_entity_refs jsonb,
  ADD COLUMN IF NOT EXISTS linked_payment_ids text[],
  ADD COLUMN IF NOT EXISTS sync_token text,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'transaction_categorizations'
      AND constraint_name = 'transaction_categorizations_status_check'
  ) THEN
    ALTER TABLE transaction_categorizations DROP CONSTRAINT transaction_categorizations_status_check;
  END IF;

  ALTER TABLE transaction_categorizations
    ADD CONSTRAINT transaction_categorizations_status_check
    CHECK (status IN (
      'uncategorized',
      'needs_review',
      'approved',
      'auto_approved',
      'posted',
      'failed',
      'ignored',
      'handled',
      'matched_existing_qbo'
    ));
END $$;

CREATE OR REPLACE FUNCTION public.bookkeeping_transaction_matches_status(
  p_status_filter text,
  p_status text,
  p_meta jsonb,
  p_qbo_txn_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN lower(coalesce(p_status_filter, 'needs_review')) = 'pending'
      THEN false
    WHEN lower(coalesce(p_status_filter, 'needs_review')) = 'posted'
      THEN coalesce(p_status, '') = 'posted' OR p_qbo_txn_id IS NOT NULL
    WHEN lower(coalesce(p_status_filter, 'needs_review')) = 'reconciled'
      THEN coalesce(p_status, '') = 'matched_existing_qbo'
    WHEN lower(coalesce(p_status_filter, 'needs_review')) IN ('approved', 'handled')
      THEN coalesce(p_status, '') IN ('approved', 'auto_approved', 'failed')
    ELSE
      coalesce(p_status, 'needs_review') IN ('needs_review', 'uncategorized')
      OR (
        coalesce(p_status, '') = 'auto_approved'
        AND lower(coalesce(p_meta ->> 'is_check', 'false')) = 'true'
      )
  END;
$$;

REVOKE ALL ON FUNCTION public.bookkeeping_transaction_matches_status(text, text, jsonb, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bookkeeping_transaction_matches_status(text, text, jsonb, text) TO service_role;

CREATE TABLE IF NOT EXISTS bank_qbo_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN (
    'candidate',
    'needs_confirmation',
    'ambiguous',
    'confirmed',
    'rejected',
    'superseded',
    'reversed',
    'match_check_unavailable'
  )),
  match_type text NOT NULL CHECK (match_type IN (
    'qbo_deposit',
    'qbo_payment_direct',
    'qbo_sales_receipt_direct',
    'qbo_payment_with_invoice_context',
    'qbo_invoice_only_context',
    'unavailable'
  )),
  confidence_tier text NOT NULL CHECK (confidence_tier IN ('tier_1','tier_2','tier_3','tier_4','unavailable')),
  confidence_score numeric,
  reason_codes text[] NOT NULL DEFAULT '{}',
  gross_bank_amount_minor bigint NOT NULL,
  matched_qbo_amount_minor bigint,
  fee_amount_minor bigint,
  currency text,
  date_distance_days integer,
  bank_account_match text NOT NULL CHECK (bank_account_match IN (
    'verified_same_account',
    'unverified_mapping',
    'candidate_account_mismatch',
    'unavailable'
  )),
  plaid_account_id text,
  qbo_realm_id text,
  qbo_bank_account_id text,
  qbo_bank_account_name text,
  mapping_source text,
  mapping_confidence text,
  source_freshness_at timestamptz,
  request_idempotency_key text,
  created_by uuid,
  actor_role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  superseded_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT bank_qbo_matches_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT bank_qbo_matches_business_bank_txn_fkey
    FOREIGN KEY (business_id, bank_transaction_id)
    REFERENCES public.bank_transactions (business_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_qbo_match_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  qbo_entity_type text NOT NULL CHECK (qbo_entity_type IN ('Deposit','Payment','SalesReceipt','Invoice')),
  qbo_entity_id text NOT NULL,
  qbo_realm_id text,
  amount_allocated_minor bigint,
  customer_ref jsonb,
  invoice_ids text[],
  qbo_sync_token text,
  source_snapshot_at timestamptz,
  evidence_role text NOT NULL DEFAULT 'primary' CHECK (evidence_role IN ('primary','linked_context','supporting')),
  active_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT bank_qbo_match_items_match_business_fkey
    FOREIGN KEY (business_id, match_id)
    REFERENCES bank_qbo_matches (business_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_qbo_match_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid,
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  bank_transaction_id uuid,
  action text NOT NULL,
  previous_state jsonb,
  new_state jsonb,
  actor uuid,
  actor_role text,
  reason text,
  supersedes_match_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_qbo_match_history_match_business_fkey
    FOREIGN KEY (business_id, match_id)
    REFERENCES bank_qbo_matches (business_id, id),
  CONSTRAINT bank_qbo_match_history_supersedes_business_fkey
    FOREIGN KEY (business_id, supersedes_match_id)
    REFERENCES bank_qbo_matches (business_id, id),
  CONSTRAINT bank_qbo_match_history_bank_txn_business_fkey
    FOREIGN KEY (business_id, bank_transaction_id)
    REFERENCES public.bank_transactions (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_qbo_matches_one_active_confirmed_bank_txn
  ON bank_qbo_matches (business_id, bank_transaction_id)
  WHERE status = 'confirmed' AND superseded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bank_qbo_match_items_one_active_one_to_one_target
  ON bank_qbo_match_items (business_id, qbo_entity_type, qbo_entity_id)
  WHERE evidence_role = 'primary'
    AND active_confirmed = true
    AND qbo_entity_type IN ('Deposit','Payment','SalesReceipt');

CREATE UNIQUE INDEX IF NOT EXISTS bank_qbo_matches_request_idempotency
  ON bank_qbo_matches (business_id, request_idempotency_key)
  WHERE request_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS bank_qbo_matches_business_bank_idx
  ON bank_qbo_matches (business_id, bank_transaction_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS bank_qbo_match_items_entity_idx
  ON bank_qbo_match_items (business_id, qbo_entity_type, qbo_entity_id);

CREATE INDEX IF NOT EXISTS job_revenue_evidence_deposit_match_idx
  ON job_revenue_evidence (business_id, qbo_txn_type, qbo_txn_date, amount_minor);

CREATE INDEX IF NOT EXISTS job_payment_records_deposit_match_idx
  ON job_payment_records (business_id, payment_date, amount_minor);

CREATE INDEX IF NOT EXISTS job_revenue_documents_sales_receipt_match_idx
  ON job_revenue_documents (business_id, source_document_type, document_date, amount_minor);

ALTER TABLE public.bank_qbo_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_qbo_match_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_qbo_match_history ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'bank_qbo_matches',
    'bank_qbo_match_items',
    'bank_qbo_match_history'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS bqm_tenant_select ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY bqm_tenant_select ON public.%I FOR SELECT TO authenticated USING (business_id IS NOT NULL AND public.tax_user_owns_business(business_id))',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS bqm_tenant_insert ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY bqm_tenant_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (business_id IS NOT NULL AND public.tax_user_owns_business(business_id))',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS bqm_tenant_update ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY bqm_tenant_update ON public.%I FOR UPDATE TO authenticated USING (business_id IS NOT NULL AND public.tax_user_owns_business(business_id)) WITH CHECK (business_id IS NOT NULL AND public.tax_user_owns_business(business_id))',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS bqm_tenant_delete ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY bqm_tenant_delete ON public.%I FOR DELETE TO authenticated USING (business_id IS NOT NULL AND public.tax_user_owns_business(business_id))',
      table_name
    );
  END LOOP;
END $$;
