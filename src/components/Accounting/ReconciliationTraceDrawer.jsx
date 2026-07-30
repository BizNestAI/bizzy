import React, { useEffect } from "react";
import { getReconciliationIssueCopy, titleCase } from "./reconciliationIssueCopy.js";

function formatMoney(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

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

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function StepBadge({ tone = "slate", label }) {
  const tones = {
    green: "border-emerald-400/35 bg-emerald-500/12 text-emerald-100",
    amber: "border-amber-300/35 bg-amber-400/12 text-amber-100",
    red: "border-rose-400/35 bg-rose-500/12 text-rose-100",
    slate: "border-white/12 bg-white/8 text-slate-200",
  };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tones[tone]}`}>{label}</span>;
}

function TraceStep({ title, tone, summary, children }) {
  return (
    <div className="relative pl-8">
      <div className={`absolute left-0 top-1.5 h-3 w-3 rounded-full ${
        tone === "green"
          ? "bg-emerald-300 shadow-[0_0_16px_rgba(52,211,153,0.45)]"
          : tone === "amber"
          ? "bg-amber-300 shadow-[0_0_16px_rgba(251,191,36,0.4)]"
          : tone === "red"
          ? "bg-rose-300 shadow-[0_0_16px_rgba(251,113,133,0.38)]"
          : "bg-slate-400"
      }`} />
      <div className="absolute left-[5px] top-6 bottom-[-22px] w-px bg-white/10 last:hidden" />
      <div className="rounded-2xl border border-white/8 bg-white/[0.035] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          <StepBadge tone={tone} label={summary} />
        </div>
        {children ? <div className="mt-3 text-sm leading-6 text-slate-300">{children}</div> : null}
      </div>
    </div>
  );
}

function KV({ label, value }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/10 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-1 break-words text-sm text-slate-100">{value || "—"}</div>
    </div>
  );
}

function hasPostingDiagnostics(details = {}) {
  return Boolean(
    details?.post_after ||
      details?.last_post_attempt_at ||
      details?.next_post_attempt_at ||
      details?.posting_in_progress === true ||
      details?.post_error ||
      details?.retry_count != null ||
      details?.post_block_reason
  );
}

function hasPostAttemptSummary(details = {}) {
  return Boolean(
    details?.latest_post_attempt_status ||
      details?.latest_post_attempt_at ||
      details?.latest_post_attempt_error ||
      details?.post_attempt_count != null
  );
}

function pipelineStatusDisplayLabel(row) {
  if (row?.status === "duplicate_internal") {
    return "Internal duplicate suppressed";
  }
  if (
    row?.status === "missing_in_qbo" &&
    (row?.details?.reason_code === "missing_post_schedule" || row?.details?.posting_state === "missing_post_schedule")
  ) {
    return "Approved, not scheduled";
  }
  return titleCase(row?.status || "unknown");
}

function canonicalStepTone(details = {}) {
  if (details?.canonical_state === "archived") return "red";
  if (details?.canonical_state === "merged_from_pending") return "green";
  if (details?.duplicate_source === "plaid_replay") return "amber";
  if (details?.canonical_state === "canonical") return "green";
  if (details?.merged_from_pending || details?.appears_canonical) return "green";
  return "slate";
}

function canonicalStepSummary(details = {}) {
  if (details?.canonical_state === "archived") return "Archived";
  if (details?.canonical_state === "merged_from_pending") return "Merged from pending";
  if (details?.duplicate_source === "plaid_replay") return "Duplicate replay suppressed";
  return titleCase(details?.canonical_state || "canonical");
}

function buildTrace(row, accountLabel) {
  const details = row?.details || {};
  const categoryLabel = row?.category_name || details?.final_qbo_account_name || details?.suggested_qbo_account_name || "—";
  const retryCount = details?.retry_count ?? "—";
  const plaidTransactionId = details?.plaid_transaction_id || row?.plaid_transaction_id || "—";
  const plaidAccountId = details?.plaid_account_id || row?.plaid_account_id || "—";
  const rawDate = details?.raw_date || row?.txn_date || null;
  const qboTxnId = details?.qbo_txn_id || row?.qbo_txn_id || null;
  const qboTxnType = details?.qbo_txn_type || row?.qbo_txn_type || null;
  const hasLinkedQboRecord =
    typeof details?.has_linked_qbo_record === "boolean"
      ? details.has_linked_qbo_record
      : Boolean(qboTxnId);
  const sourceOfTruth = details?.source_of_truth || "unknown";
  const sourceOfTruthNote =
    sourceOfTruth === "qbo"
      ? "QBO-linked record present. This is a high-confidence posting trace."
      : sourceOfTruth === "bizzi_proxy"
      ? "Bizzi proxy signal only. This is not an authoritative QBO match yet."
      : "No authoritative posting source has been linked yet.";

  return [
    {
      key: "ingested",
      title: "Ingested from Plaid",
      tone: plaidTransactionId !== "—" ? "green" : "slate",
      summary: plaidTransactionId !== "—" ? "Captured" : "Unavailable",
      body: (
        <div className="grid gap-2 md:grid-cols-2">
          <KV label="Bizzi transaction id" value={row?.bank_transaction_id || "—"} />
          <KV label="Plaid transaction id" value={plaidTransactionId} />
          <KV label="Pending transaction id" value={details?.pending_transaction_id || "—"} />
          <KV label="Plaid account id" value={plaidAccountId} />
          <KV label="Merchant / payee" value={details?.bank_name || row?.merchant || "—"} />
          <KV label="Transaction name" value={row?.description || "—"} />
          <KV label="Raw date" value={formatDate(rawDate)} />
          <KV label="Authorized date" value={formatDate(details?.authorized_date)} />
          <KV label="Amount" value={formatMoney(row?.amount)} />
        </div>
      ),
    },
    {
      key: "canonical",
      title: "Canonical transaction selected",
      tone: canonicalStepTone(details),
      summary: canonicalStepSummary(details),
      body: (
        <div className="grid gap-2 md:grid-cols-2">
          <KV label="Canonical state" value={titleCase(details?.canonical_state || "unknown")} />
          <KV label="Duplicate source" value={titleCase(details?.duplicate_source || "—")} />
          <KV label="Reason code" value={titleCase(details?.reason_code || "—")} />
          <KV label="Duplicate fingerprint" value={details?.duplicate_fingerprint || "—"} />
          <KV label="Archived" value={details?.is_archived ? "Yes" : "No"} />
          <KV label="Archived reason" value={details?.archived_reason || "—"} />
        </div>
      ),
    },
    {
      key: "categorized",
      title: "Categorized by Bizzi",
      tone: details?.categorization_status ? "green" : "amber",
      summary: details?.categorization_status ? titleCase(details.categorization_status) : "Uncategorized",
      body: (
        <div className="grid gap-2 md:grid-cols-2">
          <KV label="Categorization status" value={titleCase(details?.categorization_status || "uncategorized")} />
          <KV label="Suggested account" value={details?.suggested_qbo_account_name || details?.suggested_qbo_account_id || "—"} />
          <KV label="Final account" value={details?.final_qbo_account_name || details?.final_qbo_account_id || categoryLabel} />
          <KV label="Suggestion source" value={details?.suggestion_source || "—"} />
          <KV label="Taxonomy type" value={details?.taxonomy_type || "—"} />
        </div>
      ),
    },
    {
      key: "approval",
      title: "Approved / blocked / retried",
      tone:
        details?.post_error || details?.post_block_reason
          ? "red"
          : ["approved_not_posted", "queued_for_posting", "retry_scheduled", "posting_in_progress"].includes(details?.posting_state)
          ? "amber"
          : "slate",
      summary: titleCase(details?.posting_state || details?.lifecycle_stage || "unknown"),
      body: (
        <div className="grid gap-2 md:grid-cols-2">
          <KV label="Posting state" value={titleCase(details?.posting_state || "unknown")} />
          <KV label="Pipeline bucket" value={titleCase(details?.pipeline_bucket || "—")} />
          <KV label="Post after" value={formatDateTime(details?.post_after)} />
          <KV label="Retry count" value={String(retryCount)} />
          <KV label="Post block reason" value={details?.post_block_reason || "—"} />
          <KV label="Post error" value={details?.post_error || "—"} />
        </div>
      ),
    },
    {
      key: "posted",
      title: "Posted to QuickBooks",
      tone: hasLinkedQboRecord ? "green" : details?.post_error ? "red" : "slate",
      summary: hasLinkedQboRecord ? "Posted" : "Not posted",
      body: (
        <div className="grid gap-2 md:grid-cols-2">
          <KV label="QBO transaction id" value={qboTxnId || "—"} />
          <KV label="QBO transaction type" value={qboTxnType || "—"} />
          <KV label="Posted at" value={formatDateTime(details?.posted_at || row?.posted_at)} />
          <KV label="Source of truth" value={titleCase(sourceOfTruth)} />
          <KV label="Reconciliation confidence" value={titleCase(details?.reconciliation_confidence || "—")} />
          <KV label="Account" value={categoryLabel} />
          <KV label="QBO evidence note" value={sourceOfTruthNote} />
        </div>
      ),
    },
    {
      key: "reconciled",
      title: "Reconciled / not reconciled",
      tone:
        row?.status === "archived"
          ? "slate"
          : details?.lifecycle_stage === "posted_and_reconciled" || row?.status === "matched" || details?.reconciled_at
          ? "green"
          : row?.status === "missing_in_qbo"
          ? "red"
          : "slate",
      summary:
        row?.status === "archived"
          ? "Archived"
          : details?.lifecycle_stage === "posted_and_reconciled" || row?.status === "matched" || details?.reconciled_at
          ? "Reconciled"
          : "Open",
      body: (
        <div className="grid gap-2 md:grid-cols-2">
          <KV label="Pipeline status" value={pipelineStatusDisplayLabel(row)} />
          <KV label="Lifecycle stage" value={titleCase(details?.lifecycle_stage || "unknown")} />
          <KV label="Reconciled at" value={formatDateTime(details?.reconciled_at || row?.reconciled_at)} />
          <KV label="Audit summary" value={details?.audit_summary || row?.note || "—"} />
          <KV label="Plaid account" value={accountLabel || row?.plaid_account_id || "—"} />
        </div>
      ),
    },
  ];
}

export default function ReconciliationTraceDrawer({
  open,
  row,
  accountLabel,
  statusExplanation,
  onRefresh,
  onOpenBooksReview,
  onClose,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !row) return null;

  const details = row.details || {};
  const trace = buildTrace(row, accountLabel);
  const categoryLabel =
    row?.category_name || details?.final_qbo_account_name || details?.suggested_qbo_account_name || "—";
  const missingPostSchedule =
    row?.status === "missing_in_qbo" &&
    (details?.reason_code === "missing_post_schedule" || details?.posting_state === "missing_post_schedule");
  const isArchived = row?.status === "archived" || details?.canonical_state === "archived";
  const isInternalDuplicate = row?.status === "duplicate_internal";
  const showPostingDiagnostics = hasPostingDiagnostics(details);
  const showPostAttemptSummary = hasPostAttemptSummary(details);
  const latestPostAttemptStatus = titleCase(details?.latest_post_attempt_status || "unknown");
  const latestPostAttemptFailed = details?.latest_post_attempt_status === "failed";
  const postAttemptCount = Number.isFinite(Number(details?.post_attempt_count))
    ? Number(details.post_attempt_count)
    : null;
  const operatorNote =
    details?.audit_summary ||
    getReconciliationIssueCopy(row?.status, details) ||
    row?.note ||
    statusExplanation ||
    "No operator summary is available for this transaction yet.";
  const shouldShowReconciliationRerunNote = ["failed_post", "missing_in_qbo", "duplicate_in_qbo"].includes(row?.status);
  const canOpenBooksReview = ["needs_review", "failed_post", "missing_in_qbo", "approved_waiting_post"].includes(row?.status);

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close trace drawer"
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        onClick={onClose}
      />

      <aside className="absolute right-0 top-0 h-full w-full max-w-[820px] border-l border-[var(--accent-line)] bg-[#0d1210] shadow-[0_0_40px_rgba(0,0,0,0.45)]">
        <div className="flex h-full flex-col">
          <div className="border-b border-white/8 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-emerald-300/80">Transaction trace</div>
                <div className="mt-2 text-xl font-semibold text-slate-100">{row.description || row.merchant || "Untitled transaction"}</div>
                <div className="mt-1 text-sm text-slate-400">
                  {row.merchant || "Unknown merchant"} · {formatMoney(row.amount)} · {formatDate(row.txn_date)}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-100 hover:bg-white/10"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <KV label="Pipeline status" value={pipelineStatusDisplayLabel(row)} />
              <KV label="QBO status" value={titleCase(details?.posting_state || "not_linked")} />
              <KV label="Category" value={categoryLabel} />
              <KV label="Source of truth" value={titleCase(details?.source_of_truth || "unknown")} />
              <KV label="Reconciliation confidence" value={titleCase(details?.reconciliation_confidence || "unknown")} />
              <KV label="Pipeline bucket" value={titleCase(details?.pipeline_bucket || "unknown")} />
              <KV label="Duplicate source" value={titleCase(details?.duplicate_source || "—")} />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="mb-5 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Operator notes</div>
              <div className="mt-2 text-sm leading-6 text-slate-200">
                {operatorNote}
              </div>
              {isArchived ? (
                <div className="mt-3 rounded-xl border border-slate-400/20 bg-slate-400/10 px-3 py-2 text-sm text-slate-200">
                  This transaction was archived by Plaid and is kept here only for audit traceability. It does not affect active reconciliation totals.
                </div>
              ) : null}
              {isInternalDuplicate ? (
                <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
                  Bizzi detected another active row that appeared to represent the same Plaid transaction, so this row was excluded from active reconciliation totals.
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setTimeout(() => onRefresh?.(), 0)}
                  className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-100 hover:bg-white/10"
                >
                  Refresh data
                </button>
                {canOpenBooksReview && onOpenBooksReview ? (
                  <button
                    type="button"
                    onClick={() => {
                      onClose?.();
                      onOpenBooksReview();
                    }}
                    className="rounded-md border border-amber-300/20 bg-amber-400/10 px-3 py-1.5 text-[12px] font-semibold text-amber-100 hover:bg-amber-400/15"
                  >
                    Open in Books Review
                  </button>
                ) : null}
                {(row?.status === "missing_in_qbo" || row?.status === "failed_post" || row?.status === "duplicate_in_qbo") && onRefresh ? (
                  <button
                    type="button"
                    onClick={() => setTimeout(() => onRefresh?.(), 0)}
                    className="rounded-md border border-cyan-300/20 bg-cyan-400/10 px-3 py-1.5 text-[12px] font-semibold text-cyan-100 hover:bg-cyan-400/15"
                  >
                    Run reconciliation again
                  </button>
                ) : null}
                {(details?.qbo_txn_id || row?.qbo_txn_id) ? (
                  <button
                    type="button"
                    className="cursor-default rounded-md border border-emerald-400/20 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-100"
                    title={`QBO ${(details?.qbo_txn_type || row?.qbo_txn_type || "txn")} ${(details?.qbo_txn_id || row?.qbo_txn_id)}`}
                  >
                    QBO metadata: {(details?.qbo_txn_type || row?.qbo_txn_type || "txn")} · {(details?.qbo_txn_id || row?.qbo_txn_id)}
                  </button>
                ) : null}
              </div>
              {shouldShowReconciliationRerunNote ? (
                <div className="mt-3 text-[12px] leading-5 text-slate-400">
                  This reruns reconciliation. Posting retries happen through Bizzi’s posting process.
                </div>
              ) : null}
            </div>

            <div className="mb-5 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Posting diagnostics</div>
              {missingPostSchedule ? (
                <div className="mt-2 rounded-xl border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
                  Approved transaction has no <span className="font-semibold">post_after</span> value.
                </div>
              ) : null}

              {showPostingDiagnostics ? (
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <KV label="Scheduled post time" value={formatDateTime(details?.post_after)} />
                  <KV label="Last post attempt" value={formatDateTime(details?.last_post_attempt_at)} />
                  <KV label="Next retry" value={formatDateTime(details?.next_post_attempt_at)} />
                  <KV label="Posting in progress" value={details?.posting_in_progress === true ? "Yes" : "No"} />
                  <KV label="Retry count" value={details?.retry_count != null ? String(details.retry_count) : "—"} />
                  <KV label="Post error" value={details?.post_error || "—"} />
                  <KV label="Post block reason" value={details?.post_block_reason || "—"} />
                </div>
              ) : (
                <div className="mt-2 text-sm text-slate-400">
                  No posting timing data is available for this transaction.
                </div>
              )}
            </div>

            <div className="mb-5 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Posting attempts</div>
              {!showPostAttemptSummary ? (
                <div className="mt-2 text-sm text-slate-400">No posting attempts recorded.</div>
              ) : (
                <>
                  {latestPostAttemptFailed ? (
                    <div className="mt-2 rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
                      Latest posting attempt failed.
                    </div>
                  ) : null}
                  {postAttemptCount != null && postAttemptCount > 1 ? (
                    <div className="mt-2 text-sm text-slate-300">
                      This transaction has been retried {postAttemptCount} times.
                    </div>
                  ) : null}
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <KV label="Latest attempt status" value={latestPostAttemptStatus} />
                    <KV label="Latest attempt at" value={formatDateTime(details?.latest_post_attempt_at)} />
                    <KV label="Latest attempt error" value={details?.latest_post_attempt_error || "—"} />
                    <KV label="Post attempt count" value={postAttemptCount != null ? String(postAttemptCount) : "—"} />
                  </div>
                </>
              )}
            </div>

            <div className="space-y-6">
              {trace.map((step, index) => (
                <TraceStep key={step.key} title={`${index + 1}. ${step.title}`} tone={step.tone} summary={step.summary}>
                  {step.body}
                </TraceStep>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
