// Shared helper for aggregating and persisting monthly expense totals.
import { supabase } from "./supabaseAdmin.js";

const isExpense = (type) => String(type || "").toLowerCase() === "expense";
const normalizeCategory = (name) => (name || "Other").trim() || "Other";

function normalizeMonth(monthText) {
  if (!monthText) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(monthText)) return monthText;
  if (/^\d{4}-\d{2}$/.test(monthText)) return `${monthText}-01`;
  return monthText;
}

export function aggregateExpenseTotals(expenseLines = []) {
  const map = new Map();
  for (const line of expenseLines) {
    const type = line?.account_type;
    if (type && !isExpense(type)) continue;
    const amount = Number(line?.balance ?? line?.amount ?? 0);
    if (!(amount > 0)) continue;
    const category = normalizeCategory(line?.account_name || line?.category);
    map.set(category, (map.get(category) || 0) + amount);
  }

  return Array.from(map.entries()).map(([category, amount]) => ({
    category,
    amount,
  }));
}

export async function upsertExpenseTotalsMonthly({
  business_id,
  monthText,
  expenseLines = [],
  source = "qbo",
}) {
  const month = normalizeMonth(monthText);
  if (!business_id || !month) {
    return { rows: [], sum: 0 };
  }

  const aggregated = aggregateExpenseTotals(expenseLines);
  if (!aggregated.length) {
    return { rows: [], sum: 0 };
  }

  const rows = aggregated.map(({ category, amount }) => ({
    business_id,
    month,
    category,
    amount,
    source,
    updated_at: new Date().toISOString(),
  }));

  const sum = aggregated.reduce((acc, cur) => acc + Number(cur.amount || 0), 0);
  const { error } = await supabase
    .from("expense_totals_monthly")
    .upsert(rows, { onConflict: "business_id,month,category" });

  if (error) {
    const err = new Error(error.message || "expense_totals_monthly upsert failed");
    err.meta = { business_id, month, count: rows.length, sum };
    throw err;
  }

  if (process.env.NODE_ENV !== "production") {
    console.log("[expense_totals_monthly] upsert", {
      business_id,
      month,
      categories: rows.length,
      sum,
      source,
    });
  }

  return { rows, sum };
}

export async function fetchExpenseTotalsMonthly({ business_id, monthText }) {
  const month = normalizeMonth(monthText);
  if (!business_id || !month) {
    return { rows: [], month };
  }

  const { data, error } = await supabase
    .from("expense_totals_monthly")
    .select("category,amount,month,source,updated_at")
    .eq("business_id", business_id)
    .eq("month", month);

  if (error) {
    const err = new Error(error.message || "expense_totals_monthly fetch failed");
    err.meta = { business_id, month };
    throw err;
  }

  return { rows: data || [], month };
}
