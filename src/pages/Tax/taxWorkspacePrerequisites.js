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
    authLoading
    || adminLoading
    || !userId
    || !resolvedBusinessId
  );
  return {
    pending,
    businessId: pending ? null : resolvedBusinessId,
  };
}
