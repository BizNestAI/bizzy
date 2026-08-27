export function normalizeExpectedQboAccountCreationResult(err) {
  const body = err?.body || {};
  const code = body.code || body.error || err?.code || err?.error || err?.message;
  if (
    err?.status === 409 &&
    (code === "qbo_account_already_exists" || code === "qbo_inactive_account_exists")
  ) {
    const existing = body.existing_account || body.details?.existing_account || {};
    return {
      ok: false,
      expected: true,
      code,
      error: code,
      existing_account_id: existing.id || null,
      existing_account_name: existing.name || null,
      active: existing.active ?? null,
      existing_account: existing,
    };
  }
  return null;
}

export default {
  normalizeExpectedQboAccountCreationResult,
};
