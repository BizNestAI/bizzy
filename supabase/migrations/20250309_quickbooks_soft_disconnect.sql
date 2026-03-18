-- Soft disconnect support for QuickBooks tokens (non-destructive)

ALTER TABLE quickbooks_tokens
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_connected_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS company_id text NULL,
  ADD COLUMN IF NOT EXISTS display_name text NULL;

-- Ensure only one active token per business + env (if not already present)
CREATE UNIQUE INDEX IF NOT EXISTS quickbooks_tokens_business_env_uq
  ON quickbooks_tokens (business_id, qbo_env);

-- Backfill nulls for new columns
UPDATE quickbooks_tokens
  SET is_active = true
  WHERE is_active IS NULL;

UPDATE quickbooks_tokens
  SET status = 'active'
  WHERE status IS NULL OR status = '';
