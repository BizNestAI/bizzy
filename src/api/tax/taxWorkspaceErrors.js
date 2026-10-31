import { TaxEngineError } from "../../services/tax/taxErrors.js";

function safeError(code, status, message, details) {
  return new TaxEngineError({ code, status, message, details });
}

export function workspaceReadError(error) {
  if (error instanceof TaxEngineError) return error;
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  const status = Number(error?.status || error?.statusCode || 0);
  if (error?.name === "AbortError" || code === "ABORT_ERR" || /aborted|aborterror/i.test(message)) {
    return safeError("tax_workspace_request_cancelled", 499, "The Tax workspace request was cancelled.");
  }
  if (code === "42P01" || code === "PGRST205" || /tax_workspace_(projections|projection_requests).*does not exist/i.test(message)) {
    return safeError(
      "tax_workspace_schema_unavailable",
      503,
      "Your Tax workspace is temporarily unavailable.",
      { action: "retry" },
    );
  }
  if (code === "tax_workspace_live_population_mismatch") {
    return safeError(
      "tax_workspace_reconciliation_failed",
      409,
      "Your Tax workspace could not be reconciled with current tax data.",
      { action: "retry" },
    );
  }
  const implementationFailure = status === 400 || status === 414 || status === 431 ||
    code === "42703" || code === "42601" || code === "22P02" || /^PGRST(?!000)/.test(code);
  if (implementationFailure) {
    return safeError(
      "tax_workspace_internal_failure",
      500,
      "Your Tax workspace could not be loaded right now.",
      { action: "retry" },
    );
  }
  return safeError(
    "tax_workspace_database_unavailable",
    503,
    "Your Tax workspace could not be loaded right now.",
    { action: "retry" },
  );
}
