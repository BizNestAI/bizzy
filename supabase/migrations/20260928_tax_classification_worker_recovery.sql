BEGIN;

CREATE OR REPLACE FUNCTION public.claim_tax_classification_runs(
  p_worker_id text,
  p_batch_size integer DEFAULT 5,
  p_now timestamptz DEFAULT now()
)
RETURNS SETOF public.tax_classification_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 25 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 25';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT r.id
    FROM public.tax_classification_runs r
    WHERE r.attempt_count < r.max_attempts
      AND (
        (
          r.status IN ('queued', 'failed')
          AND r.process_after <= p_now
          AND (r.locked_at IS NULL OR r.locked_at < p_now - interval '15 minutes')
        )
        OR (
          r.status = 'running'
          AND r.locked_at < p_now - interval '15 minutes'
        )
      )
    ORDER BY
      CASE WHEN r.status = 'running' THEN 0 ELSE 1 END,
      r.process_after ASC,
      r.created_at ASC,
      r.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.tax_classification_runs r
    SET status = 'running',
        locked_at = p_now,
        locked_by = p_worker_id,
        started_at = COALESCE(r.started_at, p_now),
        heartbeat_at = p_now,
        attempt_count = r.attempt_count + 1,
        last_error_code = NULL,
        last_error_message = NULL
  FROM due
  WHERE r.id = due.id
  RETURNING r.*;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_tax_classification_runs(text, integer, timestamptz) TO service_role;

CREATE INDEX IF NOT EXISTS tax_classification_runs_stale_running_idx
  ON public.tax_classification_runs (locked_at, process_after, created_at)
  WHERE status = 'running';

COMMIT;
