import React from "react";
import CardHeader from "../UI/CardHeader.jsx";
import {
  getReconciliationDisplayClass,
  getReconciliationDisplayStatus,
} from "./reconciliationDisplayStatus.js";

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

function titleCase(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

export default function ReconciliationRunHistory({
  runs = [],
  selectedRunId,
  latestRunId,
  loading,
  onSelectRun,
}) {
  return (
    <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-4 shadow-lg">
      <CardHeader
        title="Run history"
        subtitle="Inspect prior reconciliation runs and switch the audit table to any historical snapshot."
        size="sm"
        titleTone="bold"
        className="mb-4"
      />

      <div className="overflow-hidden rounded-2xl border border-white/6 bg-black/10">
        <div className="overflow-x-auto">
          <table className="min-w-[1320px] w-full text-sm text-slate-100">
            <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.18em] text-slate-400">
              <tr className="border-b border-white/6">
                <th className="px-3 py-3 text-left">Run time</th>
                <th className="px-3 py-3 text-left">Scope</th>
                <th className="px-3 py-3 text-left">Status</th>
                <th className="px-3 py-3 text-right">Total seen</th>
                <th className="px-3 py-3 text-right">Matched</th>
                <th className="px-3 py-3 text-right">Needs review</th>
                <th className="px-3 py-3 text-right">Waiting</th>
                <th className="px-3 py-3 text-right">Pending</th>
                <th className="px-3 py-3 text-right">Failed post</th>
                <th className="px-3 py-3 text-right">Missing in QBO</th>
                <th className="px-3 py-3 text-right">Duplicate in QBO</th>
                <th className="px-3 py-3 text-left">Change cue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6">
              {loading ? (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-slate-300">
                    Loading run history…
                  </td>
                </tr>
              ) : !runs.length ? (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-slate-300">
                    No runs yet.
                  </td>
                </tr>
              ) : (
                runs.map((run, idx) => {
                  const runId = run?.run_id || run?.id || null;
                  const isSelected = runId === selectedRunId;
                  const isLatest = runId === latestRunId;
                  const previousRun = runs[idx + 1] || null;
                  const statusDisplay = getReconciliationDisplayStatus(run.overall_status, {
                    hasRows: Number(run?.counts?.total_seen || 0) > 0,
                    hasData: Boolean(run?.counts?.total_seen || run?.last_checked_at),
                  });
                  return (
                    <tr
                      key={runId || `run-${idx}`}
                      onClick={() => onSelectRun?.(run)}
                      className={`cursor-pointer transition hover:bg-white/[0.03] ${
                        isSelected ? "bg-emerald-500/[0.08]" : ""
                      }`}
                    >
                      <td className="px-3 py-3">
                        <div className="font-medium text-slate-100">{formatDateTime(run.last_checked_at)}</div>
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
                      <td className="px-3 py-3 text-slate-300">{titleCase(run.scope || "custom")}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex max-w-[140px] items-center rounded-full border px-2 py-[3px] text-[10px] font-semibold leading-tight ${getReconciliationDisplayClass(statusDisplay.tone)}`}>
                          {statusDisplay.label}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-slate-200">{run.counts?.total_seen ?? 0}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{run.counts?.matched_count ?? 0}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{run.counts?.needs_review_count ?? 0}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{run.counts?.approved_waiting_post_count ?? 0}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{run.counts?.pending_count ?? 0}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{run.counts?.failed_post_count ?? 0}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{run.counts?.missing_in_qbo_count ?? 0}</td>
                      <td className="px-3 py-3 text-right text-slate-200">{run.counts?.duplicate_in_qbo_count ?? 0}</td>
                      <td className="px-3 py-3 text-[12px] text-slate-400">{compareCue(run, previousRun)}</td>
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
