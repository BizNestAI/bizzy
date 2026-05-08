import React, { useMemo } from "react";
import CardHeader from "../UI/CardHeader.jsx";
import {
  shouldShowReconciliationLogHint,
} from "./reconciliationSafeError.js";

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function truncateText(text, max = 140) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function pushLine(lines, text) {
  if (text && lines.length < 4) lines.push(text);
}

function buildInsights({ latestRun, accounts = [], overallStatus, statusError, hasConnectedAccounts }) {
  if (!latestRun) {
    if (!hasConnectedAccounts) {
      return [
        "Connect Plaid and QuickBooks so Bizzi can compare bank activity to QuickBooks posting.",
      ];
    }
    return [
      "Run reconciliation to generate your first audit snapshot.",
    ];
  }

  const runStatus = latestRun?.status || latestRun?.overall_status || "unknown";
  const failedLike = runStatus === "failed" || overallStatus === "failed" || Boolean(latestRun?.details?.error);
  if (failedLike) {
    const lines = [
      "Reconciliation monitoring did not complete. Run it again before trusting this snapshot.",
    ];
    if (shouldShowReconciliationLogHint(statusError, runStatus, latestRun?.details)) {
      lines.push("Open backend logs for technical details.");
    }
    return lines.slice(0, 4);
  }

  const counts = latestRun.counts || {};
  const lines = [];
  const failedPosts = Number(counts.failed_post_count || 0);
  const missingInQbo = Number(counts.missing_in_qbo_count || 0);
  const duplicateInQbo = Number(counts.duplicate_in_qbo_count || 0);
  const needsReview = Number(counts.needs_review_count || 0);
  const waiting = Number(counts.approved_waiting_post_count || 0);
  const pending = Number(counts.pending_count || 0);
  const matched = Number(counts.matched_count || 0);
  const unresolved = failedPosts + missingInQbo + duplicateInQbo + needsReview + waiting;
  const operatorNote = accounts.find(
    (acct) => (acct?.status === "investigating" || acct?.status === "partial") && acct?.explanation_summary
  );

  if (unresolved > 0) {
    if (needsReview > 0) {
      pushLine(
        lines,
        `${pluralize(needsReview, "transaction")} ${needsReview === 1 ? "needs" : "need"} review before Bizzi can post ${needsReview === 1 ? "it" : "them"}.`
      );
    }
    if (missingInQbo > 0) {
      pushLine(
        lines,
        `${pluralize(missingInQbo, "approved transaction")} ${missingInQbo === 1 ? "has" : "have"} not reached QuickBooks yet.`
      );
    }
    if (failedPosts > 0) {
      pushLine(
        lines,
        `${pluralize(failedPosts, "posting attempt")} ${failedPosts === 1 ? "is" : "are"} still failing and will be retried automatically.`
      );
    }
    if (duplicateInQbo > 0) {
      pushLine(
        lines,
        `${pluralize(duplicateInQbo, "duplicate QuickBooks post")} ${duplicateInQbo === 1 ? "was" : "were"} detected in this snapshot.`
      );
    }
    if (waiting > 0) {
      pushLine(
        lines,
        `${pluralize(waiting, "approved transaction")} ${waiting === 1 ? "is" : "are"} waiting for the next scheduled post window.`
      );
    }
  } else {
    pushLine(lines, "No duplicate or missing QuickBooks posts detected in the latest run.");
    pushLine(lines, "Posting pipeline appears healthy.");
    if (matched > 0) {
      pushLine(lines, `${pluralize(matched, "eligible transaction")} ${matched === 1 ? "was" : "were"} posted and matched in this snapshot.`);
    }
  }

  if (lines.length < 4 && pending > 0) {
    pushLine(lines, `${pluralize(pending, "transaction")} ${pending === 1 ? "is" : "are"} still pending in Plaid and not ready to post yet.`);
  }

  if (lines.length < 4 && operatorNote) {
    const name = operatorNote?.plaid_account_name || "Bank account";
    pushLine(lines, `Account note: ${truncateText(`${name} — ${operatorNote.explanation_summary}`, 140)}`);
  }

  if (!lines.length && overallStatus === "unknown") {
    pushLine(lines, "Reconciliation monitoring is not ready yet.");
  }

  return lines.slice(0, 4);
}

export default function ReconciliationInsightsCard({
  latestRun,
  accounts = [],
  overallStatus,
  loading,
  statusError = null,
  hasConnectedAccounts = true,
}) {
  const insights = useMemo(
    () => buildInsights({ latestRun, accounts, overallStatus, statusError, hasConnectedAccounts }),
    [latestRun, accounts, overallStatus, statusError, hasConnectedAccounts]
  );

  return (
    <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-4 shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <CardHeader
          title="Bizzi insights"
          subtitle="Short operator summary for the selected reconciliation snapshot."
          size="sm"
          titleTone="bold"
        />
        {loading ? <div className="text-[11px] text-slate-400">Refreshing…</div> : null}
      </div>

      <div className="mt-4 grid gap-2">
        {insights.map((line, idx) => (
          <div
            key={`${idx}-${line}`}
            className="rounded-xl border border-white/8 bg-white/[0.035] px-3 py-2.5 text-sm text-slate-200"
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
