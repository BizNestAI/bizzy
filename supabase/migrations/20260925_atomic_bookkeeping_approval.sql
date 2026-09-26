-- Commit a manual Books Review approval, its posting schedule and audit evidence
-- in one database transaction. Actor identity and actor type are deliberately
-- separate so text labels can never be cast into UUID columns.

CREATE TABLE IF NOT EXISTS public.bookkeeping_approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL,
  actor_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('user','admin','system','automation')),
  resolution text NOT NULL,
  final_qbo_account_id text,
  post_after timestamptz,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT bookkeeping_approval_events_transaction_fkey
    FOREIGN KEY (business_id, transaction_id)
    REFERENCES public.bank_transactions(business_id, id) ON DELETE CASCADE,
  CONSTRAINT bookkeeping_approval_events_idempotency_unique
    UNIQUE (business_id, idempotency_key)
);

ALTER TABLE public.bookkeeping_approval_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bookkeeping_approval_events FROM public, anon, authenticated;
GRANT ALL ON public.bookkeeping_approval_events TO service_role;

CREATE OR REPLACE FUNCTION public.approve_bookkeeping_transactions_atomic(
  p_business_id uuid,
  p_actor_id uuid,
  p_actor_type text,
  p_approvals jsonb,
  p_require_needs_review boolean DEFAULT true
)
RETURNS SETOF public.transaction_categorizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  approval jsonb;
  current_row public.transaction_categorizations%ROWTYPE;
  event_key text;
BEGIN
  IF p_actor_type NOT IN ('user','admin','system','automation') THEN
    RAISE EXCEPTION 'invalid_approval_actor_type' USING ERRCODE = '22023';
  END IF;
  IF p_actor_type IN ('user','admin') AND p_actor_id IS NULL THEN
    RAISE EXCEPTION 'missing_approval_actor_id' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_approvals) <> 'array' OR jsonb_array_length(p_approvals) = 0 THEN
    RAISE EXCEPTION 'missing_approvals' USING ERRCODE = '22023';
  END IF;

  FOR approval IN SELECT value FROM jsonb_array_elements(p_approvals)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.bank_transactions bt
      WHERE bt.business_id = p_business_id
        AND bt.id = (approval->>'transaction_id')::uuid
        AND bt.is_archived = false
      FOR UPDATE
    ) THEN
      RAISE EXCEPTION 'approval_transaction_not_found' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO current_row
    FROM public.transaction_categorizations tc
    WHERE tc.business_id = p_business_id
      AND tc.transaction_id = (approval->>'transaction_id')::uuid
    FOR UPDATE;

    event_key := approval->>'approval_idempotency_key';
    IF event_key IS NULL OR event_key = '' THEN
      RAISE EXCEPTION 'missing_approval_idempotency_key' USING ERRCODE = '22023';
    END IF;

    -- A retry of the same semantic approval is a read-only success. In
    -- particular, it must not create a new posting generation or audit row.
    IF EXISTS (
      SELECT 1 FROM public.bookkeeping_approval_events e
      WHERE e.business_id = p_business_id AND e.idempotency_key = event_key
    ) THEN
      CONTINUE;
    END IF;

    IF p_require_needs_review
       AND current_row.id IS NOT NULL
       AND lower(coalesce(current_row.status, 'needs_review')) NOT IN ('needs_review','uncategorized')
       THEN
      RAISE EXCEPTION 'transaction_not_needs_review' USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.transaction_categorizations (
      business_id, transaction_id, status, final_qbo_account_id,
      final_qbo_account_name, final_canonical_account_key, confidence, reason,
      decided_by, decided_at, updated_at, post_after, post_error, meta
    ) VALUES (
      p_business_id,
      (approval->>'transaction_id')::uuid,
      coalesce(approval->>'status', 'approved'),
      approval->>'final_qbo_account_id', approval->>'final_qbo_account_name',
      approval->>'final_canonical_account_key', approval->>'confidence',
      approval->>'reason', p_actor_type,
      (approval->>'decided_at')::timestamptz,
      (approval->>'updated_at')::timestamptz,
      nullif(approval->>'post_after','')::timestamptz,
      approval->>'post_error', coalesce(approval->'meta','{}'::jsonb)
    )
    ON CONFLICT (business_id, transaction_id) DO UPDATE SET
      status = EXCLUDED.status,
      final_qbo_account_id = EXCLUDED.final_qbo_account_id,
      final_qbo_account_name = EXCLUDED.final_qbo_account_name,
      final_canonical_account_key = EXCLUDED.final_canonical_account_key,
      confidence = EXCLUDED.confidence,
      reason = EXCLUDED.reason,
      decided_by = EXCLUDED.decided_by,
      decided_at = EXCLUDED.decided_at,
      updated_at = EXCLUDED.updated_at,
      post_after = EXCLUDED.post_after,
      post_error = EXCLUDED.post_error,
      meta = EXCLUDED.meta;

    INSERT INTO public.bookkeeping_approval_events (
      business_id, transaction_id, actor_id, actor_type, resolution,
      final_qbo_account_id, post_after, idempotency_key, metadata
    ) VALUES (
      p_business_id, (approval->>'transaction_id')::uuid, p_actor_id, p_actor_type,
      coalesce(approval#>>'{meta,user_selected_resolution}', 'categorize_new'),
      approval->>'final_qbo_account_id', nullif(approval->>'post_after','')::timestamptz,
      event_key, jsonb_build_object('source','books_review','posting_generation',approval#>>'{meta,posting_generation}')
    ) ON CONFLICT (business_id, idempotency_key) DO NOTHING;
  END LOOP;

  RETURN QUERY
  SELECT tc.* FROM public.transaction_categorizations tc
  WHERE tc.business_id = p_business_id
    AND tc.transaction_id IN (
      SELECT (value->>'transaction_id')::uuid FROM jsonb_array_elements(p_approvals)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_bookkeeping_transactions_atomic(uuid,uuid,text,jsonb,boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_bookkeeping_transactions_atomic(uuid,uuid,text,jsonb,boolean) TO service_role;
