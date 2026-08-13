-- Durable Stripe webhook replay/idempotency guard.
--
-- The application records the Stripe event id before applying side effects.
-- The unique event_id constraint prevents concurrent duplicate deliveries from
-- processing the same event twice across server restarts.

BEGIN;

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  event_type text,
  stripe_mode text,
  processing_status text NOT NULL DEFAULT 'processing',
  processing_started_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  CONSTRAINT stripe_webhook_events_event_id_key UNIQUE (event_id),
  CONSTRAINT stripe_webhook_events_status_check CHECK (
    processing_status IN ('processing', 'processed', 'failed')
  ),
  CONSTRAINT stripe_webhook_events_attempt_count_check CHECK (attempt_count >= 0)
);

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.stripe_webhook_events FROM PUBLIC;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM anon;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM authenticated;
GRANT ALL ON TABLE public.stripe_webhook_events TO service_role;

CREATE INDEX IF NOT EXISTS stripe_webhook_events_status_idx
  ON public.stripe_webhook_events (processing_status, processing_started_at, received_at);

COMMIT;
