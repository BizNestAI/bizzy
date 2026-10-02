-- Authoritative, business-scoped monthly chat credits.
-- Existing public.gpt_usage remains non-authoritative telemetry.
BEGIN;

CREATE TABLE IF NOT EXISTS public.business_chat_credit_buckets (
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  credit_limit integer NOT NULL DEFAULT 300,
  reserved_count integer NOT NULL DEFAULT 0,
  consumed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, period_start),
  CONSTRAINT business_chat_credit_period_month_start CHECK (extract(day FROM period_start) = 1),
  CONSTRAINT business_chat_credit_limit_nonnegative CHECK (credit_limit >= 0),
  CONSTRAINT business_chat_credit_reserved_nonnegative CHECK (reserved_count >= 0),
  CONSTRAINT business_chat_credit_consumed_nonnegative CHECK (consumed_count >= 0),
  CONSTRAINT business_chat_credit_within_limit CHECK (reserved_count + consumed_count <= credit_limit)
);

CREATE TABLE IF NOT EXISTS public.business_chat_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  period_start date NOT NULL,
  request_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  thread_id uuid REFERENCES public.gpt_threads(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
  units smallint NOT NULL DEFAULT 1 CHECK (units = 1),
  reservation_expires_at timestamptz NOT NULL,
  failure_classification text,
  response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, request_id),
  FOREIGN KEY (business_id, period_start)
    REFERENCES public.business_chat_credit_buckets(business_id, period_start) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS business_chat_credit_ledger_stale_idx
  ON public.business_chat_credit_ledger (reservation_expires_at)
  WHERE state = 'reserved';

ALTER TABLE public.gpt_messages ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS gpt_messages_business_request_role_uidx
  ON public.gpt_messages (business_id, request_id, role)
  WHERE request_id IS NOT NULL AND message_kind = 'conversation';

ALTER TABLE public.business_chat_credit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_chat_credit_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_chat_credit_bucket_member_read ON public.business_chat_credit_buckets;
CREATE POLICY business_chat_credit_bucket_member_read
  ON public.business_chat_credit_buckets FOR SELECT TO authenticated
  USING (public.is_member(auth.uid(), business_id));

DROP POLICY IF EXISTS business_chat_credit_ledger_member_read ON public.business_chat_credit_ledger;
CREATE POLICY business_chat_credit_ledger_member_read
  ON public.business_chat_credit_ledger FOR SELECT TO authenticated
  USING (public.is_member(auth.uid(), business_id));

REVOKE ALL ON public.business_chat_credit_buckets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.business_chat_credit_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT (business_id, period_start, credit_limit, reserved_count, consumed_count, created_at, updated_at)
  ON public.business_chat_credit_buckets TO authenticated;
GRANT SELECT (id, business_id, period_start, request_id, user_id, thread_id, state, units, created_at, updated_at)
  ON public.business_chat_credit_ledger TO authenticated;
