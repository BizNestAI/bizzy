-- READ-ONLY diagnostic for pre-RLS-lockdown ownership/membership integrity.
-- Do not run this against production unless you intentionally want a
-- metadata-only report. It does not inspect customer financial data.

SELECT
  bp.id AS business_id,
  bp.user_id AS profile_owner_user_id,
  ubl.user_id AS membership_user_id,
  ubl.role AS membership_role,
  CASE
    WHEN bp.user_id IS NULL THEN 'BUSINESS_PROFILE_MISSING_OWNER'
    WHEN ubl.id IS NULL THEN 'OWNER_MEMBERSHIP_MISSING'
    WHEN ubl.role IS DISTINCT FROM 'owner' THEN 'OWNER_MEMBERSHIP_ROLE_NOT_OWNER'
    ELSE 'OK'
  END AS consistency_status
FROM public.business_profiles bp
LEFT JOIN public.user_business_link ubl
  ON ubl.business_id = bp.id
 AND ubl.user_id = bp.user_id
ORDER BY consistency_status, bp.id;
