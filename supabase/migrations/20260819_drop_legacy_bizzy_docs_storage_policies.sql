-- Remove legacy bizzy-docs Storage policies that only checked bucket_id.
--
-- The stricter tenant-aware policies from 20260818 are required because
-- permissive RLS policies combine with OR. A legacy policy such as:
--
--   bucket_id = 'bizzy-docs'
--
-- can bypass the stricter path/business-membership policy.
--
-- Current browser requirements for bizzy-docs:
--   SELECT: required for download/read/extract after upload.
--   INSERT: required for browser document upload.
--   UPDATE: not required; overwrite/rename should remain denied.
--   DELETE: not required; document deletion currently deletes the database row,
--           not the Storage object.

BEGIN;

DROP POLICY IF EXISTS "bizzy-docs select" ON storage.objects;
DROP POLICY IF EXISTS "bizzy-docs insert" ON storage.objects;
DROP POLICY IF EXISTS "bizzy-docs update" ON storage.objects;
DROP POLICY IF EXISTS "bizzy-docs delete" ON storage.objects;

DROP POLICY IF EXISTS bizzy_docs_member_select ON storage.objects;
DROP POLICY IF EXISTS bizzy_docs_member_insert ON storage.objects;

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

COMMIT;
