export function resolveTaxWorkspacePrerequisites({
  authLoading = true,
  userId = null,
  businessLoading = true,
  businessId = null,
  currentBusinessId = null,
  adminLoading = true,
  adminActive = false,
  adminBusinessId = null,
} = {}) {
  const resolvedBusinessId = adminActive
    ? adminBusinessId
    : businessId || currentBusinessId;
  const pending = Boolean(
    authLoading
    || adminLoading
    || businessLoading
    || !userId
    || !resolvedBusinessId
  );
  return {
    pending,
    businessId: pending ? null : resolvedBusinessId,
  };
}
