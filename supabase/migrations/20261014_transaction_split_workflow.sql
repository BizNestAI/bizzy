CREATE TABLE IF NOT EXISTS public.transaction_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'posted', 'voided')),
  split_type text NOT NULL DEFAULT 'general' CHECK (split_type IN ('general')),
  total_amount_minor bigint NOT NULL CHECK (total_amount_minor > 0),
  currency text NOT NULL DEFAULT 'USD',
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_by uuid,
  confirmed_actor_type text,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  posted_qbo_txn_id text,
  posted_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_splits_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT transaction_splits_business_txn_fkey
    FOREIGN KEY (business_id, transaction_id)
    REFERENCES public.bank_transactions (business_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS transaction_splits_one_confirmed_per_txn_idx
  ON public.transaction_splits (business_id, transaction_id)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS transaction_splits_business_txn_idx
  ON public.transaction_splits (business_id, transaction_id, created_at DESC);

ALTER TABLE public.transaction_splits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.transaction_splits FROM public, anon, authenticated;
GRANT ALL ON TABLE public.transaction_splits TO service_role;