GRANT ALL ON public.business_chat_credit_buckets TO service_role;
GRANT ALL ON public.business_chat_credit_ledger TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_business_chat_credit(
  p_business_id uuid,
  p_request_id uuid,
  p_user_id uuid,
  p_thread_id uuid DEFAULT NULL,
  p_reservation_seconds integer DEFAULT 180
) RETURNS TABLE (
  outcome text, period_start date, credit_limit integer, reserved_count integer,
  consumed_count integer, remaining integer, reservation_expires_at timestamptz,
  response_payload jsonb
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_period date := date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date;
  v_bucket public.business_chat_credit_buckets%ROWTYPE;
  v_ledger public.business_chat_credit_ledger%ROWTYPE;
BEGIN
  IF p_business_id IS NULL OR p_request_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'CHAT_CREDIT_IDENTIFIERS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.business_chat_credit_buckets (business_id, period_start)
  VALUES (p_business_id, v_period)
  ON CONFLICT ON CONSTRAINT business_chat_credit_buckets_pkey DO NOTHING;

  SELECT b.* INTO v_bucket FROM public.business_chat_credit_buckets b
  WHERE b.business_id = p_business_id AND b.period_start = v_period FOR UPDATE;

  SELECT l.* INTO v_ledger FROM public.business_chat_credit_ledger l
  WHERE l.business_id = p_business_id AND l.request_id = p_request_id;
  IF FOUND THEN
    RETURN QUERY SELECT
      CASE v_ledger.state WHEN 'consumed' THEN 'duplicate_consumed'
        WHEN 'reserved' THEN 'duplicate_in_progress' ELSE 'duplicate_released' END,
      v_bucket.period_start, v_bucket.credit_limit, v_bucket.reserved_count,
      v_bucket.consumed_count, v_bucket.credit_limit - v_bucket.reserved_count - v_bucket.consumed_count,
      v_ledger.reservation_expires_at, v_ledger.response_payload;
    RETURN;
  END IF;

  IF v_bucket.reserved_count + v_bucket.consumed_count >= v_bucket.credit_limit THEN
    RETURN QUERY SELECT 'exhausted'::text, v_bucket.period_start, v_bucket.credit_limit,
      v_bucket.reserved_count, v_bucket.consumed_count, 0,
      NULL::timestamptz, NULL::jsonb;
    RETURN;
  END IF;

  INSERT INTO public.business_chat_credit_ledger
    (business_id, period_start, request_id, user_id, thread_id, state, reservation_expires_at)
  VALUES
    (p_business_id, v_period, p_request_id, p_user_id, p_thread_id, 'reserved',
     clock_timestamp() + make_interval(secs => GREATEST(p_reservation_seconds, 120)));

  UPDATE public.business_chat_credit_buckets b
  SET reserved_count = b.reserved_count + 1, updated_at = clock_timestamp()
  WHERE b.business_id = p_business_id AND b.period_start = v_period
  RETURNING b.* INTO v_bucket;

  RETURN QUERY SELECT 'reserved'::text, v_bucket.period_start, v_bucket.credit_limit,
    v_bucket.reserved_count, v_bucket.consumed_count,
    v_bucket.credit_limit - v_bucket.reserved_count - v_bucket.consumed_count,
    clock_timestamp() + make_interval(secs => GREATEST(p_reservation_seconds, 120)), NULL::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_business_chat_credit(
  p_business_id uuid, p_request_id uuid, p_thread_id uuid DEFAULT NULL, p_response_payload jsonb DEFAULT NULL
) RETURNS TABLE (outcome text, period_start date, credit_limit integer, reserved_count integer, consumed_count integer, remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_ledger public.business_chat_credit_ledger%ROWTYPE;
  v_bucket public.business_chat_credit_buckets%ROWTYPE;
BEGIN
  SELECT l.* INTO v_ledger FROM public.business_chat_credit_ledger l
  WHERE l.business_id = p_business_id AND l.request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAT_CREDIT_RESERVATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  SELECT b.* INTO v_bucket FROM public.business_chat_credit_buckets b
  WHERE b.business_id = v_ledger.business_id AND b.period_start = v_ledger.period_start FOR UPDATE;

  IF v_ledger.state = 'reserved' THEN
    UPDATE public.business_chat_credit_ledger l SET state = 'consumed',
      thread_id = COALESCE(p_thread_id, l.thread_id), response_payload = COALESCE(p_response_payload, l.response_payload),
      failure_classification = NULL, updated_at = clock_timestamp()
    WHERE l.id = v_ledger.id;
    UPDATE public.business_chat_credit_buckets b SET reserved_count = b.reserved_count - 1,
      consumed_count = b.consumed_count + 1, updated_at = clock_timestamp()
    WHERE b.business_id = v_ledger.business_id AND b.period_start = v_ledger.period_start RETURNING b.* INTO v_bucket;
    RETURN QUERY SELECT 'consumed'::text, v_bucket.period_start, v_bucket.credit_limit,
      v_bucket.reserved_count, v_bucket.consumed_count,
      v_bucket.credit_limit - v_bucket.reserved_count - v_bucket.consumed_count;
  ELSIF v_ledger.state = 'consumed' THEN
    RETURN QUERY SELECT 'already_consumed'::text, v_bucket.period_start, v_bucket.credit_limit,
      v_bucket.reserved_count, v_bucket.consumed_count,
      v_bucket.credit_limit - v_bucket.reserved_count - v_bucket.consumed_count;
  ELSE
    RETURN QUERY SELECT 'already_released'::text, v_bucket.period_start, v_bucket.credit_limit,
      v_bucket.reserved_count, v_bucket.consumed_count,
      v_bucket.credit_limit - v_bucket.reserved_count - v_bucket.consumed_count;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_business_chat_credit(
  p_business_id uuid, p_request_id uuid, p_failure_classification text DEFAULT 'operational_failure'
) RETURNS TABLE (outcome text, period_start date, credit_limit integer, reserved_count integer, consumed_count integer, remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_ledger public.business_chat_credit_ledger%ROWTYPE;
  v_bucket public.business_chat_credit_buckets%ROWTYPE;
BEGIN
  SELECT l.* INTO v_ledger FROM public.business_chat_credit_ledger l
  WHERE l.business_id = p_business_id AND l.request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAT_CREDIT_RESERVATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT b.* INTO v_bucket FROM public.business_chat_credit_buckets b
  WHERE b.business_id = v_ledger.business_id AND b.period_start = v_ledger.period_start FOR UPDATE;
  IF v_ledger.state = 'reserved' THEN
    UPDATE public.business_chat_credit_ledger l SET state = 'released',
      failure_classification = left(COALESCE(NULLIF(p_failure_classification, ''), 'operational_failure'), 80),
      response_payload = NULL, updated_at = clock_timestamp() WHERE l.id = v_ledger.id;
    UPDATE public.business_chat_credit_buckets b SET reserved_count = b.reserved_count - 1,
      updated_at = clock_timestamp()
    WHERE b.business_id = v_ledger.business_id AND b.period_start = v_ledger.period_start RETURNING b.* INTO v_bucket;
    RETURN QUERY SELECT 'released'::text, v_bucket.period_start, v_bucket.credit_limit,
      v_bucket.reserved_count, v_bucket.consumed_count,
      v_bucket.credit_limit - v_bucket.reserved_count - v_bucket.consumed_count;
  ELSE
    RETURN QUERY SELECT ('already_' || v_ledger.state)::text, v_bucket.period_start, v_bucket.credit_limit,
      v_bucket.reserved_count, v_bucket.consumed_count,
      v_bucket.credit_limit - v_bucket.reserved_count - v_bucket.consumed_count;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_business_chat_credit_status(p_business_id uuid)
RETURNS TABLE (period_start date, credit_limit integer, reserved_count integer, consumed_count integer, remaining integer, reset_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE AS $$
  WITH period AS (SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date AS start_date)
  SELECT p.start_date, COALESCE(b.credit_limit, 300), COALESCE(b.reserved_count, 0), COALESCE(b.consumed_count, 0),
    COALESCE(b.credit_limit - b.reserved_count - b.consumed_count, 300),
    ((p.start_date + INTERVAL '1 month')::timestamp AT TIME ZONE 'UTC')
  FROM period p LEFT JOIN public.business_chat_credit_buckets b
    ON b.business_id = p_business_id AND b.period_start = p.start_date;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_business_chat_credits(p_before timestamptz DEFAULT clock_timestamp())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer := 0; v_row record;
BEGIN
  FOR v_row IN SELECT l.business_id, l.request_id FROM public.business_chat_credit_ledger l
    WHERE l.state = 'reserved' AND l.reservation_expires_at < p_before ORDER BY l.reservation_expires_at FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public.release_business_chat_credit(v_row.business_id, v_row.request_id, 'stale_reservation');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_business_chat_credit(uuid, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_business_chat_credit(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_business_chat_credit(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_business_chat_credit_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_stale_business_chat_credits(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_business_chat_credit(uuid, uuid, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_business_chat_credit(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_business_chat_credit(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_business_chat_credit_status(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_business_chat_credits(timestamptz) TO service_role;

COMMIT;
