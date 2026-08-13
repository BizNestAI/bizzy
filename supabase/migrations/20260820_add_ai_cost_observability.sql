-- Add server-only OpenAI token/cost observability while preserving the existing
-- gpt_usage query_count monthly cap semantics.
--
-- Browser clients keep read access only to the minimal usage fields needed by
-- the chat UI. Token/cost telemetry is written through a service-role-only RPC.

BEGIN;

ALTER TABLE public.gpt_usage
  ADD COLUMN IF NOT EXISTS input_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_input_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_write_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reasoning_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_openai_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_model text;

CREATE TABLE IF NOT EXISTS public.gpt_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid UNIQUE,
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.business_profiles(id) ON DELETE SET NULL,
  month text NOT NULL,
  model text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0,
  estimated_openai_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gpt_usage_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.gpt_usage_events FROM PUBLIC;
REVOKE ALL ON TABLE public.gpt_usage_events FROM anon;
REVOKE ALL ON TABLE public.gpt_usage_events FROM authenticated;
GRANT ALL ON TABLE public.gpt_usage_events TO service_role;

CREATE INDEX IF NOT EXISTS gpt_usage_events_user_month_idx
  ON public.gpt_usage_events (user_id, month);

CREATE INDEX IF NOT EXISTS gpt_usage_events_business_month_idx
  ON public.gpt_usage_events (business_id, month);

CREATE INDEX IF NOT EXISTS gpt_usage_events_model_month_idx
  ON public.gpt_usage_events (model, month);

REVOKE SELECT ON TABLE public.gpt_usage FROM authenticated;
GRANT SELECT (user_id, month, query_count, last_used) ON TABLE public.gpt_usage TO authenticated;
GRANT ALL ON TABLE public.gpt_usage TO service_role;

CREATE OR REPLACE FUNCTION public.record_bizzy_main_chat_usage(
  p_user_id uuid,
  p_business_id uuid,
  p_month text,
  p_model text,
  p_input_tokens bigint DEFAULT 0,
  p_cached_input_tokens bigint DEFAULT 0,
  p_cache_write_tokens bigint DEFAULT 0,
  p_output_tokens bigint DEFAULT 0,
  p_reasoning_tokens bigint DEFAULT 0,
  p_estimated_openai_cost_usd numeric DEFAULT 0,
  p_request_id uuid DEFAULT NULL
)
RETURNS TABLE (
  query_count integer,
  estimated_openai_cost_usd numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := now();
  v_month text := COALESCE(NULLIF(p_month, ''), to_char(v_now, 'YYYY-MM'));
  v_event_inserted integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'GPT_USAGE_USER_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.gpt_usage_events (
    request_id,
    user_id,
    business_id,
    month,
    model,
    input_tokens,
    cached_input_tokens,
    cache_write_tokens,
    output_tokens,
    reasoning_tokens,
    estimated_openai_cost_usd,
    created_at
  )
  VALUES (
    p_request_id,
    p_user_id,
    p_business_id,
    v_month,
    COALESCE(NULLIF(p_model, ''), 'unknown'),
    GREATEST(COALESCE(p_input_tokens, 0), 0),
    GREATEST(COALESCE(p_cached_input_tokens, 0), 0),
    GREATEST(COALESCE(p_cache_write_tokens, 0), 0),
    GREATEST(COALESCE(p_output_tokens, 0), 0),
    GREATEST(COALESCE(p_reasoning_tokens, 0), 0),
    GREATEST(COALESCE(p_estimated_openai_cost_usd, 0), 0),
    v_now
  )
  ON CONFLICT (request_id) DO NOTHING;

  GET DIAGNOSTICS v_event_inserted = ROW_COUNT;

  IF v_event_inserted = 0 AND p_request_id IS NOT NULL THEN
    RETURN QUERY
    SELECT gu.query_count, gu.estimated_openai_cost_usd
    FROM public.gpt_usage AS gu
    WHERE gu.user_id = p_user_id
      AND gu.month = v_month;
    RETURN;
  END IF;

  INSERT INTO public.gpt_usage (
    user_id,
    month,
    query_count,
    last_used,
    input_tokens,
    cached_input_tokens,
    cache_write_tokens,
    output_tokens,
    reasoning_tokens,
    estimated_openai_cost_usd,
    last_model
  )
  VALUES (
    p_user_id,
    v_month,
    1,
    v_now,
    GREATEST(COALESCE(p_input_tokens, 0), 0),
    GREATEST(COALESCE(p_cached_input_tokens, 0), 0),
    GREATEST(COALESCE(p_cache_write_tokens, 0), 0),
    GREATEST(COALESCE(p_output_tokens, 0), 0),
    GREATEST(COALESCE(p_reasoning_tokens, 0), 0),
    GREATEST(COALESCE(p_estimated_openai_cost_usd, 0), 0),
    COALESCE(NULLIF(p_model, ''), 'unknown')
  )
  ON CONFLICT (user_id, month) DO UPDATE
  SET
    query_count = public.gpt_usage.query_count + 1,
    last_used = EXCLUDED.last_used,
    input_tokens = public.gpt_usage.input_tokens + EXCLUDED.input_tokens,
    cached_input_tokens = public.gpt_usage.cached_input_tokens + EXCLUDED.cached_input_tokens,
    cache_write_tokens = public.gpt_usage.cache_write_tokens + EXCLUDED.cache_write_tokens,
    output_tokens = public.gpt_usage.output_tokens + EXCLUDED.output_tokens,
    reasoning_tokens = public.gpt_usage.reasoning_tokens + EXCLUDED.reasoning_tokens,
    estimated_openai_cost_usd = public.gpt_usage.estimated_openai_cost_usd + EXCLUDED.estimated_openai_cost_usd,
    last_model = EXCLUDED.last_model;

  RETURN QUERY
  SELECT gu.query_count, gu.estimated_openai_cost_usd
  FROM public.gpt_usage AS gu
  WHERE gu.user_id = p_user_id
    AND gu.month = v_month;
END;
$$;

REVOKE ALL ON FUNCTION public.record_bizzy_main_chat_usage(
  uuid, uuid, text, text, bigint, bigint, bigint, bigint, bigint, numeric, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_bizzy_main_chat_usage(
  uuid, uuid, text, text, bigint, bigint, bigint, bigint, bigint, numeric, uuid
) FROM anon;
REVOKE ALL ON FUNCTION public.record_bizzy_main_chat_usage(
  uuid, uuid, text, text, bigint, bigint, bigint, bigint, bigint, numeric, uuid
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_bizzy_main_chat_usage(
  uuid, uuid, text, text, bigint, bigint, bigint, bigint, bigint, numeric, uuid
) TO service_role;

COMMIT;
