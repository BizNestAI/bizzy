export function resolveCompletedPostingEligibilityExecution(existing) {
  if (!existing || existing.status === "running") return null;
  return { ...(existing.result || {}), idempotent: true, execution_id: existing.id };
}
