// Loading depends on usable scoped data, never on a minimum animation duration.
export function resolveModuleDataState({ hasData = false, fetching = false, error = null, scopeMatches = true } = {}) {
  if (!scopeMatches) return 'scope_changing';
  if (error) return hasData ? 'error_with_cache' : 'error_without_cache';
  if (!hasData) return 'initial_loading';
  return fetching ? 'refreshing' : 'ready';
}
export function unsafeModuleError(error) {
  return [401, 403].includes(Number(error?.status)) || ['module_scope_invalidated', 'tax_workspace_version_mismatch'].includes(error?.code);
}
