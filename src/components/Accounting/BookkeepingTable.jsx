// File: /src/components/Accounting/BookkeepingTable.jsx
import React, { memo } from "react";
import { CheckCircle2, ChevronDown, Loader2, MessageCircle } from "lucide-react";

function Pill({ label, tone = "neutral" }) {
  const cls = {
    high: "bg-emerald-500/15 text-emerald-200 border-emerald-500/40",
    medium: "bg-amber-500/15 text-amber-200 border-amber-500/40",
    low: "bg-red-500/15 text-red-200 border-red-500/40",
    neutral: "bg-white/10 text-white/80 border-white/15",
  }[tone] || "bg-white/10 text-white/80 border-white/15";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium ${cls}`}>
      <MessageCircle size={12} /> {label}
    </span>
  );
}

function BookkeepingTable({
  loading,
  allSelected,
  toggleSelectAll,
  pageRows,
  selectedIds,
  toggleRow,
  fmtCurrency,
  chartOfAccounts,
  updateSelection,
  applySingle,
  bulkApplying,
  rowStatus,
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/5 bg-black/60 shadow-[0_16px_48px_rgba(0,0,0,0.35)]">
      <table className="min-w-full divide-y divide-white/10 text-sm">
        <thead className="bg-black/40 text-white/70">
          <tr>
            <th className="px-4 py-2.5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="h-4 w-4 rounded border-white/30 bg-black/40 text-emerald-400 focus:ring-emerald-400"
              />
            </th>
            {["Date", "Payee / Vendor", "Bank Description", "Amount", "Current QBO Account", "Bizzi Suggestion", "Reason", "Confidence", ""].map(
              (h) => (
                <th key={h} className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {loading && (
            <tr>
              <td colSpan={9} className="px-4 py-6 text-center text-white/60">
                <div className="inline-flex items-center gap-2">
                  <Loader2 className="animate-spin" size={16} />
                  Loading uncategorized transactions…
                </div>
              </td>
            </tr>
          )}
          {!loading &&
            pageRows.map((t) => (
              <tr key={t.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(t.id)}
                    onChange={() => toggleRow(t.id)}
                    className="h-4 w-4 rounded border-white/30 bg-black/40 text-emerald-400 focus:ring-emerald-400"
                  />
                </td>
                <td className="px-3 py-2 text-white/80 whitespace-nowrap text-sm">{t.date || "—"}</td>
                <td className="px-3 py-2 text-white text-sm">{t.payee || t.vendor || "—"}</td>
                <td className="px-3 py-2 text-white/70 text-sm">{t.description || t.bankDescription || "—"}</td>
                <td className="px-3 py-2 text-white text-right text-sm">{fmtCurrency(t.amount)}</td>
                <td className="px-3 py-2 text-white/80 text-sm">{t.currentAccountName || "Uncategorized"}</td>
                <td className="px-3 py-2">
                  <div className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-white/80">
                    <select
                      value={t.selection?.accountId || ""}
                      onChange={(e) => {
                        const accountId = e.target.value;
                        const accountName = chartOfAccounts.find((c) => c.id === accountId)?.name || t.selection?.accountName || t.currentAccountName;
                        updateSelection(t.id, accountId, accountName);
                      }}
                      className="bg-transparent focus:outline-none"
                    >
                      <option value="">Select account</option>
                      {chartOfAccounts.map((acct) => (
                        <option key={acct.id} value={acct.id} className="bg-slate-900">
                          {acct.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} className="text-white/50" />
                  </div>
                </td>
                <td className="px-3 py-2 text-white/70 max-w-xs text-sm leading-snug">
                  {t.suggestion?.reason || "Review and choose the right category."}
                </td>
                <td className="px-3 py-2">
                  <Pill
                    label={(t.suggestion?.confidence || "low").toUpperCase()}
                    tone={
                      t.suggestion?.confidence === "high"
                        ? "high"
                        : t.suggestion?.confidence === "medium"
                        ? "medium"
                        : "low"
                    }
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    className="inline-flex items-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50"
                    onClick={() => applySingle(t.id)}
                    disabled={bulkApplying}
                  >
                    {bulkApplying ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                    Accept
                  </button>
                  {rowStatus[t.id] && (
                    <div className={`mt-1 text-xs ${rowStatus[t.id] === "ok" ? "text-emerald-200" : "text-amber-200"}`}>
                      {rowStatus[t.id] === "ok" ? "Applied" : rowStatus[t.id]}
                    </div>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
} 

export default memo(BookkeepingTable);
