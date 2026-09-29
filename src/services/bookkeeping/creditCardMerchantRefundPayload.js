function nonnegativeMagnitude(value, fieldName = "amount") {
  const amount = Math.abs(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error(`invalid_${fieldName}`);
    error.code = `invalid_${fieldName}`;
    throw error;
  }
  return amount;
}

// QBO represents a card refund as a Purchase whose Credit flag supplies the
// accounting direction. Monetary fields remain unsigned magnitudes.
export function buildCreditCardCreditPayload({
  requestId,
  amount,
  txnDate,
  sourceCreditCardAccountId,
  categoryAccountId,
  privateNote,
  lineDescription,
  vendorRef = null,
} = {}) {
  const magnitude = nonnegativeMagnitude(amount, "credit_card_refund_amount");
  if (!sourceCreditCardAccountId) throw new Error("missing_credit_card_source_account");
  if (!categoryAccountId) throw new Error("missing_credit_card_refund_category_account");
  return {
    requestId,
    PaymentType: "CreditCard",
    Credit: true,
    AccountRef: { value: String(sourceCreditCardAccountId) },
    TxnDate: txnDate,
    TotalAmt: magnitude,
    PrivateNote: privateNote,
    ...(vendorRef ? { EntityRef: { value: String(vendorRef.value), type: "Vendor" } } : {}),
    Line: [{
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: magnitude,
      Description: lineDescription,
      AccountBasedExpenseLineDetail: { AccountRef: { value: String(categoryAccountId) } },
    }],
  };
}

export function qboAmountFieldsAreNonnegative(payload = {}) {
  const amounts = [payload.TotalAmt, payload.Amount, ...(payload.Line || []).map((line) => line?.Amount)]
    .filter((value) => value != null)
    .map(Number);
  return amounts.length > 0 && amounts.every((value) => Number.isFinite(value) && value >= 0);
}
