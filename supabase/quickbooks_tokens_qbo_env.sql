-- Adds environment-aware column and constraints for QuickBooks tokens
ALTER TABLE public.quickbooks_tokens
  ADD COLUMN IF NOT EXISTS qbo_env text NOT NULL DEFAULT 'production';

ALTER TABLE public.quickbooks_tokens
  ADD CONSTRAINT IF NOT EXISTS quickbooks_tokens_qbo_env_check
  CHECK (qbo_env IN ('sandbox', 'production'));

CREATE INDEX IF NOT EXISTS quickbooks_tokens_qbo_env_idx
  ON public.quickbooks_tokens (qbo_env);

-- Drop old unique constraint/index on business_id if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quickbooks_tokens_business_id_unique'
      AND conrelid = 'public.quickbooks_tokens'::regclass
  ) THEN
    ALTER TABLE public.quickbooks_tokens DROP CONSTRAINT quickbooks_tokens_business_id_unique;
  END IF;
END $$;

DROP INDEX IF EXISTS quickbooks_tokens_business_id_idx;

-- Shift the primary key to include qbo_env so sandbox/prod rows don't collide
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quickbooks_tokens_pkey'
      AND conrelid = 'public.quickbooks_tokens'::regclass
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.quickbooks_tokens'::regclass AND attname = 'business_id')
      ]
  ) THEN
    ALTER TABLE public.quickbooks_tokens DROP CONSTRAINT quickbooks_tokens_pkey;
  END IF;
END $$;

ALTER TABLE public.quickbooks_tokens
  ADD CONSTRAINT IF NOT EXISTS quickbooks_tokens_pkey PRIMARY KEY (business_id, qbo_env);
