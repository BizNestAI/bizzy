import { createHash } from "node:crypto";

export const MONTHLY_PNL_CONTENT_FINGERPRINT_VERSION = "qbo-pnl-financial-content-v1";

export function buildMonthlyPnlContentFingerprint({ snapshot, accounts = [] } = {}) {
  if (!snapshot?.business_id || !snapshot?.qbo_realm_id || !snapshot?.source_start_date || !snapshot?.source_end_date) return null;
  const content = {
    identity: {
      business_id: String(snapshot.business_id),
      realm_id: String(snapshot.qbo_realm_id),
      report_type: "ProfitAndLoss",
      accounting_method: String(snapshot.accounting_method || "Cash"),
      source_start_date: dateOnly(snapshot.source_start_date),
      source_end_date: dateOnly(snapshot.source_end_date),
      currency_code: String(snapshot.currency_code || snapshot.metadata?.financial_content?.currency_code || "USD").toUpperCase(),
    },
    totals: {
      revenue: money(snapshot.revenue),
      cogs: money(snapshot.cogs),
      expenses: money(snapshot.expenses),
      net_profit: money(snapshot.net_profit),
    },
    accounts: canonicalRows(accounts.map((row) => ({
      qbo_account_id: text(row.qbo_account_id),
      account_path: text(row.account_path),
      account_name: text(row.account_name),
      account_type: text(row.account_type),
      account_subtype: text(row.account_subtype),
      amount: money(row.total_amount ?? row.amount ?? row.total),
    }))),
  };
  const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { version: MONTHLY_PNL_CONTENT_FINGERPRINT_VERSION, fingerprint: `${MONTHLY_PNL_CONTENT_FINGERPRINT_VERSION}:${digest}`, content };
}

function canonicalRows(rows) {
  return rows.map((row) => JSON.stringify(row)).sort().map((row) => JSON.parse(row));
}

function money(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function dateOnly(value) {
  return String(value ?? "").slice(0, 10) || null;
}
