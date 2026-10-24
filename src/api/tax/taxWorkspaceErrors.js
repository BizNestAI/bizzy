import { TaxEngineError } from "../../services/tax/taxErrors.js";

function safeError(code, status, message, details) {
  return new TaxEngineError({ code, status, message, details });
}

export function workspaceReadError(error) {
  if (error instanceof TaxEngineError) return error;
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (code === "42P01" || code === "PGRST205" || /tax_workspace_(projections|projection_requests).*does not exist/i.test(message)) {
    return safeError(
      "tax_workspace_schema_unavailable",
      503,
      "Your Tax workspace is temporarily unavailable.",
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
