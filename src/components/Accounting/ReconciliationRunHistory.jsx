import React from "react";
import CardHeader from "../UI/CardHeader.jsx";

const PANEL_BG = "#151717";
const PANEL_BORDER = "rgba(255,255,255,0.06)";

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMonth(value) {
  if (!value) return "Unscoped month";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unscoped month";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function resolveRunMonthDate(run) {
  return run?.period_start || run?.period_end || run?.last_checked_at || null;
}

function monthKey(run) {
  const value = resolveRunMonthDate(run);
  if (!value) return "unscoped";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "unscoped";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function deltaLabel(current = 0, previous = 0, noun = "items") {
  const delta = Number(current || 0) - Number(previous || 0);
  if (delta === 0) return `No change in ${noun}`;
  if (delta > 0) return `+${delta} ${noun}`;
  return `${Math.abs(delta)} fewer ${noun}`;
}

function compareCue(run, previousRun) {
  if (!previousRun) return "Latest baseline run";
  const currentCounts = run?.counts || {};
  const prevCounts = previousRun?.counts || {};

  const ranked = [
    {
      weight: Math.abs((currentCounts.failed_post_count || 0) - (prevCounts.failed_post_count || 0)),
      text: `${deltaLabel(currentCounts.failed_post_count, prevCounts.failed_post_count, "failed posts")} since last run`,
    },
    {
      weight: Math.abs((currentCounts.matched_count || 0) - (prevCounts.matched_count || 0)),
      text: `${deltaLabel(currentCounts.matched_count, prevCounts.matched_count, "matched")} since last run`,
    },
    {
      weight: Math.abs((currentCounts.needs_review_count || 0) - (prevCounts.needs_review_count || 0)),
      text: `${deltaLabel(currentCounts.needs_review_count, prevCounts.needs_review_count, "needs review")} since last run`,
    },
    {
      weight: Math.abs((currentCounts.missing_in_qbo_count || 0) - (prevCounts.missing_in_qbo_count || 0)),
      text: `${deltaLabel(currentCounts.missing_in_qbo_count, prevCounts.missing_in_qbo_count, "missing in QBO")} since last run`,
    },
  ].sort((a, b) => b.weight - a.weight);

  if (!ranked[0] || ranked[0].weight === 0) return "No material changes";
  return ranked[0].text;
}

function monthlyNotes(run, previousRun) {
  const counts = run?.counts || {};
  const failed = Number(counts.failed_post_count || 0);
  const needsReview = Number(counts.needs_review_count || 0);
  const pending = Number(counts.pending_count || 0);
  const seen = Number(counts.total_seen || 0);

  if (run?.overall_status === "failed" || run?.status === "failed") {
    return "Monthly ledger refresh did not complete. Bizzi will retry automatically.";
  }
  if (failed > 0) {
    return `${failed} transaction${failed === 1 ? "" : "s"} failed while posting to QuickBooks.`;
  }
  if (needsReview > 0) {
    return `${needsReview} transaction${needsReview === 1 ? "" : "s"} still need categorization.`;
  }
  if (pending > 0) {
    return `${pending} pending bank item${pending === 1 ? "" : "s"} still need to settle.`;
  }
  if (seen > 0) {
    return `${seen} Plaid transaction${seen === 1 ? "" : "s"} captured for this month.`;
  }
  return compareCue(run, previousRun);
}

function toCount(value) {
  return Number(value || 0);
}

function lifecycleMetrics(run) {
  const counts = run?.counts || {};
  const plaidTotal = toCount(counts.total_seen);
  const needsReview = toCount(counts.needs_review_count);
  const duplicateInQbo = toCount(counts.duplicate_in_qbo_count);
  const fullyReconciled = toCount(counts.matched_count);

  return {
    plaidTotal,
    categorized: Math.max(0, plaidTotal - needsReview),
    posted: fullyReconciled + duplicateInQbo,
    fullyReconciled,
    failedPosting: toCount(counts.failed_post_count),
  };
}

export default function ReconciliationRunHistory({
  runs = [],
  selectedRunId,
  latestRunId,
  loading,
  onSelectRun,
}) {
  const monthlyRuns = [];
  const seenMonths = new Set();
  (runs || []).forEach((run) => {
    const key = monthKey(run);
    if (seenMonths.has(key)) return;
    seenMonths.add(key);
    monthlyRuns.push(run);
  });

  return (
    <div className="rounded-2xl border p-4 shadow-lg" style={{ background: PANEL_BG, borderColor: PANEL_BORDER }}>
      <CardHeader
        title="Monthly Audit Logs"
        subtitle="Select a month to open its Plaid source ledger and transaction lifecycle audit."
        size="sm"
        titleTone="bold"
        className="mb-4"
      />

      <div className="overflow-hidden rounded-2xl border border-white/6 bg-[#111313]">
        <div className="overflow-x-auto">
          <table className="min-w-[980px] w-full text-sm text-slate-100">
            <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.18em] text-slate-400">
              <tr className="border-b border-white/6">
                <th className="px-3 py-3 text-left">Month</th>
                <th className="px-3 py-3 text-left">Notes</th>
                <th className="px-3 py-3 text-right">Plaid total</th>
                <th className="px-3 py-3 text-right">Categorized</th>
                <th className="px-3 py-3 text-right">Posted</th>
                <th className="px-3 py-3 text-right">Fully reconciled</th>
                <th className="px-3 py-3 text-right">Failed posting</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-300">
                    Loading run history…
                  </td>
                </tr>
              ) : !monthlyRuns.length ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-300">
                    No monthly reconciliation ledger yet.
                  </td>
                </tr>
              ) : (
                monthlyRuns.map((run, idx) => {
                  const runId = run?.run_id || run?.id || null;
                  const isSelected = runId === selectedRunId;
                  const isLatest = runId === latestRunId;
                  const previousRun = monthlyRuns[idx + 1] || null;
                  const metrics = lifecycleMetrics(run);
                  return (
                    <tr
                      key={runId || `run-${idx}`}
                      onClick={() => onSelectRun?.(run)}
                      className={`cursor-pointer transition hover:bg-white/[0.03] ${
                        isSelected ? "bg-emerald-500/[0.08]" : ""
                      }`}
                    >
                      <td className="px-3 py-3">
                        <div className="font-semibold text-slate-100">{formatMonth(resolveRunMonthDate(run))}</div>
                        <div className="mt-1 text-[11px] text-slate-500">Run {formatDateTime(run.last_checked_at)}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {isLatest ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-[2px] text-[10px] font-semibold leading-none text-emerald-100">
                              Latest
                            </span>
                          ) : null}
                          {isSelected ? (
                            <span className="inline-flex items-center rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-[2px] text-[10px] font-semibold leading-none text-cyan-100">
                              Active in audit
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-[12px] leading-5 text-slate-400">{monthlyNotes(run, previousRun)}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{metrics.plaidTotal}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{metrics.categorized}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{metrics.posted}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{metrics.fullyReconciled}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{metrics.failedPosting}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
