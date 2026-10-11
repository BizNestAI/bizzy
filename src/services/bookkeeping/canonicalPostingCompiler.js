import { getAccountingDateFromBankTransaction } from "./accountingDatePolicy.js";
import { isCreditCardPaymentWorkflow, normalizeQboAccountType } from "./creditCardPaymentStatus.js";
import { resolveProtectedCreditCardInflowDecision } from "./incomingDepositResolution.js";
import crypto from "crypto";

function postingError(code, message, status = 409) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  return error;
}

export function compileCanonicalDepositPosting({
  bankTransaction,
  destinationAccount,
  approvedLineAccount,
  requestId = null,
  privateNote = null,
  lineDescription = null,
  customerRef = null,
  customerEntityVariant = "A",
} = {}) {
  const finalAccountId = String(approvedLineAccount?.id || "").trim();
  const destinationAccountId = String(destinationAccount?.id || "").trim();
  if (!finalAccountId) throw postingError("missing_final_qbo_account", "Choose and save a QuickBooks GL account before posting.");
  if (approvedLineAccount?.active === false) throw postingError("final_qbo_account_inactive", "The approved QuickBooks GL account is inactive.");
  if (!destinationAccountId) throw postingError("missing_qbo_account_mapping", "The connected bank account is not mapped to QuickBooks.");
  const amount = Math.abs(Number(bankTransaction?.amount || 0));
  if (!Number.isFinite(amount) || amount === 0) throw postingError("invalid_amount", "The bank transaction amount is invalid.");
  const date = getAccountingDateFromBankTransaction(bankTransaction || {});
  const payload = {
    ...(requestId ? { requestId } : {}),
    TxnDate: date,
    ...(privateNote ? { PrivateNote: privateNote } : {}),
    DepositToAccountRef: { value: destinationAccountId },
    Line: [{
      DetailType: "DepositLineDetail",
      Amount: amount,
      ...(lineDescription ? { Description: lineDescription } : {}),
      DepositLineDetail: {
        AccountRef: { value: finalAccountId },
        ...(customerRef
          ? customerEntityVariant === "A"
            ? { Entity: { value: customerRef.value, type: "Customer" } }
            : { Entity: { Type: "Customer", EntityRef: { value: customerRef.value } } }
          : {}),
      },
    }],
  };
  if (String(payload.Line[0].DepositLineDetail.AccountRef.value) !== finalAccountId) {
    throw postingError("compiled_account_authority_mismatch", "The compiled QuickBooks line account does not match the approved account.");
  }
  return {
    entity_type: "Deposit",
    approved_final_account_id: finalAccountId,
    destination_account: { id: destinationAccountId, name: destinationAccount?.name || null },
    line_account: { id: finalAccountId, name: approvedLineAccount?.name || null },
    amount,
    date,
    payload,
  };
}

export function resolveCanonicalPostingRail({ bankTransaction = {}, categorization = {}, mapping = {} } = {}) {
  const mappingType = normalizeQboAccountType(mapping.qbo_account_type);
  const direction = String(bankTransaction.direction || "").toUpperCase();
  const amount = Number(bankTransaction.amount || 0);
  const outflow = direction === "OUTFLOW" || (direction !== "INFLOW" && amount < 0);
  const inflow = direction === "INFLOW" || (direction !== "OUTFLOW" && amount > 0);
  const creditResolution = resolveProtectedCreditCardInflowDecision(categorization).resolution_type;
  if (!Number.isFinite(amount) || amount === 0 || (!outflow && !inflow)) {
    throw postingError("invalid_amount", "The bank transaction amount is invalid.");
  }
  if (isCreditCardPaymentWorkflow(categorization) || creditResolution === "match_credit_card_payment") {
    throw postingError("credit_card_payment_requires_match", "Credit card payments must be confirmed through the protected matching workflow.");
  }
  if (mappingType === "bank") return outflow ? "Purchase" : "Deposit";
  if (mappingType !== "creditcard") {
    throw postingError("invalid_qbo_account_mapping_type", "The connected account is not mapped to a compatible QuickBooks bank or credit card account.");
  }
  if (outflow) return "CreditCardCharge";
  if (["merchant_refund", "credit_card_statement_credit"].includes(creditResolution)) return "CreditCardCredit";
  throw postingError("credit_card_inflow_requires_review", "Confirm whether this credit is a merchant refund, card payment, statement credit, or other activity before posting.");
}

