// /src/services/tax/taxableIncome/taxableIncomeSourceUtils.js
import {
  DEDUCTIBILITY_STATUSES,
  TAX_CLASSIFICATION_STATUSES,
  normalizeDateOnly,
  normalizeTaxYear,
} from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { round2 } from "./taxableIncomeDomain.js";

export const PAGE_SIZE = 1000;

export const INCLUDED_CLASSIFICATION_STATUSES = new Set([
  TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED,
  TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
]);

export const CONFIRMED_CLASSIFICATION_STATUSES = new Set([
  TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED,
]);

export function buildTaxableIncomeContext({ supabase, businessId, taxYear, year, asOfDate }) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const date = asOfDate == null || asOfDate === "" ? `${normalizedYear}-12-31` : normalizeDateOnly(asOfDate);
  if (!date) throw validationError("invalid_as_of_date", "asOfDate must be YYYY-MM-DD.", { field: "asOfDate" });
  return { supabase, businessId, taxYear: normalizedYear, asOfDate: date };
}

export async function loadAnnualClassificationItems({ supabase, businessId, taxYear, asOfDate, includeExcluded = false }) {
  const rows = await fetchAllClassifications({ supabase, businessId, taxYear });
  const transactionIds = [...new Set(rows.map((row) => row.transaction_id).filter(Boolean))];
  const bankMap = await fetchBankTransactions({ supabase, businessId, transactionIds });
  const items = [];
  const excludedItems = [];
  let futureExcludedCount = 0;

  for (const classification of rows) {
    const status = classification.classification_status || TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW;
    if (status === TAX_CLASSIFICATION_STATUSES.EXCLUDED && !includeExcluded) continue;
    if (status !== TAX_CLASSIFICATION_STATUSES.EXCLUDED && !INCLUDED_CLASSIFICATION_STATUSES.has(status)) {
      if (includeExcluded) excludedItems.push(excludedItem({ classification, reason: "unsupported_classification_status" }));
      continue;
    }

    const bankTransaction = bankMap.get(String(classification.transaction_id));
    if (!bankTransaction || bankTransaction.business_id !== businessId) {
      if (includeExcluded) excludedItems.push(excludedItem({ classification, reason: "missing_bank_transaction" }));
      continue;
    }
    if (bankTransaction.pending === true) {
      if (includeExcluded) excludedItems.push(excludedItem({ classification, bankTransaction, reason: "pending_transaction" }));
      continue;
    }
    if (bankTransaction.is_archived === true) {
      if (includeExcluded) excludedItems.push(excludedItem({ classification, bankTransaction, reason: "archived_transaction" }));
      continue;
    }
    const transactionDate = normalizeDateOnly(classification.transaction_date) || normalizeDateOnly(bankTransaction.date);
    if (!transactionDate || !transactionDate.startsWith(`${taxYear}-`)) {
      if (includeExcluded) excludedItems.push(excludedItem({ classification, bankTransaction, reason: "outside_tax_year" }));
      continue;
    }
    if (transactionDate > asOfDate) {
      futureExcludedCount += 1;
      if (includeExcluded) excludedItems.push(excludedItem({ classification, bankTransaction, transactionDate, reason: "future_transaction" }));
      continue;
    }

    items.push({ classification, bankTransaction, transactionDate, month: transactionDate.slice(0, 7) });
  }

  return { items, excludedItems, futureExcludedCount };
}

function excludedItem({ classification, bankTransaction = null, transactionDate = null, reason }) {
  const date = transactionDate || normalizeDateOnly(classification?.transaction_date) || normalizeDateOnly(bankTransaction?.date) || null;
  return {
    classification,
    bankTransaction,
    transactionDate: date,
    month: date ? date.slice(0, 7) : null,
    exclusionReason: reason,
  };
}

export async function fetchAllClassifications({ supabase, businessId, taxYear }) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = supabase
      .from("transaction_tax_classifications")
      .select("*")
      .eq("business_id", businessId)
      .eq("tax_year", taxYear)
      .order("transaction_date", { ascending: true })
      .order("transaction_id", { ascending: true });
    if (typeof query.range === "function") query = query.range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE || typeof query.range !== "function") break;
  }
  return rows;
}

export async function fetchBankTransactions({ supabase, businessId, transactionIds }) {
  const map = new Map();
  for (let i = 0; i < transactionIds.length; i += 500) {
    const chunk = transactionIds.slice(i, i + 500);
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("bank_transactions")
      .select("id,business_id,date,pending,is_archived,signed_amount,direction,merchant_name,counterparty_name,name,plaid_transaction_id")
      .eq("business_id", businessId)
      .in("id", chunk);
    if (error) throw error;
    for (const row of data || []) map.set(String(row.id), row);
  }
  return map;
}

export function buildMonthList(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

export function isConfirmedClassification(row) {
  return CONFIRMED_CLASSIFICATION_STATUSES.has(row?.classification_status);
}

export function isAutoClassification(row) {
  return row?.classification_status === TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED;
}

export function isNeedsReviewClassification(row) {
  return row?.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW || row?.requires_review === true;
}

export function isExpenseOutflow(item) {
  const signed = Number(item.classification.book_amount ?? item.bankTransaction.signed_amount);
  if (Number.isFinite(signed) && signed < 0) return true;
  return String(item.bankTransaction.direction || item.classification.metadata?.direction || "").toUpperCase() === "OUTFLOW";
}

export function isIncomeInflow(item) {
  const signed = Number(item.classification.book_amount ?? item.bankTransaction.signed_amount);
  if (Number.isFinite(signed) && signed > 0) return true;
  return String(item.bankTransaction.direction || item.classification.metadata?.direction || "").toUpperCase() === "INFLOW";
}

export function absoluteBookAmount(item) {
  return Math.abs(Number(item.classification.book_amount ?? item.bankTransaction.signed_amount ?? 0));
}

export function isBalanceSheetLike(row) {
  return row?.deductibility_status === DEDUCTIBILITY_STATUSES.BALANCE_SHEET ||
    ["transfer", "credit_card_payment", "owner_contribution", "owner_distribution", "loan_principal"].includes(row?.tax_category);
}

export function emptyMonthly(year, shape) {
  return Object.fromEntries(buildMonthList(year).map((month) => [month, { ...shape }]));
}

export function addMonthly(monthly, month, fields) {
  if (!monthly[month]) monthly[month] = {};
  for (const [key, value] of Object.entries(fields)) {
    monthly[month][key] = round2(Number(monthly[month][key] || 0) + Number(value || 0));
  }
}

export function percent(numerator, denominator) {
  return denominator ? round2((Number(numerator || 0) / Number(denominator || 0)) * 100) : 0;
}
