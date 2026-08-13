-- Harden Supabase Storage tenant isolation for customer-data buckets.
--
-- Buckets:
--   - bizzy-docs: browser upload/read for authorized business members.
--   - financial-reports: private report objects; browser read/sign only for
--     authorized business members, writes remain backend/service-role.
--   - bid-attachments: private bid/job attachments; browser read/sign only
--     for authorized business members, writes remain backend/service-role.
--
-- Object paths must begin with:
--   <business_id>/...
--
-- This migration configures buckets as private and uses storage.objects RLS
-- policies tied to the canonical Bizzi business membership helper.

BEGIN;

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('bizzy-docs', 'bizzy-docs', false),
  ('financial-reports', 'financial-reports', false),
  ('bid-attachments', 'bid-attachments', false)
ON CONFLICT (id) DO UPDATE
SET public = false;

CREATE OR REPLACE FUNCTION public.bizzi_storage_object_business_id(
  p_object_name text
)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN split_part(p_object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN split_part(p_object_name, '/', 1)::uuid
    ELSE NULL::uuid
  END;
$$;

REVOKE ALL ON FUNCTION public.bizzi_storage_object_business_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bizzi_storage_object_business_id(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.bizzi_storage_object_business_id(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bizzi_storage_object_business_id(text) TO service_role;

DROP POLICY IF EXISTS bizzy_docs_member_select ON storage.objects;
DROP POLICY IF EXISTS bizzy_docs_member_insert ON storage.objects;
DROP POLICY IF EXISTS financial_reports_member_select ON storage.objects;
DROP POLICY IF EXISTS bid_attachments_member_select ON storage.objects;

CREATE POLICY bizzy_docs_member_select
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'bizzy-docs'
  AND public.bizzi_current_user_is_business_member(
    public.bizzi_storage_object_business_id(name)
  )
);

CREATE POLICY bizzy_docs_member_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'bizzy-docs'
  AND public.bizzi_current_user_is_business_member(
    public.bizzi_storage_object_business_id(name)
  )
);

CREATE POLICY financial_reports_member_select
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'financial-reports'
  AND public.bizzi_current_user_is_business_member(
    public.bizzi_storage_object_business_id(name)
  )
);

CREATE POLICY bid_attachments_member_select
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'bid-attachments'
  AND public.bizzi_current_user_is_business_member(
    public.bizzi_storage_object_business_id(name)
  )
);

COMMIT;
