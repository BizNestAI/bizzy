export function resolveTaxWorkspacePrerequisites({
  authLoading = true,
  userId = null,
  businessId = null,
  adminLoading = true,
  adminActive = false,
  adminBusinessId = null,
} = {}) {
  const resolvedBusinessId = adminActive
    ? adminBusinessId
    : businessId;
  const pending = Boolean(
    adminLoading
    // Active Admin View comes from the server-verified opaque session. Its
    // selected business does not require a separate customer Supabase login.
    || (!adminActive && (authLoading || !userId))
    || !resolvedBusinessId
  );
  return {
    pending,
    businessId: pending ? null : resolvedBusinessId,
  };
}