export async function buildCanonicalPostingPreview({ db, businessId, transactionId } = {}) {
  if (!db || !businessId || !transactionId) throw postingError("missing_posting_scope", "Posting preview context is incomplete.", 400);
  const [{ data: item, error: itemError }, { data: bankTransaction, error: bankError }] = await Promise.all([
    db.from("transaction_categorizations")
      .select("transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,qbo_txn_id,posted_at,updated_at,taxonomy_type,cc_payment_pair_id,meta")
      .eq("business_id", businessId).eq("transaction_id", transactionId).maybeSingle(),
    db.from("bank_transactions")
      .select("id,business_id,date,amount,direction,name,merchant_name,plaid_account_id,pending,is_archived")
      .eq("business_id", businessId).eq("id", transactionId).maybeSingle(),
  ]);
  if (itemError) throw itemError;
  if (bankError) throw bankError;
  if (!item || !bankTransaction) throw postingError("transaction_not_found", "The transaction could not be loaded.", 404);
  if (item.qbo_txn_id || item.posted_at || String(item.status || "").toLowerCase() === "posted") throw postingError("transaction_already_posted", "This transaction is already posted.");
  if (bankTransaction.pending === true) throw postingError("pending_transaction_not_postable", "Pending bank activity cannot be posted.");
  if (!item.final_qbo_account_id) throw postingError("missing_final_qbo_account", "Choose and save a QuickBooks GL account before posting.");

  const [{ data: approvedAccount, error: accountError }, { data: mapping, error: mappingError }] = await Promise.all([
    db.from("qbo_accounts_cache").select("qbo_account_id,name,account_type,active")
      .eq("business_id", businessId).eq("qbo_account_id", String(item.final_qbo_account_id)).maybeSingle(),
    db.from("plaid_qbo_account_mappings").select("qbo_account_id,qbo_account_name,qbo_account_type")
      .eq("business_id", businessId).eq("plaid_account_id", bankTransaction.plaid_account_id)
      .order("updated_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
  ]);
  if (accountError) throw accountError;
  if (mappingError) throw mappingError;
  if (!approvedAccount?.qbo_account_id) throw postingError("final_qbo_account_not_found", "The approved QuickBooks GL account is unavailable for this business.");
  if (approvedAccount.active === false) throw postingError("final_qbo_account_inactive", "The approved QuickBooks GL account is inactive.");
  if (String(approvedAccount.qbo_account_id) !== String(item.final_qbo_account_id)) throw postingError("final_qbo_account_inconsistent", "The approved QuickBooks account is inconsistent.");
  if (!mapping?.qbo_account_id) throw postingError("missing_qbo_account_mapping", "The connected account is not mapped to QuickBooks.");
  const entityType = resolveCanonicalPostingRail({ bankTransaction, categorization: item, mapping });
  const sourceAccount = { id: String(mapping.qbo_account_id), name: mapping.qbo_account_name || null };
  const lineAccount = { id: String(approvedAccount.qbo_account_id), name: approvedAccount.name || null };
  const compiled = entityType === "Deposit"
    ? compileCanonicalDepositPosting({ bankTransaction, destinationAccount: sourceAccount, approvedLineAccount: { ...lineAccount, active: approvedAccount.active } })
    : {
        entity_type: entityType,
        approved_final_account_id: lineAccount.id,
        destination_account: sourceAccount,
        line_account: lineAccount,
        amount: Math.abs(Number(bankTransaction.amount)),
        date: getAccountingDateFromBankTransaction(bankTransaction),
      };
  const preview = {
    transaction_id: transactionId,
    row_version: item.updated_at || null,
    entity_type: compiled.entity_type,
    source_qbo_account: compiled.destination_account,
    destination_bank_account: compiled.entity_type === "Deposit" ? compiled.destination_account : null,
    line_gl_account: compiled.line_account,
    approved_final_account_id: compiled.approved_final_account_id,
    amount: compiled.amount,
    date: compiled.date,
  };
  preview.preview_token = crypto.createHash("sha256").update(JSON.stringify({
    transaction_id: preview.transaction_id,
    row_version: preview.row_version,
    entity_type: preview.entity_type,
    source_account_id: preview.source_qbo_account.id,
    final_account_id: preview.approved_final_account_id,
    amount: preview.amount,
    date: preview.date,
  })).digest("hex");
  return preview;
}
