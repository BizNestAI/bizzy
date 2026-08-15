-- Business-level kill switch for automatic QuickBooks posting.
-- Default false is intentional: live Plaid/categorization testing must never
-- write to QuickBooks unless a business explicitly enables auto-posting.

ALTER TABLE public.business_profiles
  ADD COLUMN IF NOT EXISTS auto_post_to_quickbooks boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.business_profiles.auto_post_to_quickbooks IS
  'When true, eligible handled Books Review transactions may enter the QuickBooks posting grace-period workflow. False blocks automatic QuickBooks writes while allowing Plaid sync and categorization.';
