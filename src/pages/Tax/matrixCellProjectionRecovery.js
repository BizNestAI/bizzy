export async function loadMatrixCellWithProjectionRecovery({
  initialScope,
  loadDetail,
  refreshWorkspace,
  resolveScope,
  signal,
} = {}) {
  try {
    return { detail: await loadDetail(initialScope, signal), scope: initialScope, recovered: false };
  } catch (error) {
    if (!isTaxWorkspaceProjectionChanged(error) || signal?.aborted) throw error;
    const snapshot = await refreshWorkspace(signal);
    if (signal?.aborted) throw abortedError();
    const scope = resolveScope(snapshot);
    if (!scope) throw changedCellError();
    // Deliberately retry once. A second 409 remains terminal.
    return { detail: await loadDetail(scope, signal), scope, recovered: true };
  }
}

export function isTaxWorkspaceProjectionChanged(error) {
  return error?.code === "tax_workspace_projection_changed";
}

function changedCellError() {
  const error = new Error("The totals changed while this detail was loading. Open the updated cell and try again.");
  error.code = "tax_workspace_matrix_cell_changed";
  return error;
}

function abortedError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  error.code = "request_aborted";
  return error;
}
