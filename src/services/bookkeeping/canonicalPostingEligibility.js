// Server-side, provider-free decision. Database ownership, cached accounts and
// compiled financial shape are authoritative; unavailable RPCs fail closed.
export async function canonicalPostingEligibility({ db, businessId, transactionId, env = "production", phase = "schedule" }) {
  const { data, error } = await db.rpc("canonical_posting_eligibility", {
    p_business_id: businessId, p_transaction_id: transactionId, p_env: env, p_phase: phase,
  });
  if (error || !data || typeof data !== "object") {
    const failure = new Error("canonical_posting_eligibility_unavailable");
    failure.code = "canonical_posting_eligibility_unavailable";
    throw failure;
  }
  return data;
}

export function financialPostingShape(payload = {}) {
  return {
    date: payload.TxnDate,
    source: String(payload.DepositToAccountRef?.value || payload.AccountRef?.value || ""),
    paymentType: payload.DepositToAccountRef ? "Deposit" : payload.PaymentType,
    credit: payload.Credit === true,
    totalMinor: payload.TotalAmt == null
      ? (payload.Line || []).reduce((sum, line) => sum + Math.round(Number(line.Amount) * 100), 0)
      : Math.round(Number(payload.TotalAmt) * 100),
    lines: (payload.Line || []).map(line => ({
      type: line.DetailType, amount: Number(line.Amount),
      account: String((line.DepositLineDetail || line.AccountBasedExpenseLineDetail)?.AccountRef?.value || ""),
    })),
  };
}

export function assertCompiledPostingShape(expected, actual) {
  if (JSON.stringify(financialPostingShape(expected)) !== JSON.stringify(financialPostingShape(actual))) {
    const error = new Error("compiled_posting_shape_changed");
    error.code = "compiled_posting_shape_changed";
    error.qbo_write_may_have_occurred = false;
    throw error;
  }
}
