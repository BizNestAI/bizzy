-- Complete the accounting review created by an operator-confirmed stale-pending
-- settlement in the same transaction as the authoritative type/GL approval.
-- All other accounting-review reasons remain hard blockers in application code.
CREATE OR REPLACE FUNCTION public.approve_bookkeeping_transactions_atomic(
  p_business_id uuid, p_actor_id uuid, p_actor_type text, p_approvals jsonb,
  p_require_needs_review boolean DEFAULT true
)
RETURNS SETOF public.transaction_categorizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  approval jsonb;
  current_row public.transaction_categorizations%ROWTYPE;
  bank_row public.bank_transactions%ROWTYPE;
  event_key text;
  inflow_decision jsonb;
  is_credit_card_inflow boolean;
BEGIN
  IF p_actor_type NOT IN ('user','admin','system','automation') THEN RAISE EXCEPTION 'invalid_approval_actor_type' USING ERRCODE='22023'; END IF;
  IF p_actor_type IN ('user','admin') AND p_actor_id IS NULL THEN RAISE EXCEPTION 'missing_approval_actor_id' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_approvals) <> 'array' OR jsonb_array_length(p_approvals)=0 THEN RAISE EXCEPTION 'missing_approvals' USING ERRCODE='22023'; END IF;

  FOR approval IN SELECT value FROM jsonb_array_elements(p_approvals) LOOP
    SELECT * INTO bank_row FROM public.bank_transactions bt
      WHERE bt.business_id=p_business_id AND bt.id=(approval->>'transaction_id')::uuid AND bt.is_archived=false FOR UPDATE;
    IF bank_row.id IS NULL THEN RAISE EXCEPTION 'approval_transaction_not_found' USING ERRCODE='P0002'; END IF;

    SELECT * INTO current_row FROM public.transaction_categorizations tc
      WHERE tc.business_id=p_business_id AND tc.transaction_id=(approval->>'transaction_id')::uuid FOR UPDATE;
    event_key := approval->>'approval_idempotency_key';
    IF coalesce(event_key,'')='' THEN RAISE EXCEPTION 'missing_approval_idempotency_key' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.bookkeeping_approval_events e WHERE e.business_id=p_business_id AND e.idempotency_key=event_key) THEN CONTINUE; END IF;
    IF p_require_needs_review AND current_row.id IS NOT NULL AND lower(coalesce(current_row.status,'needs_review')) NOT IN ('needs_review','uncategorized') THEN
      RAISE EXCEPTION 'transaction_not_needs_review' USING ERRCODE='40001';
    END IF;

    inflow_decision := approval#>'{meta,credit_card_inflow_resolution}';
    SELECT (
      (upper(coalesce(bank_row.direction,''))='INFLOW' OR coalesce(bank_row.amount,0)>0)
      AND EXISTS (
        SELECT 1 FROM public.plaid_qbo_account_mappings pam
        WHERE pam.business_id=p_business_id
          AND pam.plaid_account_id=bank_row.plaid_account_id
          AND regexp_replace(lower(coalesce(pam.qbo_account_type,'')),'[^a-z]','','g')='creditcard'
      )
    ) INTO is_credit_card_inflow;
    IF bank_row.accounting_review_required IS TRUE THEN
      IF bank_row.accounting_review_reason <> 'operator_confirmed_settlement'
         OR bank_row.pending IS TRUE
         OR bank_row.pending_resolution_state <> 'promoted_to_settled'
         OR bank_row.pending_resolution_payload->>'confirmed_at' IS NULL
         OR (is_credit_card_inflow AND (
           coalesce(inflow_decision->>'resolution_type','') NOT IN ('merchant_refund','credit_card_statement_credit')
           OR inflow_decision->>'destination_qbo_account_id' IS NULL
           OR inflow_decision->>'decided_by' IS NULL
           OR inflow_decision->>'decided_at' IS NULL
         )) THEN
        RAISE EXCEPTION 'credit_card_inflow_type_required' USING ERRCODE='22023';
      END IF;
      UPDATE public.bank_transactions SET
        accounting_review_required=false,
        accounting_review_reason=null,
        accounting_review_payload=null,
        updated_at=coalesce(nullif(approval->>'updated_at','')::timestamptz,now())
      WHERE business_id=p_business_id AND id=bank_row.id;
    END IF;

    INSERT INTO public.transaction_categorizations (
      business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,
      final_canonical_account_key,confidence,reason,decided_by,decided_at,updated_at,
      post_after,post_error,meta
    ) VALUES (
      p_business_id,(approval->>'transaction_id')::uuid,coalesce(approval->>'status','approved'),
      approval->>'final_qbo_account_id',approval->>'final_qbo_account_name',approval->>'final_canonical_account_key',
      approval->>'confidence',approval->>'reason',p_actor_type,(approval->>'decided_at')::timestamptz,
      (approval->>'updated_at')::timestamptz,nullif(approval->>'post_after','')::timestamptz,
      approval->>'post_error',coalesce(approval->'meta','{}'::jsonb)
    ) ON CONFLICT (business_id,transaction_id) DO UPDATE SET
      status=EXCLUDED.status,final_qbo_account_id=EXCLUDED.final_qbo_account_id,
      final_qbo_account_name=EXCLUDED.final_qbo_account_name,final_canonical_account_key=EXCLUDED.final_canonical_account_key,
      confidence=EXCLUDED.confidence,reason=EXCLUDED.reason,decided_by=EXCLUDED.decided_by,
      decided_at=EXCLUDED.decided_at,updated_at=EXCLUDED.updated_at,post_after=EXCLUDED.post_after,
      post_error=EXCLUDED.post_error,meta=EXCLUDED.meta;

    INSERT INTO public.bookkeeping_approval_events (
      business_id,transaction_id,actor_id,actor_type,resolution,final_qbo_account_id,post_after,idempotency_key,metadata
    ) VALUES (
      p_business_id,(approval->>'transaction_id')::uuid,p_actor_id,p_actor_type,
      coalesce(inflow_decision->>'resolution_type',approval#>>'{meta,user_selected_resolution}','categorize_new'),
      approval->>'final_qbo_account_id',nullif(approval->>'post_after','')::timestamptz,event_key,
      jsonb_build_object('source',coalesce(inflow_decision->>'operator_source','books_review'),
        'posting_generation',approval#>>'{meta,posting_generation}',
        'credit_card_inflow_resolution',inflow_decision,
        'statement_settlement_authority',approval#>'{meta,accounting_review_completed,statement_settlement_authority}')
    ) ON CONFLICT (business_id,idempotency_key) DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT tc.* FROM public.transaction_categorizations tc
    WHERE tc.business_id=p_business_id AND tc.transaction_id IN
      (SELECT (value->>'transaction_id')::uuid FROM jsonb_array_elements(p_approvals));
END; $$;

REVOKE ALL ON FUNCTION public.approve_bookkeeping_transactions_atomic(uuid,uuid,text,jsonb,boolean) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_bookkeeping_transactions_atomic(uuid,uuid,text,jsonb,boolean) TO service_role;
