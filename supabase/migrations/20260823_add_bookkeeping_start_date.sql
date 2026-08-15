-- Authoritative business-level start date for active Bizzi bookkeeping.
-- NULL preserves legacy behavior: all imported transactions remain active.

ALTER TABLE public.business_profiles
  ADD COLUMN IF NOT EXISTS bookkeeping_start_date date;

COMMENT ON COLUMN public.business_profiles.bookkeeping_start_date IS
  'First transaction date that should enter active Bizzi bookkeeping review, categorization, posting, reporting, tax, and job-costing workflows. NULL means no cutoff.';

CREATE INDEX IF NOT EXISTS business_profiles_bookkeeping_start_date_idx
  ON public.business_profiles (bookkeeping_start_date)
  WHERE bookkeeping_start_date IS NOT NULL;
