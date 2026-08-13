-- Read-only staging audit for deferred privilege and Supabase Storage surfaces.
--
-- Run manually against the staging Supabase Preview Branch only. Do not run
-- against production. This script does not modify data or schema.

-- 1. Default privileges for future objects.
SELECT
  n.nspname AS schema_name,
  r.rolname AS owner_role,
  d.defaclobjtype AS object_type,
  d.defaclacl AS acl
FROM pg_default_acl AS d
JOIN pg_namespace AS n ON n.oid = d.defaclnamespace
JOIN pg_roles AS r ON r.oid = d.defaclrole
WHERE n.nspname IN ('public', 'storage')
ORDER BY schema_name, owner_role, object_type;

-- 2. Public schema privileges. Browser roles should have USAGE, not CREATE.
SELECT
  n.nspname AS schema_name,
  r.rolname AS grantee,
  has_schema_privilege(r.rolname, n.oid, 'USAGE') AS has_usage,
  has_schema_privilege(r.rolname, n.oid, 'CREATE') AS has_create
FROM pg_namespace AS n
CROSS JOIN pg_roles AS r
WHERE n.nspname IN ('public', 'storage')
  AND r.rolname IN ('anon', 'authenticated', 'service_role', 'postgres')
ORDER BY schema_name, grantee;

-- 3. Existing public table grants to browser roles.
SELECT
  table_schema,
  table_name,
  grantee,
  privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
ORDER BY table_name, grantee, privilege_type;

-- 4. Existing public sequence grants to browser roles.
SELECT
  object_schema,
  object_name,
  grantee,
  privilege_type
FROM information_schema.usage_privileges
WHERE object_schema = 'public'
  AND object_type = 'SEQUENCE'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
ORDER BY object_name, grantee, privilege_type;

-- 5. Supabase Storage buckets. Review public=false for private buckets.
SELECT
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
FROM storage.buckets
ORDER BY name;

-- 6. Supabase Storage RLS policies.
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename IN ('buckets', 'objects')
ORDER BY tablename, policyname;

-- 7. Storage table grants to browser roles.
SELECT
  table_schema,
  table_name,
  grantee,
  privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'storage'
  AND table_name IN ('buckets', 'objects')
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
ORDER BY table_name, grantee, privilege_type;
