import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Copy, FileSearch, Image as ImageIcon, Link2, Mic, PanelRightOpen, Plus, RefreshCcw, Trash2, Upload, UploadCloud, Wand2, X } from "lucide-react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { getJobsTopUnpaid, getArStatus } from "../../services/jobs/jobs";
import { getDemoJobsTopUnpaid } from "./jobsMockData.js";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";
import { useBusiness } from "../../context/BusinessContext.jsx";
import { useAdminView } from "../../context/AdminViewContext.jsx";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { apiUrl, safeFetch } from "../../utils/safeFetch.js";
import { getQboCoa } from "../../services/bookkeeping/bookkeepingClient.js";
import { convertBidToJob, deleteBidAttachment, fetchBidAttachments, generateBidEstimateRequest, getBidEstimate, listBidEstimates, saveBidOutcome, updateBidEstimate, uploadBidAttachment } from "../../services/jobCosting/bidBuilderClient.js";
import {
  getJobDocumentCount,
  getJobRevenueBasisView,
  getJobReviewWarning,
  getJobSourceBadge,
  getPostedTransactionDisplayName,
  getProjectsCapabilityView,
  getRevenueWaterfallRows,
  getTransactionRoleMeta,
  canAssignWithoutImpactModal,
  hasCanonicalRevenueSummary,
  normalizeAssignmentImpactView,
  normalizeCandidateApprovalImpactView,
  normalizeCandidateView,
  normalizeRevenueSourceRecordView,
} from "./jobCostingUiModel.js";

const DAILY_AR_SYNC_MS = 24 * 60 * 60 * 1000;
const JOB_COSTING_LIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const jobCostingLiveCache = new Map();

const glass =
  "rounded-[28px] bg-white/[0.04] border-0 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const moneyCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const sourceBadgeTone = {
  emerald: "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-100",
  cyan: "border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-100",
  amber: "border-amber-300/25 bg-amber-300/[0.08] text-amber-100",
  rose: "border-rose-300/25 bg-rose-300/[0.08] text-rose-100",
  slate: "border-white/10 bg-white/[0.045] text-white/55",
};

function compactBadgeClass(tone = "slate") {
  return sourceBadgeTone[tone] || sourceBadgeTone.slate;
}

function getJobCostingCacheKey(businessId, readOnly) {
  if (!businessId) return "";
  return `${businessId}:${readOnly ? "readonly" : "live"}`;
}

function hasJobCostingCacheData(cache) {
  return Boolean(
    (Array.isArray(cache?.transactions) && cache.transactions.length > 0) ||
    (Array.isArray(cache?.jobs) && cache.jobs.length > 0) ||
    (Array.isArray(cache?.jobCandidates) && cache.jobCandidates.length > 0) ||
    Number(cache?.jobCandidatesTotal || 0) > 0 ||
    cache?.projectsCapability
  );
}

function readJobCostingLiveCache(businessId, readOnly = false) {
  const key = getJobCostingCacheKey(businessId, readOnly);
  if (!key) return null;
  const cached = jobCostingLiveCache.get(key);
  if (!cached) return null;
  if (Date.now() - Number(cached.cachedAt || 0) > JOB_COSTING_LIVE_CACHE_TTL_MS) {
    jobCostingLiveCache.delete(key);
    return null;
  }
  return cached;
}

function writeJobCostingLiveCache(businessId, readOnly, patch) {
  const key = getJobCostingCacheKey(businessId, readOnly);
  if (!key || !patch || typeof patch !== "object") return;
  const previous = jobCostingLiveCache.get(key) || {};
  const sanitizedPatch = {
    ...patch,
    ...(Array.isArray(patch.jobs) ? { jobs: filterActiveUiJobs(patch.jobs) } : {}),
  };
  jobCostingLiveCache.set(key, {
    ...previous,
    ...sanitizedPatch,
    cachedAt: Date.now(),
  });
}

function SkeletonCard({ className = "", lines = 3 }) {
  return (
    <div
      className={`rounded-[22px] bg-white/[0.05] p-4 sm:p-5 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl animate-pulse ${className}`}
    >
      <div className="space-y-3">
        <div className="h-3 w-24 bg-white/15 rounded-full" />
        <div className="h-5 w-32 bg-white/18 rounded-md" />
        {Array.from({ length: lines }).map((_, idx) => (
          <div
            key={idx}
            className="h-3 w-full bg-white/10 rounded-full"
            style={{ opacity: 0.8 - idx * 0.15 }}
          />
        ))}
      </div>
    </div>
  );
}

function JobCostingInitialLoadingState({ type = "jobs" }) {
  const isTransactions = type === "transactions";
  return (
    <div className={isTransactions ? "p-4" : "w-full min-w-[720px]"}>
      <div className={`rounded-xl border border-emerald-300/14 bg-emerald-300/[0.045] ${isTransactions ? "p-4" : "px-4 py-5"}`}>
        <div className="flex items-center gap-3">
          <RefreshCcw className="h-4 w-4 animate-spin text-emerald-200" />
          <div>
            <div className="text-sm font-semibold text-emerald-50">Loading live job costing data</div>
            <div className="mt-0.5 text-xs text-white/45">Fetching saved jobs, suggested jobs, and posted QuickBooks transactions.</div>
          </div>
        </div>
        <div className={`mt-4 grid gap-3 ${isTransactions ? "" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
          {Array.from({ length: isTransactions ? 4 : 3 }).map((_, idx) => (
            <SkeletonCard key={idx} lines={isTransactions ? 2 : 3} className={isTransactions ? "min-h-[64px]" : "min-h-[148px]"} />
          ))}
        </div>
      </div>
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return "";
  const now = Date.now();
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = now - then;
  const mins = Math.floor(diffMs / (1000 * 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDate(date) {
  if (!date) return "No date";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "No date";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getCustomerName(row) {
  return row.parent_customer_name || row.client_name || row.title || "(Unknown customer)";
}

function getInvoiceNumber(row) {
  return row.doc_number || row.external_id || row.qbo_invoice_id || row.id || "Invoice";
}

function getInvoiceKey(row) {
  return String(row.qbo_invoice_id || row.external_id || row.doc_number || row.id || getInvoiceNumber(row));
}

function getDaysOverdue(row) {
  const days = Number(row.days_overdue || 0);
  if (Number.isFinite(days) && days > 0) return days;
  if (!row.due_date) return 0;
  const due = new Date(row.due_date);
  if (Number.isNaN(due.getTime())) return 0;
  const now = new Date();
  due.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((now - due) / (1000 * 60 * 60 * 24)));
}

function buildAgingBuckets(rows) {
  const buckets = [
    { key: "current", label: "Current", min: 0, max: 0, total: 0, count: 0, color: "#3fb489", soft: "rgba(63,180,137,0.16)" },
    { key: "1-30", label: "1-30", min: 1, max: 30, total: 0, count: 0, color: "#f0c56b", soft: "rgba(240,197,107,0.14)" },
    { key: "31-60", label: "31-60", min: 31, max: 60, total: 0, count: 0, color: "#e99b60", soft: "rgba(233,155,96,0.14)" },
    { key: "61-90", label: "61-90", min: 61, max: 90, total: 0, count: 0, color: "#e06d67", soft: "rgba(224,109,103,0.14)" },
    { key: "90+", label: "90+", min: 91, max: Infinity, total: 0, count: 0, color: "#c95c80", soft: "rgba(201,92,128,0.14)" },
  ];
  rows.forEach((row) => {
    const days = getDaysOverdue(row);
    const amount = Number(row.amount_due ?? row.balance ?? 0) || 0;
    const bucket = buckets.find((b) => days >= b.min && days <= b.max) || buckets[buckets.length - 1];
    bucket.total += amount;
    bucket.count += 1;
  });
  return buckets;
}

function buildFollowupRounds(row) {
  const followups = row.followups || {};
  const existing = Array.isArray(followups.rounds) ? followups.rounds : [];
  const days = getDaysOverdue(row);
  const sentCount = Number(followups.sent_count || 0);
  const draftCount = Number(followups.draft_count || 0);
  const offsets = [1, 7, 14];
  return offsets.map((offset, idx) => {
    const roundNumber = idx + 1;
    const stored = existing.find((item) => Number(item.round) === roundNumber) || existing[idx] || null;
    let status = stored?.status || "upcoming";
    if (!stored) {
      if (sentCount >= roundNumber) status = "sent";
      else if (draftCount >= roundNumber) status = "drafted";
      else if (days >= offset) status = "draft due";
      else status = "scheduled";
    }
    return {
      round: roundNumber,
      offset,
      status,
      subject: stored?.subject || null,
      body: stored?.body || null,
      drafted_at: stored?.drafted_at || (roundNumber <= draftCount ? followups.last_drafted_at : null),
      sent_at: stored?.sent_at || (roundNumber <= sentCount ? followups.last_sent_at : null),
      scheduled_for: stored?.scheduled_for || (roundNumber === sentCount + draftCount + 1 ? followups.next_scheduled_at : null),
    };
  });
}

function buildEmailCopy(row, roundNumber) {
  const customerName = getCustomerName(row);
  const invoiceNumber = getInvoiceNumber(row);
  const amount = money.format(row.amount_due ?? row.balance ?? 0);
  const dueDate = formatDate(row.due_date);
  const copy = {
    1: {
      subject: `Quick reminder: invoice ${invoiceNumber}`,
      body: `Hi ${customerName},\n\nI wanted to send a quick reminder that invoice ${invoiceNumber} for ${amount} was due on ${dueDate}.\n\nWhen you have a moment, please let us know when we can expect payment. If it has already been sent, thank you, and please disregard this note.\n\nBest,`,
    },
    2: {
      subject: `Following up on invoice ${invoiceNumber}`,
      body: `Hi ${customerName},\n\nI am following up on invoice ${invoiceNumber}. Our records still show an open balance of ${amount}, originally due on ${dueDate}.\n\nCould you confirm the payment status or let us know if anything is needed on our side to get this cleared up?\n\nThank you,`,
    },
    3: {
      subject: `Action requested: overdue invoice ${invoiceNumber}`,
      body: `Hi ${customerName},\n\nI am checking in again on invoice ${invoiceNumber}, which still shows an outstanding balance of ${amount} from ${dueDate}.\n\nPlease reply with an expected payment date, or let us know today if there is an issue we should review.\n\nThank you,`,
    },
  };
  return copy[roundNumber] || copy[1];
}

function mergeFollowupState(base = {}, override = {}) {
  const baseRounds = Array.isArray(base.rounds) ? base.rounds : [];
  const overrideRounds = Array.isArray(override.rounds) ? override.rounds : [];
  const byRound = new Map();
  baseRounds.forEach((round) => byRound.set(Number(round.round), round));
  overrideRounds.forEach((round) => byRound.set(Number(round.round), { ...byRound.get(Number(round.round)), ...round }));
  const rounds = Array.from(byRound.values()).sort((a, b) => Number(a.round || 0) - Number(b.round || 0));
  return {
    ...base,
    ...override,
    rounds,
  };
}

function AgingChart({ rows, status, refreshing, onRefresh, showRefresh = true }) {
  const buckets = useMemo(() => buildAgingBuckets(rows), [rows]);
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  const max = Math.max(...buckets.map((bucket) => bucket.total), 1);
  const overdue = rows.reduce((sum, row) => sum + (getDaysOverdue(row) > 0 ? Number(row.amount_due ?? row.balance ?? 0) || 0 : 0), 0);
  const ringRadius = 72;
  const ringStroke = 18;
  const ringCircumference = 2 * Math.PI * ringRadius;
  let ringOffset = 0;
  const largestBucket = buckets.reduce((winner, bucket) => (bucket.total > winner.total ? bucket : winner), buckets[0]);
  const overdueShare = total > 0 ? Math.round((overdue / total) * 100) : 0;

  return (
    <section className={`${glass} p-4 sm:p-6`} aria-label="AR aging">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/50">Collections</p>
          <h2 className="text-xl font-semibold text-white">AR aging</h2>
          <p className="text-sm text-white/55">
            {status?.last_synced_at
              ? `QuickBooks synced ${timeAgo(status.last_synced_at)}`
              : "Waiting for the first QuickBooks AR sync"}
          </p>
        </div>
        {showRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border text-white/85 transition hover:bg-white/14 hover:border-white/50 focus:outline-none focus:ring-2 focus:ring-white/14 disabled:opacity-60"
            style={{ borderColor: "rgba(255,255,255,0.22)", background: "rgba(18,18,20,0.86)" }}
            aria-label="Refresh collections"
            title="Refresh"
          >
            <RefreshCcw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          </button>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.95fr,1.05fr]">
        <div className="rounded-[22px] bg-white/[0.05] p-4 sm:p-5 shadow-[0_18px_40px_rgba(0,0,0,0.28)] transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.01]">
          <div className="grid gap-4 sm:grid-cols-[220px,1fr] items-center">
            <div className="relative mx-auto h-[220px] w-[220px]">
              <svg viewBox="0 0 180 180" className="h-full w-full -rotate-90">
                <circle
                  cx="90"
                  cy="90"
                  r={ringRadius}
                  fill="none"
                  stroke="rgba(255,255,255,0.07)"
                  strokeWidth={ringStroke}
                />
                {total > 0 ? (
                  buckets.map((bucket) => {
                    const share = bucket.total / total;
                    if (share <= 0) return null;
                    const dash = Math.max(1, share * ringCircumference - 3);
                    const gap = ringCircumference - dash;
                    const segment = (
                      <circle
                        key={bucket.key}
                        cx="90"
                        cy="90"
                        r={ringRadius}
                        fill="none"
                        stroke={bucket.color}
                        strokeWidth={ringStroke}
                        strokeLinecap="round"
                        strokeDasharray={`${dash} ${gap}`}
                        strokeDashoffset={-ringOffset}
                      />
                    );
                    ringOffset += share * ringCircumference;
                    return segment;
                  })
                ) : (
                  <circle
                    cx="90"
                    cy="90"
                    r={ringRadius}
                    fill="none"
                    stroke="rgba(var(--accent-rgb),0.38)"
                    strokeWidth={ringStroke}
                    strokeLinecap="round"
                    strokeDasharray={`${ringCircumference * 0.82} ${ringCircumference}`}
                  />
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Open AR</div>
                <div className="mt-1 text-3xl font-semibold text-white">{money.format(total)}</div>
                <div className="mt-1 text-xs text-white/50">{rows.length} invoices</div>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-white/50">Highest bucket</div>
                <div className="mt-1 text-2xl font-semibold text-white">{largestBucket.label}</div>
                <div className="text-sm text-white/55">{money.format(largestBucket.total)} across {largestBucket.count} invoices</div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-[14px] bg-white/[0.05] px-3 py-2">
                  <div className="text-white/45 text-[11px] uppercase tracking-wide">Overdue</div>
                  <div className="font-semibold text-amber-100">{money.format(overdue)}</div>
                </div>
                <div className="rounded-[14px] bg-white/[0.05] px-3 py-2">
                  <div className="text-white/45 text-[11px] uppercase tracking-wide">Overdue share</div>
                  <div className="font-semibold text-white">{overdueShare}%</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {buckets.map((bucket) => (
            <div
              key={bucket.key}
              className="rounded-[18px] border border-white/10 p-4 shadow-[0_14px_30px_rgba(0,0,0,0.18)] transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.015]"
              style={{ background: `linear-gradient(135deg, ${bucket.soft}, rgba(255,255,255,0.035))` }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: bucket.color, boxShadow: `0 0 12px ${bucket.color}` }} />
                    {bucket.label}
                  </div>
                  <div className="mt-1 text-xs text-white/45">{bucket.count} invoices</div>
                </div>
                <div className="text-right text-sm font-semibold text-white">{money.format(bucket.total)}</div>
              </div>
              <div className="mt-4 h-2 rounded-full bg-white/[0.08] overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: bucket.total > 0 ? `${Math.max(8, (bucket.total / max) * 100)}%` : "0%",
                    backgroundColor: bucket.color,
                    boxShadow: `0 0 18px ${bucket.color}`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function OutstandingInvoices({ rows }) {
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const customer = getCustomerName(a).localeCompare(getCustomerName(b));
      if (customer !== 0) return customer;
      return getDaysOverdue(b) - getDaysOverdue(a);
    });
  }, [rows]);

  return (
    <section className={`${glass} p-4 sm:p-6`} aria-label="Outstanding invoices">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-white">Outstanding invoices</h3>
        <p className="text-sm text-white/55">Sorted by customer from QuickBooks open AR.</p>
      </div>
      {!sorted.length ? (
        <div className="rounded-[18px] bg-white/[0.05] px-4 py-5 text-sm text-white/70">
          No outstanding invoices right now.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[18px] bg-white/[0.04]">
          <div className="max-h-[360px] overflow-y-auto custom-scrollbar divide-y divide-white/6">
            {sorted.map((row) => {
              const days = getDaysOverdue(row);
              return (
                <div
                  key={row.qbo_invoice_id || row.id || getInvoiceNumber(row)}
                  className="grid grid-cols-[1.25fr,0.8fr,0.7fr,0.65fr,0.7fr] gap-3 px-4 py-3 text-sm items-center hover:bg-white/[0.04] transition"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-white truncate">{getCustomerName(row)}</div>
                    <div className="text-[11px] text-white/45 truncate">{row.title || row.external_source || "QuickBooks"}</div>
                  </div>
                  <div className="text-white/75 truncate">{getInvoiceNumber(row)}</div>
                  <div>
                    <div className="text-white/80">{formatDate(row.due_date)}</div>
                    <div className={days > 0 ? "text-[11px] text-amber-200" : "text-[11px] text-white/45"}>
                      {days > 0 ? `${days}d past due` : "Current"}
                    </div>
                  </div>
                  <div>
                    <span className="rounded-full border border-white/12 bg-white/[0.05] px-2 py-1 text-xs capitalize text-white/75">
                      {row.invoice_status || row.status || "open"}
                    </span>
                  </div>
                  <div className="text-right font-semibold text-white">{money.format(row.amount_due ?? row.balance ?? 0)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function ArTracker({ rows, onDraftFollowup, onMarkSent }) {
  const tracked = useMemo(() => rows.filter((row) => getDaysOverdue(row) > 0), [rows]);
  const [copiedKey, setCopiedKey] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const copyDraft = async (key, subject, body) => {
    const text = `Subject: ${subject}\n\n${body}`;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      setCopiedKey(null);
    }
  };

  const runAction = async (key, action) => {
    setBusyKey(key);
    try {
      await action();
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className={`${glass} p-4 sm:p-6`} aria-label="AR tracker">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-white">Invoice follow-up tracker</h3>
        <p className="text-sm text-white/55">Three-round draft cadence for past-due invoices.</p>
      </div>
      {!tracked.length ? (
        <div className="rounded-[18px] bg-white/[0.05] px-4 py-5 text-sm text-white/70">
          No past-due invoices need follow-up.
        </div>
      ) : (
        <div className="space-y-3">
          {tracked.map((row) => {
            const followups = row.followups || {};
            const rounds = buildFollowupRounds(row);
            const activeRound =
              rounds.find((round) => round.status === "drafted" || round.status === "draft due") ||
              rounds.find((round) => round.status === "scheduled") ||
              rounds.find((round) => round.status !== "sent") ||
              rounds[rounds.length - 1];
            const fallbackCopy = buildEmailCopy(row, activeRound.round);
            const subject = activeRound.subject || fallbackCopy.subject;
            const body = activeRound.body || fallbackCopy.body;
            const actionKey = `${row.qbo_invoice_id || row.id || getInvoiceNumber(row)}:${activeRound.round}`;
            const isBusy = busyKey === actionKey;
            return (
              <article
                key={row.qbo_invoice_id || row.id || getInvoiceNumber(row)}
                className="rounded-[18px] bg-white/[0.05] p-4 shadow-[0_14px_30px_rgba(0,0,0,0.24)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-white truncate">
                      {getCustomerName(row)} • {getInvoiceNumber(row)}
                    </h4>
                    <p className="text-[12px] text-white/50">
                      {money.format(row.amount_due ?? row.balance ?? 0)} due {formatDate(row.due_date)} • {getDaysOverdue(row)}d past due
                    </p>
                  </div>
                  <div className="text-right text-[12px] text-white/55">
                    <div>Last drafted: {followups.last_drafted_at ? timeAgo(followups.last_drafted_at) : "Not yet"}</div>
                    <div>Last follow-up: {followups.last_sent_at ? timeAgo(followups.last_sent_at) : "Not sent"}</div>
                    <div>Next draft: {followups.next_scheduled_at ? formatDate(followups.next_scheduled_at) : "Cadence pending"}</div>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 md:grid-cols-3">
                  {rounds.map((round) => {
                    const active = round.status === "draft due" || round.status === "drafted";
                    return (
                      <div
                        key={round.round}
                        className={`rounded-[14px] border px-3 py-3 ${
                          active
                            ? "border-[rgba(var(--accent-rgb),0.35)] bg-[rgba(var(--accent-rgb),0.12)]"
                            : "border-white/10 bg-white/[0.035]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-white">Round {round.round}</span>
                          <span className="text-[11px] capitalize text-white/60">{round.status}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-white/45">
                          {round.sent_at
                            ? `Sent ${timeAgo(round.sent_at)}`
                            : round.drafted_at
                            ? `Drafted ${timeAgo(round.drafted_at)}`
                            : round.scheduled_for
                            ? `Scheduled ${formatDate(round.scheduled_for)}`
                            : `${round.offset}d after due`}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 rounded-[16px] border border-white/10 bg-white/[0.035] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-white">Round {activeRound.round} email copy</div>
                      <div className="text-[11px] text-white/45">Review, copy, and send from your own inbox.</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyDraft(actionKey, subject, body)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                          copiedKey === actionKey
                            ? "border-[rgba(var(--accent-rgb),0.5)] bg-[rgba(var(--accent-rgb),0.18)] text-white"
                            : "border-white/15 bg-white/[0.06] text-white/85 hover:bg-white/[0.12]"
                        }`}
                      >
                        {copiedKey === actionKey ? "✓ Copied!" : "Copy Email"}
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => runAction(actionKey, () => onDraftFollowup(row, activeRound.round))}
                        className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-white/85 hover:bg-white/[0.12] disabled:opacity-60"
                      >
                        {isBusy ? "Working..." : "Regenerate"}
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => runAction(actionKey, () => onMarkSent(row, activeRound.round, { subject, body }))}
                        className="rounded-full border border-[rgba(var(--accent-rgb),0.45)] bg-[rgba(var(--accent-rgb),0.16)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[rgba(var(--accent-rgb),0.24)] disabled:opacity-60"
                      >
                        Mark Sent
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 rounded-[12px] bg-black/20 p-3">
                    <div className="text-[12px] font-semibold text-white/85">Subject: {subject}</div>
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-[12px] leading-5 text-white/65">{body}</pre>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

const demoJobCostingJobs = [
  {
    id: "demo-job-1",
    job_name: "Johnson Deck Rebuild",
    customer_name: "Maya Johnson",
    trade_type: "Decking",
    status: "in_progress",
    start_date: "2026-05-01",
    source_type: "qbo_project",
    revenue_source_status: "canonical",
    job_costing_revenue_basis: "invoiced",
    selected_basis_amount: 7200,
    contract_value: 12800,
    gross_invoiced_revenue: 7200,
    credit_memo_amount: 0,
    net_invoiced_revenue: 7200,
    payments_applied: 3600,
    collected_cash: 3600,
    outstanding_receivable: 3600,
    remaining_to_bill: 5600,
    recognized_revenue: 7200,
    source_document_count: 4,
  },
  {
    id: "demo-job-2",
    job_name: "Hawthorne Porch",
    customer_name: "Hawthorne Builders",
    trade_type: "Carpentry",
    status: "active",
    start_date: "2026-04-22",
    source_type: "manual",
    revenue_source_status: "canonical",
    job_costing_revenue_basis: "contract_value",
    selected_basis_amount: 8100,
    contract_value: 8100,
    gross_invoiced_revenue: 5400,
    credit_memo_amount: 0,
    net_invoiced_revenue: 5400,
    payments_applied: 5400,
    collected_cash: 5400,
    outstanding_receivable: 0,
    remaining_to_bill: 2700,
    recognized_revenue: 5400,
    source_document_count: 3,
  },
  {
    id: "demo-job-3",
    job_name: "Smith Kitchen Refresh",
    customer_name: "Avery Smith",
    trade_type: "Remodel",
    status: "active",
    start_date: "2026-04-18",
    source_type: "candidate_invoice",
    revenue_source_status: "canonical",
    job_costing_revenue_basis: "collected",
    selected_basis_amount: 4600,
    contract_value: 9200,
    gross_invoiced_revenue: 4600,
    credit_memo_amount: 0,
    net_invoiced_revenue: 4600,
    payments_applied: 4600,
    collected_cash: 4600,
    outstanding_receivable: 0,
    remaining_to_bill: 4600,
    recognized_revenue: 4600,
    source_document_count: 3,
  },
  {
    id: "demo-job-4",
    job_name: "Brown Bath Remodel",
    customer_name: "Jordan Brown",
    trade_type: "Plumbing",
    status: "scheduled",
    start_date: "2026-05-12",
    source_type: "qbo_subcustomer",
    revenue_source_status: "canonical",
    job_costing_revenue_basis: "invoiced",
    selected_basis_amount: 0,
    contract_value: 6500,
    gross_invoiced_revenue: 0,
    credit_memo_amount: 0,
    net_invoiced_revenue: 0,
    payments_applied: 0,
    collected_cash: 0,
    outstanding_receivable: 0,
    remaining_to_bill: 6500,
    recognized_revenue: 0,
    source_document_count: 1,
    review_warning: "Awaiting first invoice link",
  },
];

const demoJobCandidates = [
  {
    id: "demo-candidate-1",
    candidate_status: "pending",
    candidate_type: "invoice",
    source_system: "quickbooks",
    source_entity_type: "Invoice",
    source_entity_id: "1045",
    suggested_job_name: "Brown Bath Remodel",
    customer_name: "Jordan Brown",
    service_address: "42 Walnut Street, Anytown",
    document_number: "INV-1045",
    document_date: "2026-05-08",
    invoice_estimate_amount: 3500,
    confidence_score: 78,
    confidence_level: "medium",
    detection_reasons: ["QBO sub-customer match", "Service address matches scheduled work", "Line items reference bath remodel labor"],
    possible_job_matches: [{ job_id: "demo-job-4", job_name: "Brown Bath Remodel", confidence: 92 }],
  },
];

const demoProjectsCapability = {
  status: "available_and_enabled",
  checked_at: "2026-07-24T13:00:00.000Z",
  project_management_scope_present: true,
  projects_enabled_preference: true,
  last_successful_project_sync: "2026-07-24T12:52:00.000Z",
};

function demoAssignment(txn, jobId, percentValue = 100, source = "manual_drag_drop") {
  const job = demoJobCostingJobs.find((item) => item.id === jobId);
  const allocationPercent = Number(percentValue) || 100;
  const allocatedAmount = Math.abs(Number(txn.amount || 0)) * (allocationPercent / 100);
  const signedAllocatedAmount = Number(txn.amount || 0) < 0 ? -allocatedAmount : allocatedAmount;
  const assignmentId = `${txn.id}-${jobId}`;
  return {
    ...txn,
    amount: signedAllocatedAmount,
    job_id: jobId,
    job_label: job?.job_name || "Demo Job",
    assignment_id: assignmentId,
    assignment_row_id: assignmentId,
    assignment_source: source,
    assignment_confidence: source === "natural_language" ? 0.92 : 1,
    allocation_percent: allocationPercent,
    allocated_amount: allocatedAmount,
  };
}

function demoPostedTransaction({
  id,
  date,
  vendor,
  description,
  amount,
  direction,
  accountName,
  accountId,
  qboType = "Expense",
  financialRole = null,
  sourceSystem = "qbo",
  qboTxnId = null,
  postedAt = null,
  plaidAccountId = "demo-plaid-checking",
  assignments = [],
}) {
  const memo = description || vendor || "";
  const base = {
    id,
    date,
    transaction_date: date,
    vendor,
    payee: vendor,
    description: memo,
    memo,
    bank_memo: memo,
    original_description: memo,
    amount,
    direction,
    status: "posted",
    gl_account: accountName,
    final_qbo_account_id: accountId,
    final_qbo_account_name: accountName,
    qbo_txn_id: qboTxnId || `QBO-${String(id).replace("demo-posted-", "").toUpperCase()}`,
    qbo_txn_type: qboType,
    qbo_entity_type: qboType,
    financial_role: financialRole || qboType,
    source_system: sourceSystem,
    posted_at: postedAt || `${date}T15:30:00.000Z`,
    plaid_account_id: plaidAccountId,
  };
  const assignmentRows = assignments.map((assignment) => demoAssignment(base, assignment.jobId, assignment.percent, assignment.source));
  const assignedPercent = assignmentRows.reduce((sum, row) => sum + Number(row.allocation_percent || 0), 0);
  const assignedJobNames = assignmentRows.map((row) => row.job_label).filter(Boolean);
  return {
    ...base,
    job_id: assignmentRows[0]?.job_id || null,
    job_label: assignmentRows.length > 1 ? `Split across ${assignmentRows.length} jobs` : assignmentRows[0]?.job_label || null,
    assignment_id: assignmentRows[0]?.assignment_id || null,
    assignment_ids: assignmentRows.map((row) => row.assignment_id),
    assignment_rows: assignmentRows,
    assignment_status: assignedPercent >= 99.999 ? "assigned" : assignedPercent > 0 ? "partial" : "unassigned",
    assignment_count: assignmentRows.length,
    assigned_job_names: assignedJobNames,
    assigned_total_percent: assignedPercent,
    remaining_percent: Math.max(0, 100 - assignedPercent),
    assignment_source: assignmentRows[0]?.assignment_source || null,
    assignment_confidence: assignmentRows[0]?.assignment_confidence || null,
  };
}

function demoPostedTransactionFromBookkeeping(row = {}) {
  const accountName = row.final_qbo_account_name || row.glAccountName || row.suggestedCategory || row.currentAccount || "Uncategorized";
  const accountId = row.final_qbo_account_id || row.glAccountId || row.suggestedAccountId || null;
  const assignments = Array.isArray(row.job_costing_assignments)
    ? row.job_costing_assignments.map((assignment) => ({
        jobId: assignment.job_id || assignment.jobId,
        percent: assignment.allocation_percent ?? assignment.percent ?? 100,
        source: assignment.source || "manual_drag_drop",
      })).filter((assignment) => assignment.jobId)
    : [];
  return demoPostedTransaction({
    id: row.id,
    date: row.date,
    vendor: row.vendor || row.payee || row.merchant_name || "Unknown payee",
    description: getTransactionMemo(row) || row.name || row.description || "",
    amount: Number(row.amount || 0),
    direction: row.direction || (Number(row.amount || 0) < 0 ? "OUTFLOW" : "INFLOW"),
    accountName,
    accountId,
    qboType: row.qbo_txn_type || "Expense",
    financialRole: row.financial_role || row.transaction_role || row.qbo_txn_type || "Expense",
    qboTxnId: row.qbo_txn_id || row.qboTxnId || null,
    postedAt: row.posted_at || row.postedAt || null,
    plaidAccountId: row.plaid_account_id || row.plaidAccountId || row.accountId || "demo-plaid-checking",
    assignments,
  });
}

// Job Costing uses posted Books transactions as the source of truth. Demo mode mirrors that shape.
const fallbackDemoJobCostingTransactions = [
  demoPostedTransaction({
    id: "demo-posted-001",
    date: "2026-05-20",
    vendor: "Johnson Deck Rebuild",
    description: "QBO INV 1042 JOHNSON DECK REBUILD PROGRESS PMT",
    amount: 7200,
    direction: "INFLOW",
    accountName: "Construction Income",
    accountId: "qbo-income-construction",
    qboType: "Invoice",
    financialRole: "invoice",
    assignments: [{ jobId: "demo-job-1", percent: 100, source: "invoice_match" }],
  }),
  demoPostedTransaction({
    id: "demo-posted-002",
    date: "2026-05-19",
    vendor: "Home Depot",
    description: "HOME DEPOT #445 05/19 ANYTOWN ST MATERIALS",
    amount: -1842.33,
    direction: "OUTFLOW",
    accountName: "Job Materials",
    accountId: "qbo-cogs-materials",
    assignments: [{ jobId: "demo-job-1", percent: 100, source: "natural_language" }],
  }),
  demoPostedTransaction({
    id: "demo-posted-003",
    date: "2026-05-18",
    vendor: "Crew Payroll",
    description: "PAYROLL ACH CREW A 051826 DIRECT DEP",
    amount: -1280,
    direction: "OUTFLOW",
    accountName: "Direct Labor",
    accountId: "qbo-cogs-labor",
    assignments: [{ jobId: "demo-job-1", percent: 100, source: "manual_drag_drop" }],
  }),
  demoPostedTransaction({
    id: "demo-posted-004",
    date: "2026-05-17",
    vendor: "Ferguson",
    description: "FERGUSON ENT 0517 INV 44391 PLUMB MAT",
    amount: -1000,
    direction: "OUTFLOW",
    accountName: "Job Materials",
    accountId: "qbo-cogs-materials",
    assignments: [
      { jobId: "demo-job-3", percent: 60, source: "manual_drag_drop" },
      { jobId: "demo-job-4", percent: 40, source: "manual_drag_drop" },
    ],
  }),
  demoPostedTransaction({
    id: "demo-posted-005",
    date: "2026-05-16",
    vendor: "Hawthorne Builders",
    description: "QBO INV 1043 HAWTHORNE BUILDERS PORCH PMT",
    amount: 5400,
    direction: "INFLOW",
    accountName: "Construction Income",
    accountId: "qbo-income-construction",
    qboType: "Invoice",
    financialRole: "invoice",
    assignments: [{ jobId: "demo-job-2", percent: 100, source: "invoice_match" }],
  }),
  demoPostedTransaction({
    id: "demo-posted-006",
    date: "2026-05-15",
    vendor: "Cedar Supply Co.",
    description: "CEDAR SUPPLY CO 0515 LUMBER ORDER 7821",
    amount: -1560.12,
    direction: "OUTFLOW",
    accountName: "Job Materials",
    accountId: "qbo-cogs-materials",
    assignments: [{ jobId: "demo-job-2", percent: 100, source: "manual_drag_drop" }],
  }),
  demoPostedTransaction({
    id: "demo-posted-007",
    date: "2026-05-14",
    vendor: "Avery Smith",
    description: "QBO INV 1044 AVERY SMITH KITCHEN DEPOSIT",
    amount: 4600,
    direction: "INFLOW",
    accountName: "Construction Income",
    accountId: "qbo-income-construction",
    qboType: "Invoice",
    financialRole: "invoice",
    assignments: [{ jobId: "demo-job-3", percent: 100, source: "invoice_match" }],
  }),
  demoPostedTransaction({
    id: "demo-posted-008",
    date: "2026-05-13",
    vendor: "Tile House",
    description: "TILE HOUSE 0513 POS 7782 BACKSPLASH",
    amount: -980,
    direction: "OUTFLOW",
    accountName: "Job Materials",
    accountId: "qbo-cogs-materials",
    assignments: [{ jobId: "demo-job-3", percent: 100, source: "natural_language" }],
  }),
  demoPostedTransaction({
    id: "demo-posted-009",
    date: "2026-05-12",
    vendor: "Amazon Business",
    description: "AMZN MKTP*BUSINESS PMTS SITE SUPPLIES",
    amount: -214.19,
    direction: "OUTFLOW",
    accountName: "Job Supplies",
    accountId: "qbo-cogs-supplies",
  }),
  demoPostedTransaction({
    id: "demo-posted-010",
    date: "2026-05-10",
    vendor: "Lowe's",
    description: "LOWES #1172 0510 VANITY TRIM HDWR",
    amount: -736.42,
    direction: "OUTFLOW",
    accountName: "Job Materials",
    accountId: "qbo-cogs-materials",
  }),
  demoPostedTransaction({
    id: "demo-posted-011",
    date: "2026-05-09",
    vendor: "Northside Electric",
    description: "NORTHSIDE ELECTRIC ACH 0509 ROUGH IN",
    amount: -1425,
    direction: "OUTFLOW",
    accountName: "Subcontractors",
    accountId: "qbo-cogs-subcontractors",
  }),
  demoPostedTransaction({
    id: "demo-posted-012",
    date: "2026-05-08",
    vendor: "Brown Bath Remodel",
    description: "QBO INV 1045 BROWN BATH DEPOSIT",
    amount: 3500,
    direction: "INFLOW",
    accountName: "Construction Income",
    accountId: "qbo-income-construction",
    qboType: "Invoice",
    financialRole: "invoice",
  }),
  demoPostedTransaction({
    id: "demo-posted-013",
    date: "2026-04-28",
    vendor: "Miller Disposal",
    description: "MILLER DISPOSAL 0428 DUMPSTER RENTAL",
    amount: -485,
    direction: "OUTFLOW",
    accountName: "Job Other Costs",
    accountId: "qbo-cogs-other",
  }),
  demoPostedTransaction({
    id: "demo-posted-014",
    date: "2026-05-07",
    vendor: "Maya Johnson",
    description: "QBO PMT 8912 APPLIED TO INV 1042",
    amount: 3600,
    direction: "INFLOW",
    accountName: "Undeposited Funds",
    accountId: "qbo-undeposited-funds",
    qboType: "Payment",
    financialRole: "payment",
    assignments: [{ jobId: "demo-job-1", percent: 100, source: "payment_link" }],
  }),
  demoPostedTransaction({
    id: "demo-posted-015",
    date: "2026-05-06",
    vendor: "QuickBooks Payments",
    description: "BANK DEPOSIT BATCH 8912 LESS PROCESSING FEE",
    amount: 3540,
    direction: "INFLOW",
    accountName: "Checking",
    accountId: "qbo-bank-checking",
    qboType: "Deposit",
    financialRole: "deposit",
    sourceSystem: "bank",
    assignments: [{ jobId: "demo-job-1", percent: 100, source: "settlement_evidence" }],
  }),
];

const demoBookkeepingPostedTransactions = (getDemoData()?.bookkeeping?.transactions || [])
  .filter((row) => String(row.status || "").toLowerCase() === "posted" || row.qbo_txn_id || row.qboTxnId)
  .map(demoPostedTransactionFromBookkeeping);

const demoJobCostingTransactions = demoBookkeepingPostedTransactions.length
  ? demoBookkeepingPostedTransactions
  : fallbackDemoJobCostingTransactions;

function buildDemoJobCostingJobs(transactions = demoJobCostingTransactions) {
  return demoJobCostingJobs.map((job) => {
    const assignmentRows = transactions.flatMap((txn) => {
      if (Array.isArray(txn.assignment_rows) && txn.assignment_rows.length) return txn.assignment_rows;
      return txn.job_id ? [txn] : [];
    }).filter((txn) => String(txn.job_id) === String(job.id));
    const totalCost = assignmentRows.reduce((sum, txn) => {
      const role = getTransactionRoleMeta(txn);
      if (role.key !== "cost") return sum;
      return sum + Math.abs(Number(txn.allocated_amount ?? txn.amount ?? 0));
    }, 0);
    const basis = getJobRevenueBasisView(job);
    const revenue = Number(basis.amount || 0);
    const grossMargin = revenue - totalCost;
    return {
      ...job,
      revenue,
      total_revenue: revenue,
      total_cost: totalCost,
      gross_margin: grossMargin,
      margin_percent: revenue > 0 ? (grossMargin / revenue) * 100 : null,
      assigned_transaction_count: assignmentRows.length,
    };
  });
}

function buildDemoAssignmentImpactPreview(transaction = {}, allocationPercent = 100) {
  const role = getTransactionRoleMeta(transaction);
  const amount = Math.abs(Number(transaction.amount || 0)) * (Number(allocationPercent || 100) / 100);
  const map = {
    invoice: "invoice",
    payment: "qbo_payment",
    deposit: "bank_deposit_evidence",
    sales_receipt: "sales_receipt",
    credit: "credit_memo",
    unmatched_inflow: "unmatched_inflow",
    cost: "expense",
  };
  const financialRole = map[role.key] || "non_job_transaction";
  return {
    financial_role: financialRole,
    amount,
    allocation_percent: Number(allocationPercent || 100),
    revenue_delta: financialRole === "invoice" || financialRole === "sales_receipt" ? amount : financialRole === "credit_memo" ? -amount : 0,
    cost_delta: financialRole === "expense" ? amount : 0,
    collected_cash_delta: financialRole === "qbo_payment" || financialRole === "sales_receipt" ? amount : 0,
    outstanding_receivable_delta: financialRole === "invoice" ? amount : financialRole === "qbo_payment" || financialRole === "credit_memo" ? -amount : 0,
    duplicate_revenue_prevented: ["qbo_payment", "bank_deposit_evidence"].includes(financialRole),
    requires_user_choice: financialRole === "unmatched_inflow",
    safe_to_assign_without_confirmation: financialRole === "expense",
    choices: financialRole === "unmatched_inflow" ? ["match_existing_invoice_or_payment", "record_separate_job_revenue", "not_job_revenue"] : [],
    explanation: role.effect,
  };
}

function buildDemoCandidateApprovalPreview(candidate = {}, job = null, mode = "create_new") {
  const view = normalizeCandidateView(candidate);
  return {
    mode,
    job_to_create: mode === "create_new" ? { job_name: view.name, customer_name: view.customer } : null,
    job_to_link: mode === "link_existing" ? { id: job?.id, job_name: job?.jobName || job?.job_name || "Existing job" } : null,
    documents_to_attach: [{ source_entity_type: candidate.source_entity_type || "invoice", source_entity_id: candidate.source_entity_id || candidate.id }],
    document_count: 1,
    invoiced_revenue_change: view.amount,
    collected_cash_change: 0,
    receivable_change: view.amount,
    duplicate_prevention: { result: "canonical_document_attached_once" },
  };
}

function hydrateDemoAssignmentMetadata(txn, assignmentRows) {
  const rows = assignmentRows.filter(Boolean);
  const assignedPercent = rows.reduce((sum, row) => sum + Number(row.allocation_percent || 0), 0);
  const assignedJobNames = rows.map((row) => row.job_label).filter(Boolean);
  return {
    ...txn,
    job_id: rows[0]?.job_id || null,
    job_label: rows.length > 1 ? `Split across ${rows.length} jobs` : rows[0]?.job_label || null,
    assignment_id: rows[0]?.assignment_id || null,
    assignment_ids: rows.map((row) => row.assignment_id),
    assignment_rows: rows,
    assignment_status: assignedPercent >= 99.999 ? "assigned" : assignedPercent > 0 ? "partial" : "unassigned",
    assignment_count: rows.length,
    assigned_job_names: assignedJobNames,
    assigned_total_percent: assignedPercent,
    remaining_percent: Math.max(0, 100 - assignedPercent),
    assignment_source: rows[0]?.assignment_source || null,
    assignment_confidence: rows[0]?.assignment_confidence || null,
  };
}

const targetMargin = 35;
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function normalizeJob(row = {}) {
  const basis = getJobRevenueBasisView(row);
  const revenue = basis.available ? Number(basis.amount || 0) : 0;
  const totalCost = Number(row.total_cost ?? row.cost ?? row.actual_cost ?? row.amount_cost ?? 0) || 0;
  const marginPercent = Number.isFinite(Number(row.margin_percent ?? row.margin_pct))
    ? Number(row.margin_percent ?? row.margin_pct)
    : revenue > 0
      ? ((revenue - totalCost) / revenue) * 100
      : null;
  return {
    id: row.local_job_id || row.job_id || row.id || row.external_id || row.job_name || row.name,
    local_job_id: row.local_job_id || row.job_id || row.id || null,
    external_id: row.external_id || null,
    jobName: row.name || row.job_name || row.project_name || row.customer_name || "Untitled Job",
    customerName: row.customer_name || row.client_name || row.customer || row.parent_customer_name || "Unknown customer",
    tradeType: row.trade_type || row.trade || row.service_type || row.category || "Unassigned",
    revenue,
    totalCost,
    marginPercent,
    status: row.status || row.stage || "active",
    archived_at: row.archived_at || null,
  };
}

function isArchivedUiJob(job = {}) {
  return Boolean(job?.archived_at) || String(job?.status || "").trim().toLowerCase() === "archived";
}

function filterActiveUiJobs(rows = [], excludedIds = new Set()) {
  const ids = excludedIds instanceof Set ? excludedIds : new Set();
  return (Array.isArray(rows) ? rows : []).filter((job) => {
    const localId = String(getLocalJobId(job) || "");
    return !isArchivedUiJob(job) && (!localId || !ids.has(localId));
  });
}

function getLocalJobId(job = {}) {
  if (!job) return "";
  return job.local_job_id || job.job_id || job.id || "";
}

function summarizeChangeOrders(changeOrders = []) {
  const approvedStatuses = new Set(["client_approved", "billed", "paid"]);
  const openStatuses = new Set(["proposed", "client_approved", "billed"]);
  return (changeOrders || []).reduce((acc, order) => {
    const status = String(order.status || "").toLowerCase();
    const proposedPrice = Number(order.proposed_price ?? order.additional_revenue ?? 0) || 0;
    const approvedRevenue = Number(order.approved_price ?? order.proposed_price ?? order.additional_revenue ?? 0) || 0;
    const billedAmount = Number(order.billed_amount || 0) || 0;
    const paidAmount = Number(order.paid_amount || 0) || 0;

    acc.change_order_count += 1;
    if (openStatuses.has(status)) acc.open_change_order_count += 1;
    if (status === "proposed") acc.proposed_change_order_value += proposedPrice;
    if (approvedStatuses.has(status)) {
      acc.approved_change_order_value += approvedRevenue;
      acc.change_order_approved_revenue += approvedRevenue;
      acc.change_order_cost_total += Number(order.estimated_cost ?? order.additional_cost ?? 0) || 0;
    }
    if (status === "billed" || status === "paid") acc.change_order_billed_total += billedAmount;
    if (status === "paid") acc.change_order_paid_total += paidAmount;
    return acc;
  }, {
    proposed_change_order_value: 0,
    approved_change_order_value: 0,
    change_order_approved_revenue: 0,
    change_order_billed_total: 0,
    change_order_paid_total: 0,
    change_order_cost_total: 0,
    change_order_count: 0,
    open_change_order_count: 0,
  });
}

function summarizeChangeOrderCards(job = {}) {
  const orders = Array.isArray(job.change_orders) ? job.change_orders : [];
  const local = summarizeChangeOrders(orders);
  const proposed = Number(job.proposed_change_order_value ?? job.change_order_proposed_total ?? local.proposed_change_order_value) || 0;
  const approved = Number(job.approved_change_order_value ?? job.change_order_approved_revenue ?? local.approved_change_order_value) || 0;
  const billed = Number(job.change_order_billed_total ?? local.change_order_billed_total) || 0;
  const paid = Number(job.change_order_paid_total ?? local.change_order_paid_total) || 0;
  return {
    proposed,
    approved,
    billed,
    paid,
    openValue: Math.max(0, proposed + approved - paid),
  };
}

function getChangeOrderStatusMeta(status = "proposed") {
  const key = String(status || "proposed").toLowerCase();
  const label = key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  const styles = {
    proposed: "border-amber-300/25 bg-amber-300/10 text-amber-100",
    client_approved: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
    billed: "border-cyan-300/25 bg-cyan-300/10 text-cyan-100",
    paid: "border-green-300/25 bg-green-300/10 text-green-100",
    rejected: "border-rose-300/20 bg-rose-300/10 text-rose-100",
    cancelled: "border-white/10 bg-white/[0.05] text-white/45",
  };
  return { label, className: styles[key] || "border-white/10 bg-white/[0.05] text-white/55" };
}

function getChangeOrderActionStatus(order = {}) {
  const status = String(order.status || "proposed");
  if (status === "proposed") return [{ label: "Mark Client Approved", status: "client_approved" }, { label: "Cancel", status: "cancelled" }];
  if (status === "client_approved") return [{ label: "Mark Billed", status: "billed" }, { label: "Cancel", status: "cancelled" }];
  if (status === "billed") return [{ label: "Mark Paid", status: "paid" }];
  return [];
}

function getChangeOrderTerminalHint(status = "") {
  const key = String(status || "").toLowerCase();
  if (key === "paid") return "Paid";
  if (key === "billed") return "Awaiting payment";
  if (key === "rejected") return "Rejected";
  if (key === "cancelled") return "Cancelled";
  return "No actions";
}

function getChangeOrderStatusPatch(order = {}, status) {
  const value = Number(order.approved_price ?? order.proposed_price ?? 0) || 0;
  const patch = { status };
  if (status === "client_approved") patch.approved_price = value;
  if (status === "billed") patch.billed_amount = Number(order.billed_amount ?? value) || 0;
  if (status === "paid") patch.paid_amount = Number(order.paid_amount ?? order.billed_amount ?? value) || 0;
  return patch;
}

function getOverviewChangeOrderAction(order = {}) {
  const status = String(order.status || "proposed");
  if (status === "proposed") return { label: "Approve", status: "client_approved" };
  if (status === "client_approved") return { label: "Mark Billed", status: "billed" };
  if (status === "billed") return { label: "Mark Paid", status: "paid" };
  return null;
}

function buildChangeOrderClientDraftPreview(job = {}, form = {}, recommendation = null) {
  const customer = job.customerName || job.customer_name || "there";
  const jobName = job.jobName || job.job_name || "this job";
  const description = String(form.description || "the additional work described").trim();
  const price = Number(form.proposed_price || recommendation?.recommended_price || 0);
  return `Hi ${customer}, we identified additional work outside the original scope for ${jobName}. The estimated cost for this change is ${money.format(price)}. This includes ${description}. Please reply with approval before we proceed.`;
}

function normalizeJobRecord(job = {}) {
  const normalized = normalizeJob(job);
  const changeOrders = Array.isArray(job.change_orders) ? job.change_orders : [];
  const baseRevenue = Number(job.base_revenue ?? normalized.revenue) || 0;
  const baseTotalCost = Number(job.base_total_cost ?? normalized.totalCost) || 0;
  const localChangeOrderSummary = summarizeChangeOrders(changeOrders);
  const changeOrderRevenue = Number(job.change_order_approved_revenue ?? job.approved_change_order_value ?? job.change_order_revenue ?? localChangeOrderSummary.change_order_approved_revenue) || 0;
  const changeOrderCost = Number(job.change_order_cost_total ?? job.change_order_cost ?? localChangeOrderSummary.change_order_cost_total) || 0;
  const proposedChangeOrderValue = Number(job.proposed_change_order_value ?? job.change_order_proposed_total ?? localChangeOrderSummary.proposed_change_order_value) || 0;
  const billedChangeOrderTotal = Number(job.change_order_billed_total ?? localChangeOrderSummary.change_order_billed_total) || 0;
  const paidChangeOrderTotal = Number(job.change_order_paid_total ?? localChangeOrderSummary.change_order_paid_total) || 0;
  return {
    ...job,
    id: normalized.id,
    jobName: normalized.jobName,
    job_name: normalized.jobName,
    customerName: normalized.customerName,
    customer_name: normalized.customerName,
    tradeType: normalized.tradeType,
    trade_type: normalized.tradeType,
    status: normalized.status,
    base_revenue: baseRevenue,
    base_total_cost: baseTotalCost,
    change_order_revenue: changeOrderRevenue,
    change_order_cost: changeOrderCost,
    change_order_approved_revenue: changeOrderRevenue,
    change_order_cost_total: changeOrderCost,
    proposed_change_order_value: proposedChangeOrderValue,
    approved_change_order_value: Number(job.approved_change_order_value ?? changeOrderRevenue) || 0,
    unbilled_change_order_value: Number(job.unbilled_change_order_value ?? Math.max(0, changeOrderRevenue - billedChangeOrderTotal)) || 0,
    unpaid_change_order_value: Number(job.unpaid_change_order_value ?? Math.max(0, billedChangeOrderTotal - paidChangeOrderTotal)) || 0,
    change_order_billed_total: billedChangeOrderTotal,
    change_order_paid_total: paidChangeOrderTotal,
    change_order_count: Number(job.change_order_count ?? localChangeOrderSummary.change_order_count) || 0,
    open_change_order_count: Number(job.open_change_order_count ?? localChangeOrderSummary.open_change_order_count) || 0,
    change_orders: changeOrders,
    revenue: baseRevenue + changeOrderRevenue,
    total_revenue: baseRevenue + changeOrderRevenue,
    total_cost: baseTotalCost + changeOrderCost,
    marginPercent: normalized.marginPercent,
    margin_percent: normalized.marginPercent,
  };
}

function buildJobRows(jobs, transactions) {
  const txnGroups = new Map();
  (transactions || []).forEach((txn) => {
    const assignmentRows = Array.isArray(txn.assignment_rows) && txn.assignment_rows.length ? txn.assignment_rows : [txn];
    assignmentRows.forEach((assignmentTxn) => {
      const key = assignmentTxn.job_id || assignmentTxn.job_label;
      if (!key) return;
      if (!txnGroups.has(String(key))) txnGroups.set(String(key), []);
      txnGroups.get(String(key)).push(assignmentTxn);
    });
  });

  const rows = (jobs || []).map((job) => {
    const base = normalizeJobRecord(job);
    const related = [
      ...(txnGroups.get(String(base.id)) || []),
      ...(txnGroups.get(String(base.jobName)) || []),
    ];
    const basis = getJobRevenueBasisView(job);
    const revenue = basis.available
      ? Number(basis.amount || 0) + Number(base.change_order_revenue || 0)
      : null;
    const totalCost = Number(base.total_cost ?? base.base_total_cost ?? 0);
    let marginPercent = null;
    if (Number(revenue) > 0) {
      marginPercent = ((revenue - totalCost) / revenue) * 100;
    }
    return {
      ...base,
      revenue: revenue ?? 0,
      total_cost: totalCost,
      margin_percent: marginPercent,
      gross_margin_dollars: (revenue ?? 0) - totalCost,
      transactions: related,
      assigned_transaction_count: Number(job.assigned_transaction_count ?? related.length) || 0,
      last_activity: related.map((txn) => txn.date).filter(Boolean).sort().at(-1) || base.updated_at || base.created_at || base.start_date || null,
    };
  });

  txnGroups.forEach((related, key) => {
    if (rows.some((row) => String(row.id) === key || row.jobName === key)) return;
    const totalCost = related.reduce((sum, txn) => sum + (Number(txn.amount) < 0 ? Math.abs(Number(txn.amount)) : 0), 0);
    rows.push({
      id: key,
      jobName: related[0]?.job_label || "Assigned job",
      job_name: related[0]?.job_label || "Assigned job",
      customerName: "Unknown customer",
      customer_name: "Unknown customer",
      tradeType: "Unassigned",
      trade_type: "Unassigned",
      revenue: 0,
      total_cost: totalCost,
      margin_percent: null,
      revenue_source_status: "summary_refreshing",
      status: "active",
      transactions: related,
      last_activity: related.map((txn) => txn.date).filter(Boolean).sort().at(-1) || null,
    });
  });

  return rows.sort((a, b) => Date.parse(b.last_activity || b.created_at || 0) - Date.parse(a.last_activity || a.created_at || 0));
}

function getJobDisplayName(job = {}) {
  return job.jobName || job.job_name || job.name || "Job";
}

function isSuggestedCandidateJob(job = {}) {
  const creationMethod = String(job.creation_method || job.creationMethod || "").toLowerCase();
  const sourceType = String(job.source_type || job.sourceType || "").toLowerCase();
  const sourceEntityType = String(job.source_entity_type || job.external_source_type || job.sourceEntityType || "").toLowerCase();
  return (
    creationMethod === "job_candidate" ||
    sourceType.includes("candidate") ||
    sourceType === "candidate_invoice" ||
    Boolean(job.job_candidate_id || job.candidate_id || job.source_candidate_id) ||
    (
      sourceEntityType &&
      (sourceEntityType.includes("invoice") || sourceEntityType.includes("estimate")) &&
      !sourceType.includes("qbo_project") &&
      !sourceType.includes("subcustomer") &&
      !sourceType.includes("manual")
    )
  );
}

function isManualBizziJob(job = {}) {
  if (job.can_delete_manual_job === true || job.can_delete_job === true || job.is_manual_job === true) return true;
  const creationMethod = String(job.creation_method || job.creationMethod || "").toLowerCase();
  const sourceType = String(job.source_type || job.sourceType || "").toLowerCase();
  const sourceEntityType = String(job.source_entity_type || job.external_source_type || job.sourceEntityType || "").toLowerCase();
  const hasCandidateEvidence = (
    creationMethod.includes("candidate") ||
    sourceType.includes("candidate") ||
    Boolean(job.job_candidate_id || job.candidate_id || job.source_candidate_id) ||
    (
      sourceEntityType &&
      (sourceEntityType.includes("invoice") || sourceEntityType.includes("estimate")) &&
      !sourceType.includes("manual")
    )
  );
  const hasQuickBooksEvidence = (
    sourceType.includes("qbo") ||
    sourceType.includes("quickbooks") ||
    sourceType.includes("project") ||
    sourceType.includes("subcustomer") ||
    Boolean(job.qbo_project_id || job.qbo_customer_id || job.qbo_subcustomer_id)
  );
  return (
    (creationMethod.includes("manual") || sourceType.includes("manual") || sourceType === "bizzi") &&
    !hasCandidateEvidence &&
    !hasQuickBooksEvidence
  );
}

function getOptimisticJobRevenue(job = {}) {
  const basis = getJobRevenueBasisView(job);
  if (basis.available && Number.isFinite(Number(basis.amount))) return Number(basis.amount);
  const fallback = Number(job.revenue ?? job.total_revenue ?? job.job_costing_revenue ?? job.selected_basis_amount ?? 0);
  return Number.isFinite(fallback) ? fallback : 0;
}

function getOptimisticAssignedAmount(transaction = {}, allocationPercent = 100) {
  const amount = Math.abs(Number(transaction.amount || 0));
  const percent = Number.isFinite(Number(allocationPercent)) ? Number(allocationPercent) : 100;
  return Math.round(amount * (Math.max(0, Math.min(100, percent)) / 100) * 100) / 100;
}

function withOptimisticAssignmentRows(transaction = {}, job = {}, allocationPercent = 100, assignmentId = "") {
  const currentRows = Array.isArray(transaction.assignment_rows) ? transaction.assignment_rows : [];
  const keptRows = currentRows.filter((row) => String(row.job_id) !== String(job.id));
  const allocatedAmount = getOptimisticAssignedAmount(transaction, allocationPercent);
  const signedAmount = Number(transaction.amount || 0) < 0 ? -allocatedAmount : allocatedAmount;
  const nextRow = {
    ...transaction,
    amount: signedAmount,
    job_id: job.id,
    job_label: getJobDisplayName(job),
    assignment_id: assignmentId,
    assignment_row_id: assignmentId,
    allocation_percent: allocationPercent,
    allocated_amount: allocatedAmount,
    assignment_source: "manual_drag_drop",
    assignment_confidence: 1,
  };
  const rows = [...keptRows, nextRow];
  const assignedTotalPercent = rows.reduce((sum, row) => sum + Number(row.allocation_percent || 0), 0);
  const assignedJobNames = Array.from(new Set(rows.map((row) => row.job_label).filter(Boolean)));
  return {
    ...transaction,
    job_id: job.id,
    assignment_id: assignmentId,
    assignment_ids: rows.map((row) => row.assignment_id).filter(Boolean),
    allocation_percent: allocationPercent,
    allocated_amount: allocatedAmount,
    job_label: assignedJobNames.length > 1 ? `Split across ${assignedJobNames.length} jobs` : getJobDisplayName(job),
    assigned_job_names: assignedJobNames,
    assigned_total_percent: assignedTotalPercent,
    remaining_percent: Math.max(0, 100 - assignedTotalPercent),
    assignment_status: assignedTotalPercent >= 99.999 ? "assigned" : "partial",
    assignment_count: rows.length,
    assignment_source: "manual_drag_drop",
    assignment_confidence: 1,
    assignment_rows: rows,
  };
}

function applyOptimisticJobAssignment(jobs = [], transaction = {}, job = {}, allocationPercent = 100) {
  const costDelta = getOptimisticAssignedAmount(transaction, allocationPercent);
  return jobs.map((item) => {
    if (String(item.id || item.job_id) !== String(job.id)) return item;
    const revenue = getOptimisticJobRevenue(item);
    const currentCost = Number(item.total_cost ?? item.total_assigned_cost ?? item.base_total_cost ?? 0) || 0;
    const totalCost = Math.round((currentCost + costDelta) * 100) / 100;
    const grossMargin = Math.round((revenue - totalCost) * 100) / 100;
    const marginPercent = revenue > 0 ? (grossMargin / revenue) * 100 : null;
    return {
      ...item,
      revenue,
      total_revenue: revenue,
      total_cost: totalCost,
      total_assigned_cost: totalCost,
      base_total_cost: totalCost,
      gross_margin: grossMargin,
      gross_margin_dollars: grossMargin,
      margin_percent: marginPercent,
      marginPercent: marginPercent,
      assigned_transaction_count: Number(item.assigned_transaction_count || 0) + 1,
      revenue_source_status: item.revenue_source_status || "canonical",
      revenue_summary: item.revenue_summary || { sourceStatus: item.revenue_source_status || "canonical" },
    };
  });
}

function statusClass(status = "") {
  const value = String(status).toLowerCase();
  if (value.includes("complete") || value.includes("won") || value.includes("paid")) return "border-emerald-300/25 bg-emerald-300/10 text-emerald-100";
  if (value.includes("hold") || value.includes("risk") || value.includes("below")) return "border-amber-300/25 bg-amber-300/10 text-amber-100";
  if (value.includes("lost") || value.includes("cancel")) return "border-rose-300/25 bg-rose-300/10 text-rose-100";
  return "border-white/12 bg-white/[0.06] text-white/75";
}

function isCompletedJobStatus(status = "") {
  return /complete|completed|closed|won|lost|cancel/i.test(String(status || ""));
}

function getTargetForJob(job, marginTargets = []) {
  const trade = String(job?.trade_type || "").toLowerCase();
  const match = marginTargets.find((target) => String(target.trade_type || "").toLowerCase() === trade);
  return Number(match?.target_margin_percent ?? targetMargin);
}

function guardrailStatus(margin, target) {
  const value = Number(margin);
  if (!Number.isFinite(value)) return { label: "Watch", text: "text-amber-100", badge: "border-amber-300/25 bg-amber-300/10 text-amber-100" };
  if (value >= target) return { label: "Healthy", text: "text-emerald-100", badge: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100" };
  if (value >= target - 5) return { label: "Watch", text: "text-amber-100", badge: "border-amber-300/25 bg-amber-300/10 text-amber-100" };
  return { label: "Below Target", text: "text-rose-100", badge: "border-rose-300/25 bg-rose-300/10 text-rose-100" };
}

function jobBucketStatus(job, target) {
  const assignedCount = Number(job?.assigned_transaction_count ?? (Array.isArray(job?.transactions) ? job.transactions.length : 0)) || 0;
  const revenue = Number(job?.revenue || 0);
  const totalCost = Number(job?.total_cost || job?.total_assigned_cost || job?.assigned_cost_total || 0);
  if (!hasCanonicalRevenueSummary(job) && isManualBizziJob(job)) {
    const emptyManualJob = assignedCount <= 0 && revenue === 0 && totalCost === 0;
    return {
      label: emptyManualJob ? "New" : "Revenue Needed",
      text: "text-white/70",
      badge: "border-white/12 bg-white/[0.06] text-white/60",
      card: "border-emerald-300/18 bg-emerald-300/[0.025]",
      cardHover: "hover:border-emerald-300/30 hover:bg-emerald-300/[0.045]",
      bar: "bg-emerald-300/55",
      glow: "",
      button: "border-emerald-300/20 bg-emerald-300/[0.06] text-emerald-50 hover:border-emerald-300/38 hover:bg-emerald-300/10",
    };
  }
  if (!hasCanonicalRevenueSummary(job)) {
    return {
      label: "Refreshing",
      text: "text-amber-100",
      badge: "border-amber-300/25 bg-amber-300/10 text-amber-100",
      card: "border-amber-300/18 bg-amber-300/[0.035]",
      cardHover: "hover:border-amber-300/30 hover:bg-amber-300/[0.06]",
      bar: "bg-amber-300",
      glow: "shadow-[0_0_18px_rgba(252,211,77,0.14)]",
      button: "border-amber-300/25 bg-amber-300/[0.07] text-amber-50 hover:border-amber-300/45 hover:bg-amber-300/12",
    };
  }
  const grossMargin = Number(job?.gross_margin ?? job?.gross_margin_dollars ?? (revenue - totalCost));
  const margin = Number(job?.margin_percent);
  if (assignedCount <= 0 && revenue === 0 && totalCost === 0) {
    return {
      label: "At Risk",
      text: "text-amber-100",
      badge: "border-amber-300/35 bg-amber-300/14 text-amber-100 shadow-[0_0_18px_rgba(251,191,36,0.10)]",
      card: "border-amber-300/26 bg-amber-300/[0.04]",
      cardHover: "hover:border-amber-300/40 hover:bg-amber-300/[0.075]",
      bar: "bg-amber-300",
      glow: "shadow-[0_0_18px_rgba(252,211,77,0.18)]",
      button: "border-amber-300/30 bg-amber-300/[0.08] text-amber-50 hover:border-amber-300/50 hover:bg-amber-300/14",
    };
  }
  if (grossMargin < 0 || (Number.isFinite(margin) && margin < target - 5)) {
    return {
      label: "Critical",
      text: "text-rose-100",
      badge: "border-rose-300/35 bg-rose-300/14 text-rose-100 shadow-[0_0_18px_rgba(244,63,94,0.12)]",
      card: "border-rose-300/28 bg-rose-300/[0.045]",
      cardHover: "hover:border-rose-300/45 hover:bg-rose-300/[0.085]",
      bar: "bg-rose-300",
      glow: "shadow-[0_0_18px_rgba(253,164,175,0.22)]",
      button: "border-rose-300/30 bg-rose-300/[0.08] text-rose-50 hover:border-rose-300/50 hover:bg-rose-300/14",
    };
  }
  if ((revenue === 0 && totalCost > 0) || !Number.isFinite(margin) || margin < target) {
    return {
      label: "At Risk",
      text: "text-amber-100",
      badge: "border-amber-300/35 bg-amber-300/14 text-amber-100 shadow-[0_0_18px_rgba(251,191,36,0.10)]",
      card: "border-amber-300/26 bg-amber-300/[0.04]",
      cardHover: "hover:border-amber-300/40 hover:bg-amber-300/[0.075]",
      bar: "bg-amber-300",
      glow: "shadow-[0_0_18px_rgba(252,211,77,0.18)]",
      button: "border-amber-300/30 bg-amber-300/[0.08] text-amber-50 hover:border-amber-300/50 hover:bg-amber-300/14",
    };
  }
  return {
    label: "Healthy",
    text: "text-emerald-100",
    badge: "border-emerald-300/35 bg-emerald-300/14 text-emerald-100 shadow-[0_0_18px_rgba(16,185,129,0.12)]",
    card: "border-emerald-300/22 bg-emerald-300/[0.035]",
    cardHover: "hover:border-emerald-300/35 hover:bg-emerald-300/[0.055]",
    bar: "bg-emerald-300",
    glow: "shadow-[0_0_18px_rgba(110,231,183,0.2)]",
    button: "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-50 hover:border-emerald-300/45 hover:bg-emerald-300/14",
  };
}

function getMarginTrend(job = {}) {
  const value = Number(job.margin_trend ?? job.margin_delta ?? job.margin_change_percent ?? job.margin_change);
  if (!Number.isFinite(value) || Math.abs(value) < 0.1) return { arrow: "→", label: "flat", value: 0, className: "text-white/40" };
  return value > 0
    ? { arrow: "↑", label: `up ${percent.format(Math.abs(value))}%`, value, className: "text-emerald-100" }
    : { arrow: "↓", label: `down ${percent.format(Math.abs(value))}%`, value, className: "text-rose-100" };
}

function isCostTransaction(txn) {
  return Number(txn?.amount || 0) < 0 || String(txn?.direction || "").toUpperCase() === "OUTFLOW";
}

function classifyCostCategory(txn = {}) {
  const text = `${txn.gl_account || ""} ${txn.category_primary || ""} ${txn.category_detailed || ""} ${txn.vendor || ""} ${getTransactionMemo(txn)}`.toLowerCase();
  if (/\blabor|payroll|wage|crew|subcontract|contractor\b/.test(text)) return "labor";
  if (/\bmaterial|supply|supplies|lumber|tile|paint|hardware|home depot|lowe|amazon\b/.test(text)) return "materials";
  if (/\boverhead|insurance|rent|utilities|admin|office\b/.test(text)) return "overhead";
  return "other";
}

function buildCostBreakdown(job) {
  const costs = (job?.transactions || []).filter(isCostTransaction);
  const totals = costs.reduce((acc, txn) => {
    const key = classifyCostCategory(txn);
    acc[key] += Math.abs(Number(txn.amount || 0));
    return acc;
  }, { labor: 0, materials: 0, overhead: 0, other: 0 });
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return [
    { key: "labor", label: "Labor", value: totals.labor, color: "bg-emerald-300" },
    { key: "materials", label: "Materials", value: totals.materials, color: "bg-cyan-300" },
    { key: "overhead", label: "Overhead", value: totals.overhead, color: "bg-amber-300" },
    { key: "other", label: "Other", value: totals.other, color: "bg-white/45" },
  ].map((item) => ({ ...item, percent: total > 0 ? (item.value / total) * 100 : 0 }));
}

function marginTone(margin, target = targetMargin) {
  if (!Number.isFinite(Number(margin))) return { text: "text-white", bg: "bg-white/[0.06]", border: "border-white/10", label: "No margin yet" };
  if (Number(margin) >= target) return { text: "text-emerald-100", bg: "bg-emerald-300/10", border: "border-emerald-300/25", label: "At or above target" };
  if (Number(margin) >= target - 5) return { text: "text-amber-100", bg: "bg-amber-300/10", border: "border-amber-300/25", label: "Near target" };
  return { text: "text-rose-100", bg: "bg-rose-300/10", border: "border-rose-300/25", label: "Below target" };
}

function buildJobRecommendations(job, unassignedCosts, target = targetMargin) {
  const revenue = Number(job?.revenue || 0);
  const cost = Number(job?.total_cost || 0);
  const margin = Number(job?.margin_percent);
  const recommendations = [];
  const startDate = Date.parse(job?.start_date || job?.scheduled_start || job?.created_at || "");
  const hasAddedMaterialCosts = (job?.transactions || []).some((txn) => {
    const txnDate = Date.parse(txn.date || txn.transaction_date || "");
    return isCostTransaction(txn) && classifyCostCategory(txn) === "materials" && (!Number.isFinite(startDate) || !Number.isFinite(txnDate) || txnDate >= startDate);
  });
  if (Number.isFinite(margin) && margin < target) {
    recommendations.push("This job is below target margin. Review material and labor costs.");
    if (hasAddedMaterialCosts) {
      recommendations.push("Potential change order opportunity detected. Review recent added material costs.");
    }
  }
  if ((unassignedCosts || []).length >= 3) {
    recommendations.push("Assign remaining transactions to improve job accuracy.");
  }
  if (revenue === 0 && cost > 0) {
    recommendations.push("Revenue may be missing for this job.");
  }
  if (!recommendations.length) {
    recommendations.push("This job is currently tracking within target.");
  }
  return recommendations;
}

function buildDemoAssignmentHistory(instruction, preview, assigned = 0) {
  return {
    id: `demo-assignment-history-${Date.now()}`,
    instruction_text: instruction,
    parsed_summary: preview?.parsed || {},
    target_jobs: (preview?.target_jobs || []).map((job) => ({ id: job.id, job_name: job.job_name })),
    matched_count: Number(preview?.matched_count || 0),
    total_amount: Number(preview?.total_amount || 0),
    assigned_count: Number(assigned || 0),
    transactions: (preview?.transactions || []).map((txn) => ({
      ...txn,
      memo: getTransactionMemo(txn) || txn.memo || txn.description || "",
    })),
    assignment_summary: {
      mode: preview?.parsed?.mode || "assign",
      warnings: preview?.warnings || [],
      allocations: preview?.allocations || [],
    },
    status: "confirmed",
    source: "natural_language",
    created_at: new Date().toISOString(),
  };
}

function buildDemoAssignmentPreview(instruction, jobs, transactions) {
  const clean = instruction.trim();
  if (!clean) throw new Error("Instruction required.");
  const lower = clean.toLowerCase();
  const vendor = ["home depot", "amazon", "uber", "lowe", "lowe's", "lowes", "tile house", "cedar supply"].find((item) => lower.includes(item)) || "";
  const splitMatches = Array.from(clean.matchAll(/(\d+(?:\.\d+)?)\s*%\s+to\s+(.+?)(?=\s+(?:and|,)\s+\d+(?:\.\d+)?\s*%\s+to\s+|$)/gi));
  const splitAllocations = splitMatches.map((match) => ({
    percent: Number(match[1]),
    jobText: match[2].replace(/\b(job|project)\b/gi, "").trim(),
  }));
  if (splitAllocations.length && Math.abs(splitAllocations.reduce((sum, item) => sum + item.percent, 0) - 100) > 0.01) {
    throw new Error("Split percentages must total 100%.");
  }
  const findJob = (text) => jobs.map(normalizeJobRecord).find((job) => `${job.jobName} ${job.customerName}`.toLowerCase().includes(text.toLowerCase()));
  let allocations = splitAllocations.map((item) => {
    const job = findJob(item.jobText);
    if (!job) throw new Error("No matching job found.");
    return { job_id: job.id, job_name: job.jobName, allocation_percent: item.percent };
  });
  if (!allocations.length && !lower.startsWith("show")) {
    const match = lower.match(/\b(?:to|for|on)\s+(?:the\s+)?(.+?)\s+(?:job|project)\b/);
    const job = match?.[1] ? findJob(match[1]) : null;
    if (!job) throw new Error("No matching job found.");
    allocations = [{ job_id: job.id, job_name: job.jobName, allocation_percent: 100 }];
  }
  const materialOnly = /\bmaterial|materials|supplies|purchases\b/.test(lower);
  const matched = transactions.filter((txn) => {
    const haystack = `${txn.vendor || ""} ${getTransactionMemo(txn)} ${txn.gl_account || ""}`.toLowerCase();
    const matchesVendor = !vendor || haystack.includes(vendor.replace("lowe's", "lowe"));
    const matchesMaterial = !materialOnly || /\bmaterial|supply|supplies|lumber|tile|hardware|home depot|amazon\b/.test(haystack);
    return isCostTransaction(txn) && matchesVendor && matchesMaterial;
  });
  if (!matched.length) throw new Error("No matching transactions found.");
  return {
    parsed: {
      instruction: clean,
      vendor: vendor || "any vendor",
      date_range: lower.includes("this month") ? "this month" : lower.includes("last week") ? "last week" : lower.includes("last 30 days") ? "last 30 days" : "all time",
      material_only: materialOnly,
      mode: lower.startsWith("show") ? "show" : allocations.length > 1 ? "split" : "assign",
    },
    target_jobs: allocations.map((item) => ({ id: item.job_id, job_name: item.job_name })),
    allocations,
    matched_count: matched.length,
    total_amount: matched.reduce((sum, txn) => sum + Math.abs(Number(txn.amount || 0)), 0),
    warnings: matched.some((txn) => txn.job_id || txn.job_label) ? ["Some matched transactions are already assigned and will be updated."] : [],
    transactions: matched.map((txn) => ({
      id: txn.id,
      date: txn.date,
      vendor: txn.vendor,
      description: getTransactionMemo(txn) || txn.description,
      memo: getTransactionMemo(txn) || txn.memo || "",
      category: txn.gl_account || "Uncategorized",
      amount: Number(txn.amount || 0),
      already_assigned: Boolean(txn.job_id || txn.job_label),
      allocations: allocations.map((allocation) => ({
        ...allocation,
        allocated_amount: Math.abs(Number(txn.amount || 0)) * (Number(allocation.allocation_percent || 0) / 100),
      })),
    })),
  };
}

function buildDemoSuggestions(jobs, transactions) {
  return transactions
    .filter((txn) => !txn.job_id && !txn.job_label && isCostTransaction(txn))
    .map((txn, idx) => {
      const bestJob = jobs.map(normalizeJobRecord).find((job) => /johnson/i.test(job.jobName || "")) || normalizeJobRecord(jobs[0]);
      if (!bestJob) return null;
      const vendor = `${txn.vendor || ""} ${getTransactionMemo(txn)}`.toLowerCase();
      const confidence = vendor.includes("amazon") || vendor.includes("home depot") ? 86 : 72;
      return {
        id: `demo-suggestion-${txn.id}-${bestJob.id}-${idx}`,
        transaction_id: txn.id,
        job_id: bestJob.id,
        confidence,
        reason: confidence >= 80 ? "Materials vendor and recent job activity match this job." : "Rule-based vendor/category match.",
        status: "pending",
        source: "rule_based",
        transaction: {
          id: txn.id,
          date: txn.date,
          vendor: txn.vendor,
          description: getTransactionMemo(txn) || txn.description,
          memo: getTransactionMemo(txn) || txn.memo || "",
          amount: txn.amount,
          category: txn.gl_account || "Uncategorized",
        },
        job: {
          id: bestJob.id,
          job_name: bestJob.jobName,
          customer_name: bestJob.customer_name,
          trade_type: bestJob.trade_type,
        },
      };
    })
    .filter(Boolean);
}

function getSuggestionTransaction(suggestion = {}) {
  return suggestion.transaction || {};
}

function getSuggestionJob(suggestion = {}) {
  return suggestion.suggested_job || suggestion.job || {};
}

function getSuggestionConfidence(suggestion = {}) {
  return Number(suggestion.confidence_score ?? suggestion.confidence ?? 0);
}

function getSuggestionReason(suggestion = {}) {
  return suggestion.reasoning_summary || suggestion.reasoning?.summary || suggestion.reason || "Rule-based match from transaction and job context.";
}

function getHistoryItemKey(item = {}) {
  const safeItem = item || {};
  return safeItem.id || `${safeItem.instruction_text || "assignment"}-${safeItem.created_at || ""}`;
}

function getHistoryTargets(item = {}) {
  if (!Array.isArray(item?.target_jobs)) return "";
  return item.target_jobs
    .map((job) => job.job_name || job.jobName || job.name)
    .filter(Boolean)
    .join(", ");
}

function getHistoryTransactions(item = {}) {
  if (Array.isArray(item?.transactions)) return item.transactions;
  if (Array.isArray(item?.assignment_summary?.transactions)) return item.assignment_summary.transactions;
  return [];
}

function NaturalLanguageAssignmentBar({
  assignmentRef,
  instruction,
  setInstruction,
  setAssignmentPreview,
  setAssignmentError,
  assignmentPreview,
  assignmentError,
  assignmentMessage,
  assignmentHistory,
  previewLoading,
  confirmingAssignment,
  listening,
  previewAssignment,
  confirmAssignment,
  cancelAssignment,
  startVoice,
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyItems = useMemo(() => (Array.isArray(assignmentHistory) ? assignmentHistory : []), [assignmentHistory]);
  const [selectedHistoryKey, setSelectedHistoryKey] = useState("");
  const selectedHistory = useMemo(
    () => historyItems.find((item) => getHistoryItemKey(item) === selectedHistoryKey) || historyItems[0] || null,
    [historyItems, selectedHistoryKey]
  );
  const selectedHistoryTransactions = getHistoryTransactions(selectedHistory);
  const selectedHistoryTargets = getHistoryTargets(selectedHistory);

  useEffect(() => {
    if (historyOpen && historyItems.length && !selectedHistoryKey) {
      setSelectedHistoryKey(getHistoryItemKey(historyItems[0]));
    }
  }, [historyItems, historyOpen, selectedHistoryKey]);

  useEffect(() => {
    if (!historyOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [historyOpen]);

  return (
    <section
      ref={assignmentRef}
      tabIndex={-1}
      className="rounded-[20px] border border-emerald-300/16 bg-emerald-300/[0.035] p-3 outline-none shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
      aria-label="Natural language transaction assignment"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/65">Transaction Assignment</p>
          <h2 className="mt-0.5 text-sm font-semibold text-white">Assign Books transactions by instruction</h2>
        </div>
        <div>
          <button
            type="button"
            onClick={() => setHistoryOpen((value) => !value)}
            className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-white/60 transition hover:border-emerald-300/25 hover:bg-emerald-300/[0.08] hover:text-emerald-50"
          >
            History {historyItems.length ? `(${historyItems.length})` : ""}
          </button>
          {typeof document !== "undefined" ? createPortal(
            <>
              <div
                className={`fixed inset-0 z-[110] bg-black/55 backdrop-blur-[2px] transition-opacity duration-200 ${
                  historyOpen ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
                onClick={() => setHistoryOpen(false)}
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Assignment history"
                className={`fixed left-1/2 top-1/2 z-[115] max-h-[72vh] w-[min(820px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[22px] border border-emerald-300/18 bg-[#121714] shadow-[0_30px_90px_rgba(0,0,0,0.65)] transition-all duration-200 ${
                  historyOpen ? "scale-100 opacity-100" : "pointer-events-none scale-[0.96] opacity-0"
                }`}
              >
                <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/65">Natural Language</p>
                    <h3 className="mt-1 text-base font-semibold text-white">Assignment History</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setHistoryOpen(false)}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/55 transition hover:bg-white/[0.08] hover:text-white"
                  >
                    Close
                  </button>
                </div>

                {historyItems.length ? (
                  <div className="grid max-h-[calc(72vh-73px)] grid-cols-1 overflow-hidden md:grid-cols-[0.95fr_1.35fr]">
                    <div className="custom-scrollbar overflow-y-auto border-b border-white/8 p-4 md:border-b-0 md:border-r">
                      <div className="space-y-2">
                        {historyItems.map((item) => {
                          const itemKey = getHistoryItemKey(item);
                          const active = itemKey === getHistoryItemKey(selectedHistory);
                          const targets = getHistoryTargets(item);
                          return (
                            <button
                              key={itemKey}
                              type="button"
                              onClick={() => setSelectedHistoryKey(itemKey)}
                              className={`w-full rounded-[15px] border px-3 py-2.5 text-left transition ${
                                active
                                  ? "border-emerald-300/30 bg-emerald-300/[0.09]"
                                  : "border-white/8 bg-black/18 hover:border-emerald-300/20 hover:bg-emerald-300/[0.045]"
                              }`}
                            >
                              <div className="line-clamp-2 text-xs font-semibold text-white/88">{item.instruction_text}</div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-white/42">
                                <span className="truncate">{targets || "No target job"}</span>
                                <span>{Number(item.assigned_count || item.matched_count || 0)} assigned</span>
                                <span>{formatDate(item.created_at)}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="custom-scrollbar overflow-y-auto p-4">
                      {selectedHistory ? (
                        <>
                          <div className="rounded-[17px] border border-white/8 bg-black/18 p-4">
                            <div className="text-xs font-semibold text-white/90">{selectedHistory.instruction_text}</div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-4">
                              <div className="rounded-[12px] bg-white/[0.035] p-2">
                                <div className="text-[10px] uppercase tracking-wide text-white/35">Jobs</div>
                                <div className="mt-1 truncate text-xs font-semibold text-white/75">{selectedHistoryTargets || "—"}</div>
                              </div>
                              <div className="rounded-[12px] bg-white/[0.035] p-2">
                                <div className="text-[10px] uppercase tracking-wide text-white/35">Assigned</div>
                                <div className="mt-1 text-xs font-semibold text-white/75">{Number(selectedHistory.assigned_count || 0)}</div>
                              </div>
                              <div className="rounded-[12px] bg-white/[0.035] p-2">
                                <div className="text-[10px] uppercase tracking-wide text-white/35">Amount</div>
                                <div className="mt-1 text-xs font-semibold text-white/75">{money.format(selectedHistory.total_amount || 0)}</div>
                              </div>
                              <div className="rounded-[12px] bg-white/[0.035] p-2">
                                <div className="text-[10px] uppercase tracking-wide text-white/35">When</div>
                                <div className="mt-1 text-xs font-semibold text-white/75">{formatDate(selectedHistory.created_at)}</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setInstruction(selectedHistory.instruction_text || "");
                                setAssignmentPreview(null);
                                setAssignmentError("");
                                setHistoryOpen(false);
                              }}
                              className="mt-3 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-semibold text-emerald-50 transition hover:bg-emerald-300/16"
                            >
                              Use query again
                            </button>
                          </div>

                          <div className="mt-4">
                            <div className="flex items-center justify-between gap-3">
                              <h4 className="text-sm font-semibold text-white">What This Assigned</h4>
                              <span className="text-xs text-white/40">{selectedHistoryTransactions.length} transactions</span>
                            </div>
                            {selectedHistoryTransactions.length ? (
                              <div className="mt-2 overflow-hidden rounded-[16px] border border-white/8">
                                {selectedHistoryTransactions.map((txn, index) => {
                                  const allocations = Array.isArray(txn.allocations) ? txn.allocations : [];
                                  const allocationText = allocations.length
                                    ? allocations.map((allocation) => `${allocation.job_name || "Job"} ${Number(allocation.allocation_percent || 0)}%`).join(" · ")
                                    : txn.job_name || txn.assigned_job_name || selectedHistoryTargets || "";
                                  const amount = Number(txn.allocated_amount ?? txn.amount ?? 0);
                                  return (
                                    <div key={txn.id || txn.transaction_id || index} className="grid gap-2 border-b border-white/6 px-3 py-2.5 text-xs last:border-b-0 md:grid-cols-[0.6fr_1fr_1.4fr_0.9fr_0.7fr]">
                                      <div className="text-white/45">{formatDate(txn.date)}</div>
                                      <div className="min-w-0 truncate font-semibold text-white/80">{txn.vendor || txn.payee || "Unknown payee"}</div>
                                      <div className="min-w-0 truncate text-white/50">{getTransactionMemo(txn) || "No memo stored"}</div>
                                      <div className="min-w-0 truncate text-emerald-100/75">{allocationText || "Assigned"}</div>
                                      <div className={`text-right font-semibold ${amount < 0 ? "text-rose-100" : "text-emerald-100"}`}>{money.format(amount)}</div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="mt-2 rounded-[16px] border border-white/8 bg-white/[0.035] px-4 py-5 text-sm text-white/50">
                                Transaction details were not stored for this history item. New confirmed assignments will include the assigned transactions and job allocations.
                              </div>
                            )}
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="p-5">
                    <div className="rounded-[16px] border border-white/8 bg-white/[0.035] px-4 py-6 text-sm text-white/50">
                      Confirmed natural language assignments will appear here.
                    </div>
                  </div>
                )}
              </div>
            </>,
            document.body
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex min-w-0 items-center rounded-full border border-white/10 bg-black/20 px-3 py-2 focus-within:border-emerald-300/45">
        <input
          id="job-costing-assignment-instruction"
          name="job_costing_assignment_instruction"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              previewAssignment();
            }
          }}
          placeholder="Assign Home Depot from this month to Smith job..."
          className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/35 outline-none"
        />
        <button
          type="button"
          onClick={startVoice}
          aria-label={listening ? "Listening for assignment instruction" : "Use voice input"}
          title={listening ? "Listening..." : "Use voice input"}
          className={`ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition ${
            listening
              ? "border-rose-300/45 bg-rose-300/12 text-rose-100"
              : "border-emerald-300/30 bg-white/[0.04] text-white/90 hover:bg-emerald-300/10 hover:text-emerald-100"
          }`}
        >
          <Mic size={16} />
        </button>
      </div>

      {assignmentMessage ? (
        <div className="mt-2 flex justify-end">
          <span className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1 text-[11px] font-semibold text-emerald-100">
            {assignmentMessage}
          </span>
        </div>
      ) : null}

      {previewLoading ? (
        <div className="mt-3 rounded-[14px] border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100">
          Preparing assignment confirmation...
        </div>
      ) : null}

      {assignmentError ? (
        <div className="mt-3 rounded-[14px] border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
          {assignmentError}
        </div>
      ) : null}

      {assignmentPreview ? (
        <div className="mt-3 rounded-[18px] border border-white/10 bg-black/20 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Confirm Assignment</h3>
              <p className="mt-1 text-xs text-white/50">
                {assignmentPreview.parsed?.mode === "split" ? "Split assignment" : assignmentPreview.parsed?.mode === "show" ? "Unassigned transaction search" : "Single-job assignment"} • {assignmentPreview.parsed?.vendor} • {assignmentPreview.parsed?.date_range}
              </p>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold text-white">{assignmentPreview.matched_count || 0}</div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">Matched</div>
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <div className="rounded-[14px] bg-white/[0.04] p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-white/40">Target job(s)</div>
              <div className="mt-1 truncate text-xs font-semibold text-white">
                {assignmentPreview.target_jobs?.length ? assignmentPreview.target_jobs.map((job) => job.job_name).join(", ") : "No target job"}
              </div>
            </div>
            <div className="rounded-[14px] bg-white/[0.04] p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-white/40">Total amount</div>
              <div className="mt-1 text-xs font-semibold text-white">{money.format(assignmentPreview.total_amount || 0)}</div>
            </div>
            <div className="rounded-[14px] bg-white/[0.04] p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-white/40">Instruction</div>
              <div className="mt-1 truncate text-xs text-white/70">{assignmentPreview.parsed?.instruction}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={cancelAssignment}
              className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-white/75 hover:bg-white/[0.1]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmAssignment}
              disabled={confirmingAssignment || assignmentPreview.parsed?.mode === "show"}
              className="rounded-full border border-emerald-300/35 bg-emerald-300/14 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/22 disabled:opacity-50"
            >
              {confirmingAssignment ? "Confirming..." : "Confirm assignment"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function getTransactionAccountName(txn = {}) {
  return txn.final_qbo_account_name || txn.gl_account || txn.glAccountName || txn.currentAccount || "Uncategorized";
}

function getTransactionMemo(txn = {}) {
  const raw = txn?.raw && typeof txn.raw === "object" ? txn.raw : {};
  const candidates = [
    txn?.description,
    txn?.bank_memo,
    txn?.memo,
    txn?.transaction_memo,
    txn?.plaid_memo,
    txn?.original_description,
    txn?.originalDescription,
    txn?.payment_channel_memo,
    raw.bank_memo,
    raw.memo,
    raw.original_description,
    raw.originalDescription,
    raw.name,
    txn?.name,
  ];
  const value = candidates.find((item) => String(item || "").trim());
  return value ? String(value).trim() : "";
}

function getTransactionVendorName(txn = {}) {
  return getPostedTransactionDisplayName(txn).displayName;
}

function normalizeGlAccountKey(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getGlAccountOptionName(account = {}) {
  return String(
    account.name ||
    account.account_name ||
    account.qbo_account_name ||
    account.final_qbo_account_name ||
    account.gl_account ||
    ""
  ).trim();
}

function getGlAccountOptionId(account = {}) {
  return String(
    account.id ||
    account.account_id ||
    account.qbo_account_id ||
    account.final_qbo_account_id ||
    ""
  ).trim();
}

function isRevenueOrExpenseGlAccount(account = {}) {
  const type = String(account.type || account.account_type || account.AccountType || "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  const subType = String(account.subType || account.account_subtype || account.AccountSubType || "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  return [
    "income",
    "revenue",
    "otherincome",
    "expense",
    "otherexpense",
    "costofgoodssold",
    "cogs",
  ].includes(type) || subType.includes("income") || subType.includes("expense") || subType.includes("cogs");
}

function getTransactionGlFilterValues(txn = {}) {
  const values = new Set();
  [
    txn.final_qbo_account_id,
    txn.qbo_account_id,
    txn.gl_account_id,
    txn.account_id,
    txn.raw?.final_qbo_account_id,
    txn.raw?.qbo_account_id,
  ].forEach((id) => {
    const normalized = String(id || "").trim();
    if (normalized) values.add(`id:${normalized}`);
  });
  [
    getTransactionAccountName(txn),
    txn.final_qbo_account_name,
    txn.qbo_account_name,
    txn.gl_account,
    txn.account_name,
    txn.raw?.final_qbo_account_name,
    txn.raw?.gl_account,
  ].forEach((name) => {
    const normalized = normalizeGlAccountKey(name);
    if (normalized) values.add(`name:${normalized}`);
  });
  return values;
}

function DarkFilterSelect({ value, onChange, options, ariaLabel, className = "", compact = false, menuClassName = "" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className={`relative ${open ? "z-[120]" : "z-0"} ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex w-full items-center justify-between gap-3 rounded-[14px] border border-white/10 bg-[#07100c] px-3 text-left font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] outline-none transition hover:border-emerald-300/25 hover:bg-[#0b1510] focus:border-emerald-300/45 ${
          compact ? "h-9 text-xs" : "py-2.5 text-sm"
        }`}
      >
        <span className="truncate">{selected?.label || ""}</span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-white/45 transition ${open ? "rotate-90 text-emerald-200/75" : ""}`} />
      </button>
      {open ? (
        <div className={`custom-scrollbar absolute left-0 right-0 top-[calc(100%+6px)] z-[120] max-h-[220px] overflow-y-auto overscroll-contain rounded-[14px] border border-emerald-300/20 bg-[#07100c] p-1 shadow-[0_22px_56px_rgba(0,0,0,0.92)] ring-1 ring-black/70 ${menuClassName}`}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-sm transition ${
                  active
                    ? "bg-emerald-300/12 text-emerald-100"
                    : "text-white/72 hover:bg-white/[0.06] hover:text-white"
                }`}
              >
                <span className="truncate">{option.label}</span>
                {active ? <span className="ml-2 h-1.5 w-1.5 rounded-full bg-emerald-300" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PostedTransactionRow({
  txn,
  dragging,
  expanded,
  suggestion,
  suggestionBusy,
  onToggleExpanded,
  onDragStart,
  onDragEnd,
  onAssignClick,
  onAcceptSuggestion,
  onRejectSuggestion,
  assigning,
}) {
  const assignedTotalPercent = Number(txn.assigned_total_percent || 0);
  const remainingPercent = Number(txn.remaining_percent ?? Math.max(0, 100 - assignedTotalPercent));
  const isAssigned =
    txn.assignment_status === "assigned" ||
    txn.assignment_status === "partial" ||
    assignedTotalPercent > 0 ||
    Boolean(txn.job_id || txn.job_label);
  const isPartiallyAssigned = assignedTotalPercent > 0 && assignedTotalPercent < 99.999 && remainingPercent > 0.001;
  const isFullyAssigned = assignedTotalPercent >= 99.999 || remainingPercent <= 0.001;
  const amount = Number(txn.amount || 0);
  const assignmentLabel = txn.assignment_count > 1
    ? `Split across ${txn.assignment_count} jobs`
    : txn.assigned_job_names?.length
      ? `Assigned to ${txn.assigned_job_names[0]}`
      : txn.job_label
        ? `Assigned to ${txn.job_label}`
        : "Assigned";
  const allocationLabel = isAssigned
    ? isPartiallyAssigned
      ? `Partially assigned ${Math.round(assignedTotalPercent)}% · ${Math.round(remainingPercent)}% remaining`
      : "Fully assigned"
    : "Unassigned";
  const actionLabel = isFullyAssigned ? "View" : isPartiallyAssigned ? "Assign remaining" : "Assign";
  const suggestionConfidence = suggestion ? getSuggestionConfidence(suggestion) : 0;
  const showSuggestion = suggestion && !isFullyAssigned;
  const transactionMemo = getTransactionMemo(txn);
  const roleMeta = getTransactionRoleMeta(txn);
  const payeeDisplay = getPostedTransactionDisplayName(txn);
  return (
    <div
      draggable={!isFullyAssigned}
      onClick={() => onToggleExpanded?.(txn.id)}
      onDragStart={(event) => {
        if (isFullyAssigned) {
          event.preventDefault();
          return;
        }
        onDragStart(event, txn);
      }}
      onDragEnd={onDragEnd}
      title={isFullyAssigned ? "This transaction is already fully allocated." : "Drag this posted transaction to a job bucket."}
      aria-expanded={expanded}
      className={`grid w-full min-w-[720px] grid-cols-[20px_50px_142px_118px_58px_158px_126px] items-center gap-1.5 border-b border-white/6 px-2 py-1 text-[12px] transition last:border-b-0 hover:bg-emerald-300/[0.045] ${
        dragging ? "bg-emerald-300/[0.06] opacity-70" : ""
      } ${
        isFullyAssigned ? "cursor-default opacity-75" : "cursor-grab active:cursor-grabbing"
      }`}
    >
      <div className="flex items-center justify-center">
        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-[5px] border text-[8px] ${
          isFullyAssigned ? "border-white/10 bg-white/[0.035] text-white/25" : "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
        }`}>
          <ChevronDown className={`h-2.5 w-2.5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
        </span>
      </div>
      <div className="text-white/55">{formatDate(txn.date)}</div>
      <div className="min-w-0">
        <div className="truncate font-semibold text-white/85">{payeeDisplay.displayName}</div>
        <div className="mt-0.5 flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.08em] text-white/35">
          <span className={`rounded-full border px-1.5 py-px normal-case tracking-normal ${compactBadgeClass(roleMeta.tone)}`}>
            {roleMeta.label}
          </span>
          <span className={payeeDisplay.payee_is_verified ? "text-emerald-100/70" : "text-white/35"}>{payeeDisplay.sourceLabel}</span>
          <span>{roleMeta.source}</span>
        </div>
      </div>
      <div className="min-w-0">
        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-300/[0.08] px-1.5 py-px text-[9px] font-semibold leading-5 text-emerald-100">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300" />
          <span className="truncate">{getTransactionAccountName(txn)}</span>
        </span>
      </div>
      <div className={`text-right font-semibold ${amount < 0 ? "text-rose-100" : "text-emerald-100"}`}>
        {moneyCents.format(amount)}
      </div>
      <div className="flex min-w-0 items-center gap-1 pl-2">
        {isAssigned ? (
          <span className="inline-flex max-w-full rounded-full border border-amber-300/20 bg-amber-300/10 px-1.5 py-px text-[9px] font-semibold leading-5 text-amber-100">
            <span className="truncate">{assignmentLabel}</span>
          </span>
        ) : (
          <span className="inline-flex rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-px text-[9px] font-semibold leading-5 text-white/55">
            Unassigned
          </span>
        )}
        {showSuggestion ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAcceptSuggestion?.(suggestion);
            }}
            disabled={suggestionBusy}
            title={getSuggestionReason(suggestion)}
            className="group inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-300/[0.075] px-1.5 py-px text-[9px] font-semibold leading-5 text-emerald-100 transition hover:border-emerald-300/35 hover:bg-emerald-300/12 disabled:opacity-60"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300" />
            <span className="truncate">AI {Math.round(suggestionConfidence)}%</span>
          </button>
        ) : null}
        {isAssigned ? <span className="truncate text-[9px] leading-4 text-white/38">{allocationLabel}</span> : null}
      </div>
      <div className="min-w-0">
        <div className="inline-flex w-full translate-x-8 items-center justify-end gap-1">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              return showSuggestion ? onAcceptSuggestion?.(suggestion) : onAssignClick(txn);
            }}
            disabled={assigning || suggestionBusy}
            className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-2 py-0.5 text-[9px] font-semibold leading-5 text-emerald-50 hover:bg-emerald-300/18 disabled:opacity-55"
          >
            {assigning || suggestionBusy ? "Working..." : showSuggestion ? "Confirm" : actionLabel}
          </button>
          {showSuggestion ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRejectSuggestion?.(suggestion);
              }}
              disabled={suggestionBusy}
              className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold leading-5 text-white/45 hover:bg-white/[0.08] hover:text-white/70 disabled:opacity-50"
            >
              Ignore
            </button>
          ) : null}
        </div>
      </div>
      <div className="col-span-7 flex flex-wrap gap-2 pt-1 sm:hidden">
        <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-100">Posted</span>
        {isAssigned ? (
          <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-[11px] font-semibold text-amber-100">
            {assignmentLabel}
          </span>
        ) : null}
        <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-semibold text-white/55">
          {allocationLabel}
        </span>
      </div>
      <div className={`col-span-7 overflow-hidden transition-all duration-200 ease-out ${
        expanded ? "max-h-16 opacity-100" : "max-h-0 opacity-0"
      }`}>
        <div className="mt-1 rounded-[10px] border border-white/8 bg-black/20 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-white/35">Bank memo</div>
            <div className="truncate text-[10px] font-semibold text-emerald-100/75">{roleMeta.effect}</div>
          </div>
          <div className="mt-0.5 truncate text-[12px] leading-5 text-white/62">{transactionMemo || "No memo available"}</div>
        </div>
      </div>
    </div>
  );
}

function JobBucketCard({
  job,
  marginTargets,
  isDragOver,
  draggedTransaction,
  onDragOver,
  onDragLeave,
  onDrop,
  onViewAssigned,
  onOpenRevenueDetail,
  onRetrySummary,
  onMarkComplete,
  onReopenJob,
  onRevertCandidateJob,
  onDeleteJob,
  markingComplete = false,
  revertingCandidateJob = false,
  deletingJob = false,
  allowDrop = true,
  completed = false,
}) {
  const target = getTargetForJob(job, marginTargets);
  const basis = getJobRevenueBasisView(job);
  const sourceBadge = getJobSourceBadge(job);
  const reviewWarning = getJobReviewWarning(job);
  const revenueAvailable = basis.available;
  const revenue = revenueAvailable ? Number(basis.amount || 0) : 0;
  const totalCost = Number(job.total_assigned_cost ?? job.assigned_cost_total ?? job.total_cost ?? 0);
  const marginValue = Number(job.margin_percent);
  const displayTone = jobBucketStatus(job, target);
  const manualWithoutRevenue = isManualBizziJob(job) && !hasCanonicalRevenueSummary(job);
  const revenueUnavailableLabel = manualWithoutRevenue ? "No revenue source yet" : basis.refreshingLabel;
  const revenueActionLabel = manualWithoutRevenue ? "Detail" : basis.retryLabel;
  const trend = getMarginTrend(job);
  const marginBar = Number.isFinite(marginValue) ? Math.max(0, Math.min(100, marginValue)) : 0;
  const assignedCount = getJobDocumentCount(job) || job.assigned_transaction_count || job.transactions?.length || 0;
  const assignedTransactionCount = Number(job.assigned_transaction_count ?? (Array.isArray(job.transactions) ? job.transactions.length : 0)) || 0;
  const canShowRevertCandidateJob = !completed && onRevertCandidateJob && isSuggestedCandidateJob(job) && assignedTransactionCount <= 0;
  const canDeleteManualJob = !completed && onDeleteJob && isManualBizziJob(job);
  const openChangeOrderCount = Number(job.open_change_order_count || 0);
  const approvedChangeOrderValue = Number(job.approved_change_order_value ?? job.change_order_approved_revenue ?? job.change_order_revenue ?? 0) || 0;
  const completedDate = job.completed_at || job.completedAt || job.end_date || job.endDate || null;
  const criticalTone = displayTone.label === "Critical";
  const dragOverClass = criticalTone
    ? "scale-[1.01] border-rose-300/70 bg-rose-300/[0.13] shadow-[0_0_0_1px_rgba(244,63,94,0.26),0_20px_42px_rgba(244,63,94,0.14)]"
    : "scale-[1.01] border-emerald-300/70 bg-emerald-300/[0.13] shadow-[0_0_0_1px_rgba(var(--accent-rgb),0.35),0_20px_42px_rgba(16,185,129,0.16)]";
  const dropPreviewClass = criticalTone
    ? "border-rose-300/30 text-rose-50"
    : "border-emerald-300/30 text-emerald-50";
  return (
    <article
      onDragOver={allowDrop ? (event) => onDragOver(event, job) : undefined}
      onDragLeave={allowDrop ? onDragLeave : undefined}
      onDrop={allowDrop ? (event) => onDrop(event, job) : undefined}
      className={`relative min-w-[230px] overflow-hidden rounded-xl border px-3 py-2.5 text-left shadow-[0_14px_30px_rgba(0,0,0,0.22)] transition-all duration-300 ease-out ${
        revertingCandidateJob ? "scale-[0.98] opacity-55" : "scale-100 opacity-100"
      } ${
        isDragOver
          ? dragOverClass
          : `${displayTone.card} ${displayTone.cardHover} hover:shadow-[0_20px_48px_rgba(0,0,0,0.32)]`
      }`}
    >
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-0.5 ${displayTone.bar} opacity-80`} />
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-5 text-white">{job.jobName}</div>
          <div className="mt-0.5 truncate text-xs text-white/50">{job.customerName}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${displayTone.badge}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${displayTone.bar}`} />
            {displayTone.label}
          </span>
          <span className={`inline-flex max-w-[112px] items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold ${compactBadgeClass(sourceBadge.tone)}`}>
            <span className="truncate">{sourceBadge.label}</span>
          </span>
        </div>
      </div>
      <div className="mt-2 border-y border-white/8 py-1.5">
        <div className="grid grid-cols-[1.1fr_0.72fr_0.72fr_auto] items-end gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-white/35">Margin</div>
            <div className={`mt-0.5 text-[24px] font-black leading-none tracking-tight ${displayTone.text} ${displayTone.glow}`}>
              {revenueAvailable && Number.isFinite(marginValue) ? `${percent.format(marginValue)}%` : "--"}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-white/35">{basis.shortLabel}</div>
            <div className="mt-0.5 truncate text-xs font-semibold text-white">{revenueAvailable ? money.format(revenue) : basis.unavailableLabel}</div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-white/35">Cost</div>
            <div className="mt-0.5 truncate text-xs font-semibold text-white">{money.format(totalCost)}</div>
          </div>
          <div className={`flex items-center gap-1 text-xs font-semibold ${trend.className}`} title={`Margin trend ${trend.label}`}>
            <span className="text-base leading-none">{trend.arrow}</span>
            {trend.value ? <span>{percent.format(Math.abs(trend.value))}%</span> : null}
          </div>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.07]" aria-label="Margin progress">
          <div
            className={`h-full rounded-full ${displayTone.bar} transition-all duration-500`}
            style={{ width: `${revenueAvailable ? marginBar : 100}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="truncate text-[9px] font-medium text-white/36">{revenueAvailable ? `Margin based on ${basis.label.toLowerCase()}` : revenueUnavailableLabel}</div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (revenueAvailable) onOpenRevenueDetail?.(job);
              else onRetrySummary?.();
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.035] px-1.5 py-0.5 text-[9px] font-semibold text-white/48 transition hover:border-emerald-300/25 hover:bg-emerald-300/[0.08] hover:text-emerald-50"
          >
            <PanelRightOpen className="h-2.5 w-2.5" />
            {revenueAvailable ? "Detail" : revenueActionLabel}
          </button>
        </div>
      </div>
      {reviewWarning ? (
        <div className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold text-amber-100">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span className="truncate">{reviewWarning}</span>
        </div>
      ) : null}
      {(openChangeOrderCount > 0 || approvedChangeOrderValue > 0) ? (
        <div className="mt-1.5 flex items-center justify-between gap-3 border-b border-white/8 pb-1.5 text-[10px] uppercase tracking-wide text-white/35">
          <span>Open COs {openChangeOrderCount}</span>
          <span className="text-emerald-100">{money.format(approvedChangeOrderValue)}</span>
        </div>
      ) : null}
      {completed ? (
        <div className="mt-1.5 flex items-center justify-between gap-3 border-b border-white/8 pb-1.5 text-[10px] uppercase tracking-wide text-white/35">
          <span>Completed Date</span>
          <span className="font-semibold normal-case tracking-normal text-white/65">{formatDate(completedDate)}</span>
        </div>
      ) : null}
      {isDragOver && draggedTransaction ? (
        <div className={`mt-2 rounded-[12px] border bg-black/25 px-3 py-2 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ${dropPreviewClass}`}>
          <div className="truncate font-semibold">{draggedTransaction.vendor || "Transaction"}</div>
          <div className="mt-0.5 flex items-center justify-between gap-3 text-white/55">
            <span className="truncate">{getTransactionMemo(draggedTransaction) || "Drop to assign"}</span>
            <span className="shrink-0 font-semibold text-emerald-100">{money.format(Number(draggedTransaction.amount || 0))}</span>
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-start gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onViewAssigned(job);
          }}
          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${displayTone.button}`}
        >
          View {assignedCount} Source{assignedCount === 1 ? "" : "s"}
        </button>
        {canShowRevertCandidateJob ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRevertCandidateJob(job);
            }}
            disabled={revertingCandidateJob}
            title={isSuggestedCandidateJob(job)
              ? "Move this unassigned job back to Suggested Jobs."
              : "Move this unassigned job back to Suggested Jobs if it came from a suggestion."}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-white/60 transition hover:border-amber-300/25 hover:bg-amber-300/[0.08] hover:text-amber-50 disabled:opacity-50"
          >
            <RefreshCcw className="h-3 w-3" />
            {revertingCandidateJob ? "Moving..." : "Back to Suggested"}
          </button>
        ) : null}
        {canDeleteManualJob ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteJob(job);
            }}
            disabled={deletingJob}
            title="Delete this manually created job."
            className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/20 bg-rose-300/[0.07] px-2.5 py-1 text-[11px] font-semibold text-rose-50 transition hover:border-rose-300/40 hover:bg-rose-300/[0.12] disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            {deletingJob ? "Deleting..." : "Delete"}
          </button>
        ) : null}
        {onMarkComplete && !completed ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onMarkComplete(job);
            }}
            disabled={markingComplete}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-white/60 transition hover:border-emerald-300/25 hover:bg-emerald-300/[0.08] hover:text-emerald-50 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3 w-3" />
            {markingComplete ? "Moving..." : "Mark Complete"}
          </button>
        ) : null}
        {onReopenJob && completed ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onReopenJob(job);
            }}
            disabled={markingComplete}
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/22 bg-emerald-300/[0.07] px-2.5 py-1 text-[11px] font-semibold text-emerald-50 transition hover:border-emerald-300/45 hover:bg-emerald-300/14 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3 w-3" />
            {markingComplete ? "Moving..." : "Move to Live"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ChangeOrderOverview({ changeOrders = [], loading = false, onStatusChange }) {
  const [showAll, setShowAll] = useState(false);
  const [busyId, setBusyId] = useState("");
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const openStatuses = new Set(["proposed", "client_approved", "billed"]);
  const paidThisMonth = changeOrders.reduce((sum, order) => {
    if (String(order.status || "") !== "paid") return sum;
    const paidAt = new Date(order.paid_at || order.updated_at || order.created_at || 0);
    if (Number.isNaN(paidAt.getTime()) || paidAt < monthStart) return sum;
    return sum + (Number(order.paid_amount ?? order.billed_amount ?? order.approved_price ?? order.proposed_price ?? 0) || 0);
  }, 0);
  const proposedValue = changeOrders.reduce((sum, order) => (
    String(order.status || "") === "proposed" ? sum + (Number(order.proposed_price || 0) || 0) : sum
  ), 0);
  const approvedNotBilled = changeOrders.reduce((sum, order) => {
    if (String(order.status || "") !== "client_approved") return sum;
    const approved = Number(order.approved_price ?? order.proposed_price ?? 0) || 0;
    return sum + Math.max(0, approved - (Number(order.billed_amount || 0) || 0));
  }, 0);
  const billedNotPaid = changeOrders.reduce((sum, order) => {
    if (String(order.status || "") !== "billed") return sum;
    return sum + Math.max(0, (Number(order.billed_amount ?? order.approved_price ?? order.proposed_price ?? 0) || 0) - (Number(order.paid_amount || 0) || 0));
  }, 0);
  const openOrders = changeOrders
    .filter((order) => openStatuses.has(String(order.status || "")))
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  const visibleOrders = showAll ? openOrders : openOrders.slice(0, 5);
  const handleAction = async (order, action) => {
    if (!action) return;
    setBusyId(`${order.id}:${action.status}`);
    try {
      await onStatusChange?.(order, getChangeOrderStatusPatch(order, action.status));
    } finally {
      setBusyId("");
    }
  };

  return (
    <section className="mt-4 rounded-[20px] border border-white/10 bg-black/15 p-3 sm:p-4" aria-label="Change order overview">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Change Orders</h2>
          <p className="mt-1 text-sm text-white/50">Track extra work before it gets forgotten.</p>
        </div>
        {openOrders.length > 5 ? (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-white/65 hover:border-emerald-300/25 hover:bg-emerald-300/10 hover:text-emerald-50"
          >
            {showAll ? "Show top 5" : "View all"}
          </button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        {[
          ["Proposed Value", proposedValue],
          ["Approved Not Billed", approvedNotBilled],
          ["Billed Not Paid", billedNotPaid],
          ["Paid This Month", paidThisMonth],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[16px] border border-white/10 bg-white/[0.04] p-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">{label}</div>
            <div className="mt-1 text-base font-semibold text-white">{money.format(value)}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 overflow-hidden rounded-[16px] border border-white/8 bg-black/15">
        {loading ? (
          <div className="p-3"><SkeletonCard lines={3} /></div>
        ) : visibleOrders.length ? (
          <div className="divide-y divide-white/6">
            {visibleOrders.map((order) => {
              const statusMeta = getChangeOrderStatusMeta(order.status);
              const action = getOverviewChangeOrderAction(order);
              const amount = Number(order.approved_price ?? order.proposed_price ?? 0) || 0;
              return (
                <div key={order.id} className="grid gap-2 p-3 text-sm md:grid-cols-[1.1fr_1.35fr_0.85fr_0.85fr_0.75fr_auto] md:items-center">
                  <div className="min-w-0 truncate font-semibold text-white/85">{order.job_name || "Job"}</div>
                  <div className="min-w-0 truncate text-white/65">{order.title || "Untitled change order"}</div>
                  <div>
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusMeta.className}`}>
                      {statusMeta.label}
                    </span>
                  </div>
                  <div className="font-semibold text-emerald-100 md:text-right">{money.format(amount)}</div>
                  <div className="text-white/45 md:text-right">{formatDate(order.created_at)}</div>
                  <div className="md:text-right">
                    {action ? (
                      <button
                        type="button"
                        onClick={() => handleAction(order, action)}
                        disabled={busyId === `${order.id}:${action.status}`}
                        className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/18 disabled:opacity-50"
                      >
                        {busyId === `${order.id}:${action.status}` ? "Saving..." : action.label}
                      </button>
                    ) : (
                      <span className="text-xs text-white/35">No action</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-5 text-sm text-white/50">No open change orders.</div>
        )}
      </div>
    </section>
  );
}

function getChangeOrderReminderAmount(order = {}, type) {
  if (type === "approval") return Number(order.proposed_price || 0) || 0;
  if (type === "billing") {
    const approved = Number(order.approved_price ?? order.proposed_price ?? 0) || 0;
    return Math.max(0, approved - (Number(order.billed_amount || 0) || 0));
  }
  if (type === "payment") {
    const billed = Number(order.billed_amount ?? order.approved_price ?? order.proposed_price ?? 0) || 0;
    return Math.max(0, billed - (Number(order.paid_amount || 0) || 0));
  }
  return 0;
}

function buildChangeOrderFollowUpText(order = {}, type = "approval") {
  const draft = String(order.draft_client_message || "").trim();
  if (draft) return draft;
  const jobName = order.job_name || order.jobName || "the job";
  if (type === "billing") {
    return `Hi, just following up on the approved change order for ${jobName}. We will get this billed so everything stays on track.`;
  }
  if (type === "payment") {
    return `Hi, just following up on the billed change order for ${jobName}. Please let us know if you need anything else to process payment.`;
  }
  return `Hi, just following up on the change order for ${jobName}. Please confirm approval so we can proceed.`;
}

function ChangeOrderFollowUpCard({ changeOrders = [], jobs = [], onViewJob }) {
  const [copiedKey, setCopiedKey] = useState("");
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const jobsById = useMemo(() => new Map((jobs || []).map((job) => [String(job.id), job])), [jobs]);
  const proposedOlderThanSeven = changeOrders.filter((order) => {
    if (String(order.status || "") !== "proposed") return false;
    const createdAt = order.created_at ? Date.parse(order.created_at) : NaN;
    return Number.isFinite(createdAt) && createdAt <= sevenDaysAgo;
  });
  const approvedNotBilled = changeOrders.filter((order) => String(order.status || "") === "client_approved" && getChangeOrderReminderAmount(order, "billing") > 0);
  const billedNotPaid = changeOrders.filter((order) => String(order.status || "") === "billed" && getChangeOrderReminderAmount(order, "payment") > 0);

  const reminders = [
    {
      key: "approval",
      type: "approval",
      orders: proposedOlderThanSeven,
      message: (count, value) => `${count} proposed change order${count === 1 ? "" : "s"} worth ${money.format(value)} need client approval.`,
    },
    {
      key: "billing",
      type: "billing",
      orders: approvedNotBilled,
      message: (count, value) => `${count} approved change order${count === 1 ? "" : "s"} worth ${money.format(value)} ${count === 1 ? "has" : "have"} not been billed.`,
    },
    {
      key: "payment",
      type: "payment",
      orders: billedNotPaid,
      message: (count, value) => `${count} billed change order${count === 1 ? "" : "s"} worth ${money.format(value)} ${count === 1 ? "has" : "have"} not been paid.`,
    },
  ].map((reminder) => {
    const value = reminder.orders.reduce((sum, order) => sum + getChangeOrderReminderAmount(order, reminder.type), 0);
    return { ...reminder, value, count: reminder.orders.length, firstOrder: reminder.orders[0] || null };
  }).filter((reminder) => reminder.count > 0);

  const copyReminder = async (reminder) => {
    const text = buildChangeOrderFollowUpText(reminder.firstOrder, reminder.type);
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedKey(reminder.key);
      window.setTimeout(() => setCopiedKey(""), 1600);
    } catch {
      setCopiedKey("");
    }
  };

  const viewReminder = (reminder) => {
    const job = jobsById.get(String(reminder.firstOrder?.job_id));
    if (job) onViewJob?.(job);
  };

  return (
    <section className="mt-4 rounded-[20px] border border-emerald-300/15 bg-emerald-300/[0.045] p-3 sm:p-4" aria-label="Change order follow-ups">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Change Order Follow-Ups</h2>
          <p className="mt-1 text-sm text-white/50">Surface money that needs action.</p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs text-white/55">
          {reminders.reduce((sum, reminder) => sum + reminder.count, 0)} open
        </span>
      </div>

      <div className="mt-3 overflow-hidden rounded-[16px] border border-white/8 bg-black/15">
        {reminders.length ? (
          <div className="divide-y divide-white/6">
            {reminders.map((reminder) => (
              <div key={reminder.key} className="grid gap-3 p-3 text-sm md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  <div className="font-semibold text-white/85">{reminder.message(reminder.count, reminder.value)}</div>
                  <div className="mt-1 text-xs text-white/42">
                    Next up: {reminder.firstOrder?.job_name || "Job"} • {reminder.firstOrder?.title || "Untitled change order"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <button
                    type="button"
                    onClick={() => viewReminder(reminder)}
                    className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-white/65 hover:border-emerald-300/25 hover:bg-emerald-300/10 hover:text-emerald-50"
                  >
                    View
                  </button>
                  <button
                    type="button"
                    onClick={() => copyReminder(reminder)}
                    className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/18"
                  >
                    {copiedKey === reminder.key ? "Copied" : "Copy follow-up message"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-5 text-sm text-white/50">No change order follow-ups need action.</div>
        )}
      </div>
    </section>
  );
}

function JobAssignmentBoard({
  transactions,
  jobs,
  marginTargets,
  qboGlAccounts = [],
  suggestions = [],
  jobCandidates = [],
  jobCandidatesTotal = 0,
  transactionsError = "",
  jobsError = "",
  jobCandidatesError = "",
  projectsCapability = null,
  jobCandidateBusyId = "",
  assignmentRef,
  instruction,
  setInstruction,
  setAssignmentPreview,
  setAssignmentError,
  assignmentPreview,
  assignmentError,
  assignmentMessage,
  assignmentHistory,
  previewLoading,
  confirmingAssignment,
  listening,
  loading,
  assigningId,
  dragOverJobId,
  draggedTransactionId,
  draggedTransaction,
  suggestionBusyId,
  onDragStart,
  onDragOverJob,
  onDragLeaveJob,
  onDropOnJob,
  onAssignClick,
  onDragEnd,
  onViewAssigned,
  onOpenRevenueDetail,
  onRetrySummary,
  onMarkComplete,
  onReopenJob,
  onRevertCandidateJob,
  onDeleteJob,
  revertingCandidateJobId,
  markingCompleteJobId,
  deletingJobId = "",
  completedJobs = [],
  bucketMode = "live",
  setBucketMode,
  onAcceptSuggestion,
  onRejectSuggestion,
  onApproveCandidateNew,
  onLinkCandidateExisting,
  onDismissCandidate,
  onMergeCandidates,
  onPreviewAssignment,
  onConfirmAssignment,
  onCancelAssignment,
  onStartVoice,
  onAddJob,
  onImportJobs,
  onRefresh,
  readOnly = false,
}) {
  const projectsCapabilityView = getProjectsCapabilityView(projectsCapability || {});
  const postedTransactions = transactions.filter((txn) => String(txn.status || "").toLowerCase() === "posted");
  const pendingCandidates = useMemo(() => (
    (Array.isArray(jobCandidates) ? jobCandidates : [])
      .filter((candidate) => String(candidate.candidate_status || candidate.status || "pending") === "pending")
      .map(normalizeCandidateView)
  ), [jobCandidates]);
  const assignmentDisabled = readOnly || bucketMode !== "live";
  const visibleJobs = bucketMode === "completed" ? completedJobs : jobs;
  const suggestedTotal = Math.max(Number(jobCandidatesTotal || 0), pendingCandidates.length);
  const importJobsLabel = "Import Jobs";
  const importJobsTitle = readOnly
    ? "Job imports are unavailable in read-only Admin View."
    : projectsCapabilityView.available
      ? "Import QuickBooks Projects."
      : "QuickBooks Projects are not enabled or authorized for this company. Review suggested jobs or create a job manually.";
  const [dateRangeFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [transactionSearch, setTransactionSearch] = useState("");
  const [glFilter, setGlFilter] = useState("all");
  const [transactionSort, setTransactionSort] = useState("date_desc");
  const [transactionPage, setTransactionPage] = useState(1);
  const [expandedTransactionId, setExpandedTransactionId] = useState("");
  const [assignmentModalMounted, setAssignmentModalMounted] = useState(false);
  const [assignmentModalVisible, setAssignmentModalVisible] = useState(false);
  const transactionsPerPage = 25;
  const bucketRailRef = useRef(null);
  const bucketScrollTimerRef = useRef(null);
  const assignmentModalTimerRef = useRef(null);
  const [bucketScrollState, setBucketScrollState] = useState({ canScrollLeft: false, canScrollRight: false });
  const updateBucketScrollState = useCallback(() => {
    const rail = bucketRailRef.current;
    if (!rail) {
      setBucketScrollState({ canScrollLeft: false, canScrollRight: false });
      return;
    }
    const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const nextState = {
      canScrollLeft: rail.scrollLeft > 2,
      canScrollRight: rail.scrollLeft < maxScrollLeft - 2,
    };
    setBucketScrollState((current) => (
      current.canScrollLeft === nextState.canScrollLeft && current.canScrollRight === nextState.canScrollRight
        ? current
        : nextState
    ));
  }, []);
  const canScrollBucketRail = useCallback((direction) => {
    const rail = bucketRailRef.current;
    if (!rail) return false;
    const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    if (maxScrollLeft <= 2) return false;
    return direction < 0 ? rail.scrollLeft > 2 : rail.scrollLeft < maxScrollLeft - 2;
  }, []);
  const scrollBucketRail = useCallback((direction) => {
    if (!canScrollBucketRail(direction)) return;
    bucketRailRef.current?.scrollBy({ left: direction * 280, behavior: "smooth" });
  }, [canScrollBucketRail]);
  const stopBucketAutoScroll = useCallback(() => {
    if (bucketScrollTimerRef.current) {
      window.clearInterval(bucketScrollTimerRef.current);
      bucketScrollTimerRef.current = null;
    }
  }, []);
  const startBucketAutoScroll = useCallback((direction) => {
    if (!canScrollBucketRail(direction)) {
      stopBucketAutoScroll();
      return;
    }
    stopBucketAutoScroll();
    bucketRailRef.current?.scrollBy({ left: direction * 120, behavior: "smooth" });
    bucketScrollTimerRef.current = window.setInterval(() => {
      if (!canScrollBucketRail(direction)) {
        stopBucketAutoScroll();
        return;
      }
      bucketRailRef.current?.scrollBy({ left: direction * 120, behavior: "smooth" });
    }, 260);
  }, [canScrollBucketRail, stopBucketAutoScroll]);
  useEffect(() => stopBucketAutoScroll, [stopBucketAutoScroll]);
  useEffect(() => {
    const rail = bucketRailRef.current;
    if (!rail) return undefined;
    updateBucketScrollState();
    rail.addEventListener("scroll", updateBucketScrollState, { passive: true });
    window.addEventListener("resize", updateBucketScrollState);
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateBucketScrollState) : null;
    resizeObserver?.observe(rail);
    if (rail.firstElementChild) resizeObserver?.observe(rail.firstElementChild);
    return () => {
      rail.removeEventListener("scroll", updateBucketScrollState);
      window.removeEventListener("resize", updateBucketScrollState);
      resizeObserver?.disconnect();
    };
  }, [bucketMode, pendingCandidates.length, visibleJobs.length, loading, updateBucketScrollState]);
  const suggestionsByTransactionId = useMemo(() => {
    const map = new Map();
    suggestions.forEach((suggestion) => {
      const txn = getSuggestionTransaction(suggestion);
      const transactionId = String(suggestion.transaction_id || txn.id || "");
      if (!transactionId) return;
      const current = map.get(transactionId);
      if (!current || getSuggestionConfidence(suggestion) > getSuggestionConfidence(current)) {
        map.set(transactionId, suggestion);
      }
    });
    return map;
  }, [suggestions]);
  const glAccountOptions = useMemo(() => {
    const options = [{ value: "all", label: "All GL accounts" }];
    const seen = new Set(["all"]);
    const addOption = (value, label) => {
      if (!value || !label || seen.has(value)) return;
      seen.add(value);
      options.push({ value, label });
    };

    const exactQboAccounts = (Array.isArray(qboGlAccounts) ? qboGlAccounts : [])
      .filter(isRevenueOrExpenseGlAccount)
      .slice()
      .sort((a, b) => getGlAccountOptionName(a).localeCompare(getGlAccountOptionName(b)));

    exactQboAccounts.forEach((account) => {
      const id = getGlAccountOptionId(account);
      const name = getGlAccountOptionName(account);
      addOption(id ? `id:${id}` : `name:${normalizeGlAccountKey(name)}`, name);
    });

    if (options.length === 1) {
      postedTransactions
        .map((txn) => getTransactionAccountName(txn))
        .filter((name) => name && name !== "Uncategorized")
        .sort((a, b) => a.localeCompare(b))
        .forEach((name) => addOption(`name:${normalizeGlAccountKey(name)}`, name));
    }

    return options;
  }, [postedTransactions, qboGlAccounts]);
  useEffect(() => {
    if (glFilter !== "all" && !glAccountOptions.some((option) => option.value === glFilter)) {
      setGlFilter("all");
    }
  }, [glAccountOptions, glFilter]);
  const filteredTransactions = useMemo(() => {
    if (assignmentDisabled) return [];
    const q = transactionSearch.trim().toLowerCase();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const last30 = new Date(now.getTime() - 30 * 86400000);
    const last90 = new Date(now.getTime() - 90 * 86400000);
    return postedTransactions.filter((txn) => {
      const assignedPercent = Number(txn.assigned_total_percent || 0);
      const remainingPercent = Number(txn.remaining_percent ?? Math.max(0, 100 - assignedPercent));
      const officiallyAssigned =
        txn.assignment_status === "assigned" ||
        txn.assignment_status === "partial" ||
        assignedPercent > 0 ||
        remainingPercent < 100 ||
        Boolean(txn.job_id || txn.job_label || txn.assignment_id);
      const txnDate = txn.date ? new Date(txn.date) : null;
      const matchesDate =
        dateRangeFilter === "all" ||
        !txnDate ||
        (dateRangeFilter === "this_month" && txnDate >= startOfMonth) ||
        (dateRangeFilter === "last_30" && txnDate >= last30) ||
        (dateRangeFilter === "last_90" && txnDate >= last90);
      const roleMeta = getTransactionRoleMeta(txn);
      const roleKey = roleMeta.key;
      const payeeDisplay = getPostedTransactionDisplayName(txn);
      const raw = txn?.raw && typeof txn.raw === "object" ? txn.raw : {};
      const haystack = [
        payeeDisplay.displayName,
        txn.qbo_payee_name,
        txn.qbo_vendor_name,
        txn.qbo_customer_name,
        txn.normalized_merchant_name,
        txn.canonical_merchant_name,
        txn.counterparty_name,
        txn.plaid_merchant_name,
        txn.merchant_name,
        txn.vendor,
        txn.payee,
        raw.qbo_payee_name,
        raw.qbo_vendor_name,
        raw.qbo_customer_name,
        raw.normalized_merchant_name,
        raw.canonical_merchant_name,
        raw.counterparty_name,
        raw.merchant_name,
        getTransactionMemo(txn),
        getTransactionAccountName(txn),
        roleMeta.label,
        roleMeta.source,
      ].filter(Boolean).join(" ").toLowerCase();
      return (
        !officiallyAssigned &&
        matchesDate &&
        (roleFilter === "all" || roleFilter === roleKey || (roleFilter === "revenue" && ["invoice", "payment", "deposit", "sales_receipt", "unmatched_inflow"].includes(roleKey))) &&
        (!q || haystack.includes(q)) &&
        (glFilter === "all" || getTransactionGlFilterValues(txn).has(glFilter))
      );
    }).sort((a, b) => {
      if (transactionSort === "vendor_asc") {
        const vendorCompare = getTransactionVendorName(a).localeCompare(getTransactionVendorName(b), undefined, { sensitivity: "base" });
        if (vendorCompare !== 0) return vendorCompare;
      }
      const dateCompare = Date.parse(b.date || 0) - Date.parse(a.date || 0);
      if (dateCompare !== 0) return dateCompare;
      return String(b.id || "").localeCompare(String(a.id || ""));
    });
  }, [assignmentDisabled, dateRangeFilter, glFilter, postedTransactions, roleFilter, transactionSearch, transactionSort]);
  useEffect(() => {
    setTransactionPage(1);
    setExpandedTransactionId("");
  }, [dateRangeFilter, glFilter, roleFilter, transactionSearch, transactionSort]);
  const openAssignmentModal = useCallback(() => {
    if (assignmentModalTimerRef.current) window.clearTimeout(assignmentModalTimerRef.current);
    setAssignmentModalMounted(true);
    window.requestAnimationFrame(() => setAssignmentModalVisible(true));
  }, []);
  const closeAssignmentModal = useCallback(() => {
    setAssignmentModalVisible(false);
    if (assignmentModalTimerRef.current) window.clearTimeout(assignmentModalTimerRef.current);
    assignmentModalTimerRef.current = window.setTimeout(() => {
      setAssignmentModalMounted(false);
    }, 220);
  }, []);
  useEffect(() => {
    if (!assignmentModalMounted) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeAssignmentModal();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [assignmentModalMounted, closeAssignmentModal]);
  useEffect(() => () => {
    if (assignmentModalTimerRef.current) window.clearTimeout(assignmentModalTimerRef.current);
  }, []);
  const transactionPageCount = Math.max(1, Math.ceil(filteredTransactions.length / transactionsPerPage));
  const currentTransactionPage = Math.min(transactionPage, transactionPageCount);
  const pagedTransactions = filteredTransactions.slice(
    (currentTransactionPage - 1) * transactionsPerPage,
    currentTransactionPage * transactionsPerPage
  );
  const transactionRangeStart = filteredTransactions.length ? (currentTransactionPage - 1) * transactionsPerPage + 1 : 0;
  const transactionRangeEnd = Math.min(currentTransactionPage * transactionsPerPage, filteredTransactions.length);
  return (
    <section className={`sticky top-24 z-30 ${glass} p-3 sm:p-4`} aria-label="Job costing assignment board">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-full border border-white/10 bg-black/25 p-1">
          {[
            { key: "live", label: "Live", count: jobs.length },
            { key: "suggested", label: "Suggested Jobs", count: suggestedTotal },
            { key: "completed", label: "Completed", count: completedJobs.length },
          ].map((tab) => {
            const active = bucketMode === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setBucketMode?.(tab.key)}
                className={`inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-semibold transition ${
                  active
                    ? "border border-emerald-300/30 bg-emerald-300/12 text-emerald-50 shadow-[0_0_18px_rgba(16,185,129,0.10)]"
                    : "text-white/50 hover:bg-white/[0.05] hover:text-white/75"
                }`}
              >
                {tab.label}
                <span className="text-[10px] opacity-60">{tab.count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={readOnly ? undefined : onAddJob}
            disabled={readOnly}
            title={readOnly ? "Job changes are unavailable in read-only Admin View." : undefined}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-emerald-300/24 bg-emerald-300/[0.09] px-3 text-xs font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.15] focus:outline-none focus:ring-2 focus:ring-emerald-300/18"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Job
          </button>
          <button
            type="button"
            onClick={readOnly ? undefined : onImportJobs}
            disabled={readOnly}
            title={importJobsTitle}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.045] px-3 text-xs font-semibold text-white/70 transition hover:border-emerald-300/20 hover:bg-emerald-300/[0.07] hover:text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-300/16"
          >
            <UploadCloud className="h-3.5 w-3.5" />
            {importJobsLabel}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border text-white/85 transition hover:bg-white/14 hover:border-white/50 focus:outline-none focus:ring-2 focus:ring-white/14 disabled:opacity-60"
            style={{ borderColor: "rgba(255,255,255,0.22)", background: "rgba(18,18,20,0.86)" }}
            aria-label="Refresh job costing"
            title="Refresh"
          >
            <RefreshCcw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          </button>
        </div>
      </div>
      <div className="relative">
        <div className="relative">
          <button
            type="button"
            onClick={() => scrollBucketRail(-1)}
            onMouseEnter={() => startBucketAutoScroll(-1)}
            onMouseLeave={stopBucketAutoScroll}
            onDragOver={(event) => {
              event.preventDefault();
              startBucketAutoScroll(-1);
            }}
            onDragLeave={stopBucketAutoScroll}
            onDrop={stopBucketAutoScroll}
            className={`absolute left-0 top-1/2 z-20 h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/12 bg-black/45 text-white/75 shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur hover:border-emerald-300/30 hover:bg-emerald-300/12 hover:text-emerald-100 ${
              bucketScrollState.canScrollLeft ? "hidden md:flex" : "hidden"
            }`}
            aria-label="Scroll job buckets left"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div
            ref={bucketRailRef}
            className="overflow-x-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="flex w-max gap-3 px-0.5 pr-12">
              {loading ? (
                <JobCostingInitialLoadingState />
              ) : bucketMode === "suggested" ? (
                jobCandidatesError ? (
                  <div className="w-full min-w-[360px] rounded-xl border border-amber-300/18 bg-amber-300/[0.08] px-4 py-4 text-center text-sm text-amber-50/75">
                    {jobCandidatesError}
                  </div>
                ) : pendingCandidates.length ? (
                  pendingCandidates.map((candidate) => (
                    <SuggestedJobCardBoundary key={candidate.id} candidateId={candidate.id}>
                      <CandidateBucketCard
                        candidate={candidate}
                        jobs={jobs}
                        busyId={jobCandidateBusyId}
                        onApproveNew={readOnly ? null : onApproveCandidateNew}
                        onLinkExisting={readOnly ? null : onLinkCandidateExisting}
                        onDismiss={readOnly ? null : onDismissCandidate}
                        onMerge={readOnly ? null : onMergeCandidates}
                        readOnly={readOnly}
                      />
                    </SuggestedJobCardBoundary>
                  ))
                ) : (
                  <div className="w-full min-w-[360px] rounded-xl border border-white/10 bg-white/[0.035] px-4 py-4 text-center text-sm text-white/55">
                    No pending suggested jobs. Invoice and estimate candidates will appear here after sync.
                  </div>
                )
              ) : visibleJobs.length ? (
                visibleJobs.map((job) => (
                  <JobBucketCard
                    key={job.id || job.jobName}
                    job={job}
                    marginTargets={marginTargets}
                    isDragOver={String(dragOverJobId) === String(job.id)}
                    draggedTransaction={assignmentDisabled ? null : draggedTransaction}
                    allowDrop={!assignmentDisabled}
                    onDragOver={onDragOverJob}
                    onDragLeave={onDragLeaveJob}
                    onDrop={onDropOnJob}
                    onViewAssigned={onViewAssigned}
                    onOpenRevenueDetail={onOpenRevenueDetail}
                    onRetrySummary={onRetrySummary}
                    onMarkComplete={assignmentDisabled ? null : onMarkComplete}
                    onReopenJob={assignmentDisabled ? onReopenJob : null}
                    onRevertCandidateJob={assignmentDisabled ? null : onRevertCandidateJob}
                    onDeleteJob={assignmentDisabled ? null : onDeleteJob}
                    completed={assignmentDisabled}
                    markingComplete={String(markingCompleteJobId || "") === String(job.id)}
                    revertingCandidateJob={String(revertingCandidateJobId || "") === String(job.id)}
                    deletingJob={String(deletingJobId || "") === String(job.id)}
                  />
                ))
              ) : (
                <div className="w-full min-w-[360px] rounded-xl border border-white/10 bg-white/[0.035] px-4 py-4 text-center text-sm text-white/55">
                  {jobsError
                    ? jobsError
                    : assignmentDisabled
                    ? "No completed jobs yet. Mark a live job complete when the work is finished."
                    : "No jobs yet. Import QuickBooks Projects, review suggested jobs, or create a job manually."}
                  {!jobsError && !projectsCapabilityView.available && !assignmentDisabled ? (
                    <div className="mt-2 text-xs text-white/38">
                      QuickBooks Projects are not enabled for this company. Create a job manually or review Suggested Jobs.
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => scrollBucketRail(1)}
            onMouseEnter={() => startBucketAutoScroll(1)}
            onMouseLeave={stopBucketAutoScroll}
            onDragOver={(event) => {
              event.preventDefault();
              startBucketAutoScroll(1);
            }}
            onDragLeave={stopBucketAutoScroll}
            onDrop={stopBucketAutoScroll}
            className={`absolute right-0 top-1/2 z-20 h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/12 bg-black/45 text-white/75 shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur hover:border-emerald-300/30 hover:bg-emerald-300/12 hover:text-emerald-100 ${
              bucketScrollState.canScrollRight ? "hidden md:flex" : "hidden"
            }`}
            aria-label="Scroll job buckets right"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {assignmentDisabled ? (
        <div className="relative z-10 rounded-[18px] border border-white/10 bg-black/15 px-4 py-4 text-center text-sm font-semibold text-white/55">
          {bucketMode === "suggested"
            ? "Review suggested jobs in the rail above. Switch to Live to assign posted transactions."
            : "Assigning transactions to completed jobs is not available."}
        </div>
      ) : (
      <div className="relative z-10">
        <div className="flex max-h-[calc(100vh-430px)] min-h-[300px] flex-col overflow-hidden rounded-[18px] border border-white/10 bg-black/15">
          <div className="relative z-[110] shrink-0 border-b border-white/8 bg-[#1d231f]/95 px-3 py-2 backdrop-blur">
            <div className="grid gap-2 md:grid-cols-[auto_0.62fr_0.9fr_minmax(220px,1.35fr)]">
              <button
                type="button"
                onClick={readOnly ? undefined : openAssignmentModal}
                disabled={readOnly}
                title={readOnly ? "Assignments are unavailable in read-only Admin View." : undefined}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-[14px] border border-emerald-300/25 bg-emerald-300/[0.08] px-3 text-xs font-semibold text-emerald-50 transition hover:border-emerald-300/45 hover:bg-emerald-300/14"
              >
                <Wand2 className="h-3.5 w-3.5" />
                Assign by instruction
              </button>
              <DarkFilterSelect
                value={roleFilter}
                onChange={setRoleFilter}
                ariaLabel="Filter by transaction role"
                compact
                options={[
                  { value: "all", label: "All roles" },
                  { value: "cost", label: "Costs" },
                  { value: "invoice", label: "Invoices" },
                  { value: "payment", label: "Payments" },
                  { value: "deposit", label: "Deposits" },
                  { value: "credit", label: "Credits" },
                  { value: "unmatched_inflow", label: "Unmatched inflows" },
                ]}
              />
              <DarkFilterSelect
                value={glFilter}
                onChange={setGlFilter}
                ariaLabel="Filter by GL account"
                compact
                menuClassName="max-h-[180px]"
                options={glAccountOptions}
              />
              <input
                id="job-costing-transaction-search"
                name="job_costing_transaction_search"
                value={transactionSearch}
                onChange={(event) => setTransactionSearch(event.target.value)}
                placeholder="Search vendor, memo, GL account"
                className="h-9 rounded-[14px] border border-white/10 bg-black/20 px-3 text-xs text-white outline-none placeholder:text-white/35 focus:border-emerald-300/45"
              />
            </div>
            {assignmentMessage ? (
              <div className="mt-2 flex justify-end">
                <span className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1 text-[11px] font-semibold text-emerald-100">
                  {assignmentMessage}
                </span>
              </div>
            ) : null}
          </div>

          <div className="custom-scrollbar relative z-0 min-h-0 flex-1 overflow-auto overscroll-contain">
            <div className="w-full min-w-[720px]">
              <div className="hidden grid-cols-[20px_50px_142px_118px_58px_158px_126px] gap-1.5 border-b border-white/8 bg-white/[0.035] px-2 py-1.5 text-[9px] uppercase tracking-[0.12em] text-white/40 md:grid">
                <div />
                <button
                  type="button"
                  onClick={() => setTransactionSort("date_desc")}
                  className={`inline-flex items-center gap-1 text-left uppercase tracking-[0.12em] transition hover:text-emerald-100 ${
                    transactionSort === "date_desc" ? "text-emerald-100" : ""
                  }`}
                  title="Sort by most recent date"
                >
                  Date
                  <ChevronDown className={`h-2.5 w-2.5 ${transactionSort === "date_desc" ? "opacity-100" : "opacity-0"}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setTransactionSort("vendor_asc")}
                  className={`inline-flex items-center gap-1 text-left uppercase tracking-[0.12em] transition hover:text-emerald-100 ${
                    transactionSort === "vendor_asc" ? "text-emerald-100" : ""
                  }`}
                  title="Sort by vendor or payee A to Z"
                >
                  Vendor / Description
                  <ChevronDown className={`h-2.5 w-2.5 -rotate-90 ${transactionSort === "vendor_asc" ? "opacity-100" : "opacity-0"}`} />
                </button>
                <div>GL Account</div>
                <div className="text-right">Amount</div>
                <div className="pl-2">Assignment Status</div>
                <div className="text-right">Action</div>
              </div>
              <div className="min-h-[180px] pb-28 md:pb-24">
                {loading ? (
                  <JobCostingInitialLoadingState type="transactions" />
                ) : pagedTransactions.length ? (
                  pagedTransactions.map((txn) => {
                    const suggestion = suggestionsByTransactionId.get(String(txn.id));
                    return (
                      <PostedTransactionRow
                        key={txn.id}
                        txn={txn}
                        dragging={String(draggedTransactionId) === String(txn.id)}
                        expanded={String(expandedTransactionId) === String(txn.id)}
                        suggestion={suggestion}
                        suggestionBusy={suggestion ? suggestionBusyId === suggestion.id : false}
                        onToggleExpanded={(transactionId) => {
                          setExpandedTransactionId((current) => (
                            String(current) === String(transactionId) ? "" : String(transactionId)
                          ));
                        }}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onAssignClick={onAssignClick}
                        onAcceptSuggestion={onAcceptSuggestion}
                        onRejectSuggestion={onRejectSuggestion}
                        assigning={assigningId === txn.id}
                      />
                    );
                  })
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-white/55">
                    {transactionsError || "No unassigned posted QuickBooks transactions match those filters."}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 bg-black/10 px-3 py-3 text-xs text-white/45">
            <span>
              {loading
                ? "Loading posted QuickBooks transactions..."
                : `Showing ${transactionRangeStart}-${transactionRangeEnd} of ${filteredTransactions.length} unassigned posted transactions · 25 per page`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Previous posted transactions page"
                onClick={() => setTransactionPage((page) => Math.max(1, page - 1))}
                disabled={currentTransactionPage <= 1 || transactionPageCount <= 1}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/65 transition hover:border-emerald-300/25 hover:bg-emerald-300/[0.08] hover:text-emerald-50 disabled:cursor-not-allowed disabled:opacity-35"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-[76px] text-center text-white/50">
                Page {currentTransactionPage} of {transactionPageCount}
              </span>
              <button
                type="button"
                aria-label="Next posted transactions page"
                onClick={() => setTransactionPage((page) => Math.min(transactionPageCount, page + 1))}
                disabled={currentTransactionPage >= transactionPageCount || transactionPageCount <= 1}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/65 transition hover:border-emerald-300/25 hover:bg-emerald-300/[0.08] hover:text-emerald-50 disabled:cursor-not-allowed disabled:opacity-35"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
      )}

      {assignmentModalMounted ? (
        <div
          className={`fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-3 py-6 backdrop-blur-sm transition-opacity duration-200 ease-out ${
            assignmentModalVisible ? "opacity-100" : "opacity-0"
          }`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAssignmentModal();
          }}
        >
          <div className={`w-full max-w-[860px] overflow-hidden rounded-[24px] border border-emerald-300/20 bg-[#111713] p-3 shadow-[0_28px_90px_rgba(0,0,0,0.65)] transition-all duration-200 ease-out ${
            assignmentModalVisible ? "translate-y-0 scale-100 opacity-100" : "translate-y-3 scale-[0.97] opacity-0"
          }`}>
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/65">Transaction Assignment</p>
                <h2 className="mt-1 text-base font-semibold text-white">Assign by instruction</h2>
              </div>
              <button
                type="button"
                onClick={closeAssignmentModal}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-lg leading-none text-white/65 transition hover:bg-white/[0.1] hover:text-white"
                aria-label="Close assignment instruction"
              >
                ×
              </button>
            </div>
            <NaturalLanguageAssignmentBar
              assignmentRef={assignmentRef}
              instruction={instruction}
              setInstruction={setInstruction}
              setAssignmentPreview={setAssignmentPreview}
              setAssignmentError={setAssignmentError}
              assignmentPreview={assignmentPreview}
              assignmentError={assignmentError}
              assignmentMessage={assignmentMessage}
              assignmentHistory={assignmentHistory}
              previewLoading={previewLoading}
              confirmingAssignment={confirmingAssignment}
              listening={listening}
              previewAssignment={onPreviewAssignment}
              confirmAssignment={onConfirmAssignment}
              cancelAssignment={onCancelAssignment}
              startVoice={onStartVoice}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function JobDeepDive({
  job,
  marginTargets,
  unassignedTransactions,
  potentialChangeOrders = [],
  onBack,
  onAssignMore,
  onLogChangeOrder,
  onPreviewChangeOrderPrice,
  onUpdateChangeOrder,
  onConvertPotentialChangeOrder,
  onDismissPotentialChangeOrder,
  changeOrderSaving,
  changeOrderMessage,
  readOnly = false,
}) {
  const [changeOrderOpen, setChangeOrderOpen] = useState(false);
  const [changeOrderForm, setChangeOrderForm] = useState({
    title: "",
    description: "",
    estimated_cost: "",
    target_margin_percent: "",
    proposed_price: "",
    client_notes: "",
    internal_notes: "",
    draft_client_message: "",
  });
  const [changeOrderError, setChangeOrderError] = useState("");
  const [changeOrderRecommendation, setChangeOrderRecommendation] = useState(null);
  const [changeOrderPreviewing, setChangeOrderPreviewing] = useState(false);
  const [changeOrderActionId, setChangeOrderActionId] = useState("");
  const [potentialChangeOrderBusyId, setPotentialChangeOrderBusyId] = useState("");
  const [changeOrderCopied, setChangeOrderCopied] = useState(false);
  const grossMarginDollars = Number(job.revenue || 0) - Number(job.total_cost || 0);
  const margin = Number(job.margin_percent);
  const target = getTargetForJob(job, marginTargets);
  const tone = marginTone(margin, target);
  const guardrail = guardrailStatus(margin, target);
  const breakdown = buildCostBreakdown(job);
  const assignedTransactions = (job.transactions || []).slice().sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
  const changeOrders = (job.change_orders || []).slice().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  const changeOrderSummary = summarizeChangeOrderCards(job);
  const unassignedCosts = (unassignedTransactions || []).filter(isCostTransaction);
  const recommendations = buildJobRecommendations(job, unassignedCosts, target);
  const updateChangeOrderField = (field, value) => {
    setChangeOrderForm((prev) => ({ ...prev, [field]: value }));
    setChangeOrderError("");
    if (field === "estimated_cost" || field === "target_margin_percent") setChangeOrderRecommendation(null);
  };
  const closeChangeOrder = () => {
    setChangeOrderOpen(false);
    setChangeOrderError("");
    setChangeOrderRecommendation(null);
  };
  const resetChangeOrderForm = () => {
    setChangeOrderForm({
      title: "",
      description: "",
      estimated_cost: "",
      target_margin_percent: "",
      proposed_price: "",
      client_notes: "",
      internal_notes: "",
      draft_client_message: "",
    });
    setChangeOrderRecommendation(null);
    setChangeOrderCopied(false);
  };
  const previewChangeOrderPrice = async () => {
    if (readOnly) {
      setChangeOrderError("Change orders are unavailable in read-only Admin View.");
      return;
    }
    const estimatedCost = Number(changeOrderForm.estimated_cost || 0);
    const targetMargin = changeOrderForm.target_margin_percent === "" ? null : Number(changeOrderForm.target_margin_percent);
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
      setChangeOrderError("Estimated cost must be numeric and at least 0.");
      return;
    }
    if (targetMargin !== null && !Number.isFinite(targetMargin)) {
      setChangeOrderError("Target margin must be numeric.");
      return;
    }
    setChangeOrderPreviewing(true);
    setChangeOrderError("");
    try {
      const recommendation = await onPreviewChangeOrderPrice?.(job, {
        estimated_cost: estimatedCost,
        target_margin_percent: targetMargin,
      });
      setChangeOrderRecommendation(recommendation || null);
      setChangeOrderForm((prev) => ({
        ...prev,
        draft_client_message: prev.draft_client_message || buildChangeOrderClientDraftPreview(job, prev, recommendation),
      }));
    } catch (e) {
      setChangeOrderError(e?.message || "Could not preview recommended price.");
    } finally {
      setChangeOrderPreviewing(false);
    }
  };
  const copyDraftClientMessage = async () => {
    const text = changeOrderForm.draft_client_message || buildChangeOrderClientDraftPreview(job, changeOrderForm, changeOrderRecommendation);
    setChangeOrderForm((prev) => ({ ...prev, draft_client_message: text }));
    try {
      await navigator.clipboard?.writeText(text);
      setChangeOrderCopied(true);
      window.setTimeout(() => setChangeOrderCopied(false), 1600);
    } catch {
      setChangeOrderError("Could not copy draft message.");
    }
  };
  const submitChangeOrder = async (event) => {
    event.preventDefault();
    if (readOnly) {
      setChangeOrderError("Change orders are unavailable in read-only Admin View.");
      return;
    }
    const title = changeOrderForm.title.trim();
    const description = changeOrderForm.description.trim();
    const estimatedCost = Number(changeOrderForm.estimated_cost || 0);
    const proposedPrice = changeOrderForm.proposed_price === "" ? null : Number(changeOrderForm.proposed_price);
    const targetMargin = changeOrderForm.target_margin_percent === "" ? null : Number(changeOrderForm.target_margin_percent);
    if (!title) {
      setChangeOrderError("Title is required.");
      return;
    }
    if (!description) {
      setChangeOrderError("Description of extra work is required.");
      return;
    }
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
      setChangeOrderError("Estimated cost must be numeric and at least 0.");
      return;
    }
    if (proposedPrice !== null && (!Number.isFinite(proposedPrice) || proposedPrice < 0)) {
      setChangeOrderError("Proposed price must be numeric and at least 0.");
      return;
    }
    if (targetMargin !== null && !Number.isFinite(targetMargin)) {
      setChangeOrderError("Target margin must be numeric.");
      return;
    }
    try {
      const saved = await onLogChangeOrder?.(job, {
        title,
        description,
        estimated_cost: estimatedCost,
        target_margin_percent: targetMargin,
        proposed_price: proposedPrice,
        client_notes: changeOrderForm.client_notes.trim(),
        internal_notes: changeOrderForm.internal_notes.trim(),
        draft_client_message: changeOrderForm.draft_client_message.trim(),
      });
      setChangeOrderRecommendation(saved?.recommendation_reason || null);
      resetChangeOrderForm();
      closeChangeOrder();
    } catch (e) {
      setChangeOrderError(e?.message || "Could not log change order.");
    }
  };
  const updateChangeOrderStatus = async (order, status) => {
    if (readOnly) {
      setChangeOrderError("Change order updates are unavailable in read-only Admin View.");
      return;
    }
    if (!order?.id) return;
    setChangeOrderActionId(`${order.id}:${status}`);
    setChangeOrderError("");
    try {
      const value = Number(order.approved_price ?? order.proposed_price ?? 0) || 0;
      const patch = { status };
      if (status === "client_approved") patch.approved_price = value;
      if (status === "billed") patch.billed_amount = Number(order.billed_amount ?? value) || 0;
      if (status === "paid") patch.paid_amount = Number(order.paid_amount ?? order.billed_amount ?? value) || 0;
      await onUpdateChangeOrder?.(order, patch);
    } catch (e) {
      setChangeOrderError(e?.message || "Could not update change order.");
    } finally {
      setChangeOrderActionId("");
    }
  };
  const convertPotentialChangeOrder = async (suggestion) => {
    if (readOnly) {
      setChangeOrderError("Change orders are unavailable in read-only Admin View.");
      return;
    }
    if (!suggestion?.id) return;
    setPotentialChangeOrderBusyId(`${suggestion.id}:convert`);
    setChangeOrderError("");
    try {
      await onConvertPotentialChangeOrder?.(suggestion);
    } catch (e) {
      setChangeOrderError(e?.message || "Could not create change order.");
    } finally {
      setPotentialChangeOrderBusyId("");
    }
  };
  const dismissPotentialChangeOrder = async (suggestion) => {
    if (readOnly) {
      setChangeOrderError("Change order suggestions are read-only in Admin View.");
      return;
    }
    if (!suggestion?.id) return;
    setPotentialChangeOrderBusyId(`${suggestion.id}:dismiss`);
    setChangeOrderError("");
    try {
      await onDismissPotentialChangeOrder?.(suggestion);
    } catch (e) {
      setChangeOrderError(e?.message || "Could not dismiss suggestion.");
    } finally {
      setPotentialChangeOrderBusyId("");
    }
  };

  return (
    <section className={`${glass} p-4 sm:p-6`} aria-label="Individual job deep dive">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <button type="button" onClick={onBack} className="text-sm font-semibold text-emerald-200 hover:text-emerald-100">
            ← Back to Job Costing
          </button>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold text-white md:text-3xl">{job.jobName}</h2>
            <span className={`rounded-full border px-3 py-1 text-xs ${statusClass(job.status)}`}>{job.status}</span>
          </div>
          <p className="mt-2 text-sm text-white/55">{job.customer_name}</p>
          <p className="mt-1 text-sm text-white/45">{job.trade_type}</p>
        </div>

        <div className="flex flex-col gap-3 lg:items-end">
          <div className={`rounded-[24px] border ${tone.border} ${tone.bg} p-5 text-left lg:min-w-[260px]`}>
            <div className="text-xs uppercase tracking-[0.14em] text-white/45">Gross Margin</div>
            <div className={`mt-2 text-5xl font-semibold ${tone.text}`}>
              {Number.isFinite(margin) ? `${percent.format(margin)}%` : "-"}
            </div>
            <div className="mt-2 text-sm text-white/55">Target: {target}% • {tone.label}</div>
          </div>
        </div>
      </div>

      {changeOrderMessage ? (
        <div className="mt-5 rounded-[18px] border border-emerald-300/25 bg-emerald-300/10 px-4 py-3 text-sm font-medium text-emerald-100">
          {changeOrderMessage}
        </div>
      ) : null}
      {changeOrderError && !changeOrderOpen ? (
        <div className="mt-5 rounded-[18px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
          {changeOrderError}
        </div>
      ) : null}

      {Number.isFinite(margin) && margin < target ? (
        <div className="mt-5 rounded-[18px] border border-rose-300/25 bg-rose-300/10 px-4 py-3 text-sm font-medium text-rose-100">
          This job is below target margin. Review costs or consider a change order.
        </div>
      ) : null}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Total Revenue", money.format(job.revenue)],
          ["Total Cost", money.format(job.total_cost)],
          ["Gross Margin $", money.format(grossMarginDollars)],
          ["Actual vs Target", Number.isFinite(margin) ? `${percent.format(margin)}% vs ${target}%` : `- vs ${target}%`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[18px] border border-white/10 bg-white/[0.045] p-4">
            <div className="text-[11px] uppercase tracking-[0.14em] text-white/40">{label}</div>
            <div className="mt-2 text-xl font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-[18px] border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-white/65">
        Guardrail status: <span className={`font-semibold ${guardrail.text}`}>{guardrail.label}</span>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <section className="rounded-[22px] border border-white/10 bg-black/20 p-4" aria-label="Cost breakdown">
          <h3 className="text-lg font-semibold text-white">Cost Breakdown</h3>
          <div className="mt-4 flex h-4 overflow-hidden rounded-full bg-white/[0.06]">
            {breakdown.map((item) => (
              <div key={item.key} className={item.color} style={{ width: `${Math.max(item.percent, item.percent > 0 ? 4 : 0)}%` }} />
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {breakdown.map((item) => (
              <div key={item.key} className="rounded-[16px] bg-white/[0.04] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${item.color}`} />
                    <span className="text-sm font-medium text-white/80">{item.label} %</span>
                  </div>
                  <span className="text-sm font-semibold text-white">{percent.format(item.percent)}%</span>
                </div>
                <div className="mt-1 text-xs text-white/40">{money.format(item.value)}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[22px] border border-white/10 bg-black/20 p-4" aria-label="AI recommendations">
          <h3 className="text-lg font-semibold text-white">AI Recommendations</h3>
          <div className="mt-4 space-y-3">
            {recommendations.map((recommendation) => (
              <div key={recommendation} className="rounded-[16px] border border-[rgba(var(--accent-rgb),0.18)] bg-[rgba(var(--accent-rgb),0.07)] p-3 text-sm leading-5 text-white/70">
                {recommendation}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={readOnly ? undefined : onAssignMore}
            disabled={readOnly}
            title={readOnly ? "Assignments are unavailable in read-only Admin View." : undefined}
            className="mt-4 rounded-full border border-emerald-300/35 bg-emerald-300/12 px-4 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-300/18 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Assign More Transactions
          </button>
        </section>
      </div>

      <section className="mt-6 overflow-hidden rounded-[22px] border border-amber-300/15 bg-amber-300/[0.045]" aria-label="Potential change orders">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Potential Change Orders</h3>
            <p className="mt-1 text-sm text-white/45">{potentialChangeOrders.length} pending suggestion{potentialChangeOrders.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        {potentialChangeOrders.length ? (
          <div className="grid gap-3 border-t border-white/8 p-4">
            {potentialChangeOrders.map((suggestion) => {
              const confidence = Number(suggestion.confidence_score || 0);
              return (
                <div key={suggestion.id} className="rounded-[18px] border border-white/10 bg-black/20 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-semibold text-white">{suggestion.title || "Potential change order"}</h4>
                        <span className="rounded-full border border-amber-200/25 bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-100">
                          {Math.round(confidence)}% confidence
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-5 text-white/58">{suggestion.explanation}</p>
                    </div>
                    <div className="grid min-w-[220px] grid-cols-2 gap-2 text-sm">
                      <div className="rounded-[14px] border border-white/10 bg-white/[0.04] p-3">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">Extra Cost</div>
                        <div className="mt-1 font-semibold text-rose-100">{money.format(Number(suggestion.estimated_extra_cost || 0))}</div>
                      </div>
                      <div className="rounded-[14px] border border-white/10 bg-white/[0.04] p-3">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">Suggested Price</div>
                        <div className="mt-1 font-semibold text-emerald-100">{money.format(Number(suggestion.suggested_price || 0))}</div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => convertPotentialChangeOrder(suggestion)}
                      disabled={readOnly || potentialChangeOrderBusyId === `${suggestion.id}:convert`}
                      title={readOnly ? "Change orders are unavailable in read-only Admin View." : undefined}
                      className="rounded-full border border-emerald-300/35 bg-emerald-300/12 px-3 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/18 disabled:opacity-55"
                    >
                      {potentialChangeOrderBusyId === `${suggestion.id}:convert` ? "Creating..." : "Create Change Order"}
                    </button>
                    <button
                      type="button"
                      onClick={() => dismissPotentialChangeOrder(suggestion)}
                      disabled={readOnly || potentialChangeOrderBusyId === `${suggestion.id}:dismiss`}
                      title={readOnly ? "Change order suggestions are read-only in Admin View." : undefined}
                      className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/65 hover:bg-white/[0.09] disabled:opacity-55"
                    >
                      {potentialChangeOrderBusyId === `${suggestion.id}:dismiss` ? "Dismissing..." : "Dismiss"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="border-t border-white/8 px-4 py-6 text-sm text-white/55">
            No potential change orders flagged for this job.
          </div>
        )}
      </section>

      <section className="mt-6 overflow-hidden rounded-[22px] border border-white/10 bg-black/20" aria-label="Change orders">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Change Orders</h3>
            <p className="mt-1 text-sm text-white/45">{changeOrders.length} logged</p>
          </div>
          <button
            type="button"
            onClick={readOnly ? undefined : () => setChangeOrderOpen(true)}
            disabled={readOnly}
            title={readOnly ? "Change orders are unavailable in read-only Admin View." : undefined}
            className="rounded-full border border-emerald-300/35 bg-emerald-300/12 px-4 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-300/18 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Log Change Order
          </button>
        </div>
        <div className="grid gap-2 border-t border-white/8 px-4 py-3 sm:grid-cols-5">
          {[
            ["Proposed", changeOrderSummary.proposed],
            ["Approved", changeOrderSummary.approved],
            ["Billed", changeOrderSummary.billed],
            ["Paid", changeOrderSummary.paid],
            ["Open Value", changeOrderSummary.openValue],
          ].map(([label, value]) => (
            <div key={label} className="rounded-[16px] border border-white/10 bg-white/[0.04] p-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">{label}</div>
              <div className="mt-1 text-base font-semibold text-white">{money.format(value)}</div>
            </div>
          ))}
        </div>
        {changeOrders.length ? (
          <div className="custom-scrollbar overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-y border-white/8 text-[11px] uppercase tracking-[0.12em] text-white/40">
                <tr>
                  <th className="px-4 py-3 font-medium">Title</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Estimated Cost</th>
                  <th className="px-4 py-3 text-right font-medium">Proposed Price</th>
                  <th className="px-4 py-3 text-right font-medium">Approved / Billed / Paid</th>
                  <th className="px-4 py-3 font-medium">Created Date</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6">
                {changeOrders.map((order) => {
                  const status = String(order.status || "proposed");
                  const statusMeta = getChangeOrderStatusMeta(status);
                  const actions = getChangeOrderActionStatus(order);
                  return (
                    <tr key={order.id || `${order.description}-${order.created_at}`} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-white/85">{order.title || "Untitled change order"}</div>
                        <div className="mt-0.5 line-clamp-1 text-xs text-white/42">{order.description}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusMeta.className}`}>
                          {statusMeta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-rose-100">{money.format(Number(order.estimated_cost || 0))}</td>
                      <td className="px-4 py-3 text-right font-semibold text-white">{money.format(Number(order.proposed_price || 0))}</td>
                      <td className="px-4 py-3 text-right text-white/65">
                        <div>{money.format(Number(order.approved_price ?? order.proposed_price ?? 0))}</div>
                        <div className="mt-0.5 text-xs text-white/40">
                          {money.format(Number(order.billed_amount || 0))} / {money.format(Number(order.paid_amount || 0))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-white/60">{formatDate(order.created_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {actions.map((action) => (
                            <button
                              key={action.status}
                              type="button"
                              onClick={() => updateChangeOrderStatus(order, action.status)}
                              disabled={readOnly || changeOrderActionId === `${order.id}:${action.status}`}
                              title={readOnly ? "Change order updates are unavailable in read-only Admin View." : undefined}
                              className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-semibold text-white/70 hover:border-emerald-300/30 hover:bg-emerald-300/10 hover:text-emerald-50 disabled:opacity-50"
                            >
                              {changeOrderActionId === `${order.id}:${action.status}` ? "Saving..." : action.label}
                            </button>
                          ))}
                          {!actions.length ? (
                            <span className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[11px] font-semibold text-white/38">
                              {getChangeOrderTerminalHint(status)}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t border-white/8 px-4 py-8 text-sm text-white/55">
            No change orders logged for this job yet.
          </div>
        )}
      </section>

      <section className="mt-6 overflow-hidden rounded-[22px] border border-white/10 bg-black/20" aria-label="Cost timeline">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <h3 className="text-lg font-semibold text-white">Cost Timeline</h3>
          <span className="text-sm text-white/45">{assignedTransactions.length} assigned transactions</span>
        </div>
        {assignedTransactions.length ? (
          <div className="custom-scrollbar overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-y border-white/8 text-[11px] uppercase tracking-[0.12em] text-white/40">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Vendor / Description</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 text-right font-medium">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6">
                {assignedTransactions.map((txn) => (
                  <tr key={txn.id} className="hover:bg-white/[0.03]">
                    <td className="px-4 py-3 text-white/60">{formatDate(txn.date)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-white/85">{txn.vendor || "Unknown vendor"}</div>
                      <div className="mt-0.5 text-xs text-white/40">{getTransactionMemo(txn) || "No memo"}</div>
                    </td>
                    <td className="px-4 py-3 text-white/65">{txn.gl_account || "Uncategorized"}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${isCostTransaction(txn) ? "text-rose-100" : "text-emerald-100"}`}>
                      {money.format(Math.abs(Number(txn.amount || 0)))}
                    </td>
                    <td className="px-4 py-3 text-white/60">{txn.assignment_source || "assigned"}</td>
                    <td className="px-4 py-3 text-right text-white/60">
                      {txn.assignment_confidence ? `${Math.round(Number(txn.assignment_confidence) * 100)}%` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t border-white/8 px-4 py-8 text-sm text-white/55">
            No assigned transactions yet. Use Assign More Transactions to connect costs and revenue to this job.
          </div>
        )}
      </section>

      {changeOrderOpen ? (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 px-3 py-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Log change order">
          <form onSubmit={submitChangeOrder} className="custom-scrollbar max-h-[92vh] w-full max-w-[640px] overflow-y-auto rounded-[28px] border border-white/10 bg-[#171d1b] p-4 shadow-[0_28px_80px_rgba(0,0,0,0.55)] sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-white">Log Change Order</h3>
                <p className="mt-1 text-sm text-white/50">{job.jobName}</p>
              </div>
              <button type="button" onClick={closeChangeOrder} className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-sm font-semibold text-white/70 hover:bg-white/[0.1]">
                Cancel
              </button>
            </div>

            <div className="mt-5 grid gap-3">
              <label className="block">
                <span className="text-xs uppercase tracking-[0.14em] text-white/40">Title</span>
                <input
                  value={changeOrderForm.title}
                  onChange={(e) => updateChangeOrderField("title", e.target.value)}
                  className="mt-2 w-full rounded-[14px] border border-white/10 bg-black/25 px-3 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-emerald-300/45"
                  placeholder="Owner-requested finish upgrade"
                />
              </label>

              <label className="block">
                <span className="text-xs uppercase tracking-[0.14em] text-white/40">Description of extra work</span>
                <textarea
                  value={changeOrderForm.description}
                  onChange={(e) => updateChangeOrderField("description", e.target.value)}
                  rows={3}
                  className="mt-2 w-full resize-none rounded-[14px] border border-white/10 bg-black/25 px-3 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-emerald-300/45"
                  placeholder="Scope, materials, labor, and client request details..."
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-xs uppercase tracking-[0.14em] text-white/40">Estimated Cost</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={changeOrderForm.estimated_cost}
                    onChange={(e) => updateChangeOrderField("estimated_cost", e.target.value)}
                    className="mt-2 w-full rounded-[14px] border border-white/10 bg-black/25 px-3 py-3 text-sm text-white outline-none focus:border-emerald-300/45"
                  />
                </label>
                <label className="block">
                  <span className="text-xs uppercase tracking-[0.14em] text-white/40">Target Margin % optional</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={changeOrderForm.target_margin_percent}
                    onChange={(e) => updateChangeOrderField("target_margin_percent", e.target.value)}
                    className="mt-2 w-full rounded-[14px] border border-white/10 bg-black/25 px-3 py-3 text-sm text-white outline-none focus:border-emerald-300/45"
                  />
                </label>
                <label className="block">
                  <span className="text-xs uppercase tracking-[0.14em] text-white/40">Proposed Price optional</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={changeOrderForm.proposed_price}
                    onChange={(e) => updateChangeOrderField("proposed_price", e.target.value)}
                    className="mt-2 w-full rounded-[14px] border border-white/10 bg-black/25 px-3 py-3 text-sm text-white outline-none focus:border-emerald-300/45"
                  />
                </label>
              </div>

              <div className="rounded-[18px] border border-emerald-300/15 bg-emerald-300/[0.06] p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-emerald-100/55">Recommended Price</div>
                    <div className="mt-1 text-lg font-semibold text-emerald-50">
                      {changeOrderRecommendation ? money.format(changeOrderRecommendation.recommended_price) : "Preview available"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={previewChangeOrderPrice}
                    disabled={changeOrderPreviewing}
                    className="rounded-full border border-emerald-300/30 bg-emerald-300/12 px-3 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/18 disabled:opacity-55"
                  >
                    {changeOrderPreviewing ? "Previewing..." : "Preview Price"}
                  </button>
                </div>
                {changeOrderRecommendation?.explanation ? (
                  <div className="mt-2 text-xs text-emerald-50/65">{changeOrderRecommendation.explanation}</div>
                ) : null}
              </div>

              <label className="block rounded-[18px] border border-white/10 bg-white/[0.035] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs uppercase tracking-[0.14em] text-white/40">Draft Client Message</span>
                  <button
                    type="button"
                    onClick={copyDraftClientMessage}
                    className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-white/65 hover:border-emerald-300/25 hover:bg-emerald-300/10 hover:text-emerald-50"
                  >
                    {changeOrderCopied ? "Copied" : "Copy"}
                  </button>
                </div>
                <textarea
                  value={changeOrderForm.draft_client_message}
                  onChange={(e) => updateChangeOrderField("draft_client_message", e.target.value)}
                  onFocus={() => {
                    if (!changeOrderForm.draft_client_message) {
                      updateChangeOrderField("draft_client_message", buildChangeOrderClientDraftPreview(job, changeOrderForm, changeOrderRecommendation));
                    }
                  }}
                  rows={5}
                  className="mt-2 w-full resize-none rounded-[14px] border border-white/10 bg-black/25 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-emerald-300/45"
                  placeholder="Preview price or click here to generate a client-ready draft..."
                />
              </label>

              <label className="block">
                <span className="text-xs uppercase tracking-[0.14em] text-white/40">Client Notes</span>
                <textarea
                  value={changeOrderForm.client_notes}
                  onChange={(e) => updateChangeOrderField("client_notes", e.target.value)}
                  rows={3}
                  className="mt-2 w-full resize-none rounded-[14px] border border-white/10 bg-black/25 px-3 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-emerald-300/45"
                  placeholder="Client-facing scope and approval notes..."
                />
              </label>

              <label className="block">
                <span className="text-xs uppercase tracking-[0.14em] text-white/40">Internal Notes</span>
                <textarea
                  value={changeOrderForm.internal_notes}
                  onChange={(e) => updateChangeOrderField("internal_notes", e.target.value)}
                  rows={3}
                  className="mt-2 w-full resize-none rounded-[14px] border border-white/10 bg-black/25 px-3 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-emerald-300/45"
                  placeholder="Internal cost, billing, or project manager notes..."
                />
              </label>
            </div>

            {changeOrderError ? (
              <div className="mt-3 rounded-[14px] border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
                {changeOrderError}
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={closeChangeOrder} className="rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-white/75 hover:bg-white/[0.1]">
                Cancel
              </button>
              <button
                type="submit"
                disabled={changeOrderSaving}
                className="rounded-full border border-emerald-300/35 bg-emerald-300/14 px-4 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-300/22 disabled:opacity-50"
              >
                {changeOrderSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

const emptyBidForm = {
  bid_title: "",
  customer_name: "",
  job_type: "",
  trade_type: "",
  scope_description: "",
  square_footage: "",
  desired_margin_percent: "",
  minimum_margin_percent: "",
};

const demoRecentBids = [
  {
    id: "demo-bid-1",
    bid_title: "Hawthorne Porch Rebuild",
    customer_name: "Hawthorne Builders",
    job_type: "Porch rebuild",
    trade_type: "Carpentry",
    status: "sent",
    estimated_total_cost: 8200,
    recommended_price: 12615,
    projected_margin_percent: 35,
    created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  },
  {
    id: "demo-bid-2",
    bid_title: "Johnson Deck Rail Update",
    customer_name: "Maya Johnson",
    job_type: "Decking",
    trade_type: "Decking",
    status: "draft",
    estimated_total_cost: 4600,
    recommended_price: 7077,
    projected_margin_percent: 35,
    created_at: new Date(Date.now() - 6 * 86400000).toISOString(),
  },
];

function buildDemoBidFromForm(form) {
  const sqft = Number(form.square_footage || 0);
  const lower = `${form.trade_type || ""} ${form.job_type || ""}`.toLowerCase();
  const costPerSqft = /deck|porch/.test(lower) ? 68 : /paint/.test(lower) ? 5 : /bath|kitchen|remodel/.test(lower) ? 165 : 42;
  const estimatedTotalCost = sqft > 0 ? sqft * costPerSqft : /bath|kitchen|remodel/.test(lower) ? 18000 : 7200;
  const targetMargin = Number(form.desired_margin_percent || form.minimum_margin_percent || 35);
  const safeMargin = Number.isFinite(targetMargin) && targetMargin > 0 && targetMargin < 95 ? targetMargin : 35;
  const recommendedPrice = Math.round((estimatedTotalCost / (1 - safeMargin / 100)) * 100) / 100;
  const categories = {
    labor: Math.round(estimatedTotalCost * 0.34 * 100) / 100,
    materials: Math.round(estimatedTotalCost * 0.38 * 100) / 100,
    subcontractors: Math.round(estimatedTotalCost * 0.13 * 100) / 100,
    permits: Math.round(estimatedTotalCost * 0.05 * 100) / 100,
    other: 0,
  };
  categories.other = Math.round((estimatedTotalCost - categories.labor - categories.materials - categories.subcontractors - categories.permits) * 100) / 100;
  const multiplier = recommendedPrice / estimatedTotalCost;
  const paymentSchedule = [
    { label: "Deposit", percent: 30, amount: Math.round(recommendedPrice * 0.3 * 100) / 100 },
    { label: "Progress payment", percent: 40, amount: Math.round(recommendedPrice * 0.4 * 100) / 100 },
    { label: "Final payment", percent: 30, amount: Math.round(recommendedPrice * 0.3 * 100) / 100 },
  ];
  const lineItems = [
    ["labor", "Estimated labor", categories.labor],
    ["materials", "Estimated materials", categories.materials],
    ["subcontractors", "Estimated subcontractors", categories.subcontractors],
    ["permits", "Estimated permits and fees", categories.permits],
    ["other", "Estimated other costs", categories.other],
  ].map(([category, name, total]) => ({
    id: `demo-line-${category}`,
    category,
    name,
    quantity: 1,
    unit_cost: total,
    total_cost: total,
    markup_percent: Math.round((multiplier - 1) * 10000) / 100,
    selling_price: Math.round(total * multiplier * 100) / 100,
  }));

  return {
    id: `demo-bid-${Date.now()}`,
    bid_title: form.bid_title,
    customer_name: form.customer_name,
    prospect_name: "",
    job_type: form.job_type,
    trade_type: form.trade_type,
    status: "draft",
    estimated_total_cost: Math.round(estimatedTotalCost * 100) / 100,
    recommended_price: recommendedPrice,
    projected_margin_percent: safeMargin,
    deposit_amount: paymentSchedule[0].amount,
    payment_schedule: paymentSchedule,
    risk_flags: [
      { message: "Only 2 similar jobs found", severity: "medium", code: "limited_historical_data" },
      ...(sqft > 0 ? [] : [{ message: "No square footage provided", severity: "low", code: "missing_square_footage" }]),
    ],
    historical_basis: {
      similar_record_count: 2,
      average_revenue: recommendedPrice * 0.95,
      average_total_cost: estimatedTotalCost * 0.92,
      average_margin_percent: 32,
      average_cost_per_square_foot: sqft > 0 ? estimatedTotalCost / sqft : null,
      target_margin_percent: safeMargin,
      cost_basis: "demo_profile",
      similar_records: [
        { id: "demo-similar-1", title: "Johnson Deck Rebuild", margin_percent: 34, total_cost: estimatedTotalCost * 0.9 },
        { id: "demo-similar-2", title: "Hawthorne Porch", margin_percent: 30, total_cost: estimatedTotalCost * 0.95 },
      ],
    },
    proposal_text: `Based on the described scope, Bizzi recommends a project price of ${money.format(recommendedPrice)} for ${form.bid_title}. This recommendation uses demo job-costing assumptions and targets a ${safeMargin}% gross margin. Scope summary: ${form.scope_description}`,
    line_items: lineItems,
    created_at: new Date().toISOString(),
  };
}

function BidBuilderMetric({ label, value, tone = "default" }) {
  const toneClass = tone === "green" ? "text-emerald-100" : tone === "amber" ? "text-amber-100" : "text-white";
  return (
    <div className="rounded-[18px] bg-white/[0.05] p-4 shadow-[0_14px_34px_rgba(0,0,0,0.24)]">
      <div className="text-xs font-medium uppercase tracking-[0.18em] text-white/42">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function toEditableBidLineItems(items = []) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    id: item.id || `line-${index}`,
    category: item.category || "other",
    name: item.name || "Line item",
    description: item.description || null,
    quantity: Number(item.quantity || 1),
    unit: item.unit || "allowance",
    unit_cost: Number(item.unit_cost || 0),
    total_cost: Number(item.total_cost ?? (Number(item.quantity || 1) * Number(item.unit_cost || 0))),
    markup_percent: item.markup_percent ?? null,
    selling_price: item.selling_price ?? null,
    source: item.source || "manual",
  }));
}

function resolveBidMargin(bid = {}) {
  const candidates = [bid.desired_margin_percent, bid.minimum_margin_percent, bid.projected_margin_percent, 35];
  const margin = candidates.map(Number).find((value) => Number.isFinite(value) && value > 0 && value < 95);
  return margin || 35;
}

function calculateBidWhatIf(lineItems = [], marginPercent = 35) {
  const safeMargin = Number.isFinite(Number(marginPercent)) && Number(marginPercent) > 0 && Number(marginPercent) < 95
    ? Number(marginPercent)
    : 35;
  const estimatedCost = lineItems.reduce((sum, item) => sum + Number(item.total_cost || 0), 0);
  const recommendedPrice = estimatedCost > 0 ? Math.round((estimatedCost / (1 - safeMargin / 100)) * 100) / 100 : 0;
  const grossMargin = Math.round((recommendedPrice - estimatedCost) * 100) / 100;
  const multiplier = estimatedCost > 0 ? recommendedPrice / estimatedCost : 0;
  return {
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    recommendedPrice,
    projectedMarginPercent: recommendedPrice > 0 ? Math.round((grossMargin / recommendedPrice) * 10000) / 100 : 0,
    depositAmount: Math.round(recommendedPrice * 0.3 * 100) / 100,
    multiplier,
  };
}

function getBidHistoricalAverages(bid = {}) {
  const basis = bid.historical_basis || {};
  const averages = basis.averages || {};
  return {
    similarCount: Number(basis.similar_record_count ?? basis.similarRecordCount ?? 0),
    averageRevenue: Number(basis.average_revenue ?? averages.average_revenue ?? 0),
    averageCost: Number(basis.average_total_cost ?? averages.average_total_cost ?? 0),
    averageMargin: basis.average_margin_percent ?? averages.average_margin_percent ?? null,
    costPerSqft: basis.average_cost_per_square_foot ?? averages.cost_per_square_foot ?? null,
    targetMargin: basis.target_margin_percent ?? bid.desired_margin_percent ?? bid.projected_margin_percent ?? null,
    similarRecords: Array.isArray(basis.similar_records) ? basis.similar_records : [],
  };
}

function normalizeBidRiskFlags(flags = []) {
  return (Array.isArray(flags) ? flags : []).map((flag) => {
    if (typeof flag === "string") {
      const lower = flag.toLowerCase();
      const severity = /below minimum|below desired|limited|above historical|material-heavy/.test(lower)
        ? "medium"
        : "low";
      return { message: flag, severity };
    }
    return {
      message: flag?.message || flag?.label || "Review pricing risk",
      severity: ["low", "medium", "high"].includes(flag?.severity) ? flag.severity : "low",
      code: flag?.code || null,
    };
  });
}

function getRiskSeverityClass(severity) {
  if (severity === "high") return "border-rose-300/25 bg-rose-300/10 text-rose-100";
  if (severity === "medium") return "border-amber-300/25 bg-amber-300/10 text-amber-100";
  return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
}

function buildPricingExplanation(bid = {}, whatIf = {}) {
  const basis = getBidHistoricalAverages(bid);
  const averageMargin = basis.averageMargin !== null && basis.averageMargin !== undefined
    ? `${Number(basis.averageMargin || 0).toFixed(1)}%`
    : "limited margin history";
  const targetMargin = Number(whatIf.projectedMarginPercent || basis.targetMargin || 0);
  return `Bizzi estimated this using ${basis.similarCount} similar job${basis.similarCount === 1 ? "" : "s"}, average margin of ${averageMargin}, and target margin of ${targetMargin.toFixed(1)}%.`;
}

function isImageAttachment(attachment = {}) {
  const mimeType = String(attachment.mime_type || "").toLowerCase();
  const fileUrl = String(attachment.file_url || "").toLowerCase();
  return mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif)(\?|$)/i.test(fileUrl);
}

function BidDetailPanel({
  bid,
  businessId,
  usingDemo,
  onBack,
  onBidUpdated,
  onReloadRecent,
  onCopyProposal,
  onConvertToJob,
  copied,
  setError,
  setMessage,
}) {
  const [lineItems, setLineItems] = useState(() => toEditableBidLineItems(bid?.line_items));
  const [desiredMargin, setDesiredMargin] = useState(() => String(resolveBidMargin(bid)));
  const [proposalText, setProposalText] = useState(bid?.proposal_text || "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcomeBusy, setOutcomeBusy] = useState("");
  const [confirmConvert, setConfirmConvert] = useState(false);
  const [converting, setConverting] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [attachmentDeletingId, setAttachmentDeletingId] = useState("");
  const [attachmentNotes, setAttachmentNotes] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    setLineItems(toEditableBidLineItems(bid?.line_items));
    setDesiredMargin(String(resolveBidMargin(bid)));
    setProposalText(bid?.proposal_text || "");
    setDirty(false);
  }, [bid]);

  const loadAttachments = useCallback(async () => {
    if (!bid?.id || usingDemo) {
      setAttachments([]);
      setAttachmentsLoading(false);
      return;
    }
    setAttachmentsLoading(true);
    try {
      const rows = await fetchBidAttachments(bid.id, { businessId });
      setAttachments(rows);
    } catch (e) {
      setError(e?.message || "Could not load bid attachments.");
    } finally {
      setAttachmentsLoading(false);
    }
  }, [bid?.id, businessId, setError, usingDemo]);

  useEffect(() => {
    loadAttachments();
  }, [loadAttachments]);

  const whatIf = useMemo(() => calculateBidWhatIf(lineItems, Number(desiredMargin)), [desiredMargin, lineItems]);
  const historicalDisplay = useMemo(() => getBidHistoricalAverages(bid), [bid]);
  const normalizedRiskFlags = useMemo(() => normalizeBidRiskFlags(bid?.risk_flags), [bid]);
  const shownLineItems = useMemo(() => lineItems.map((item) => ({
    ...item,
    markup_percent: whatIf.multiplier > 0 ? Math.round((whatIf.multiplier - 1) * 10000) / 100 : null,
    selling_price: whatIf.multiplier > 0 ? Math.round(Number(item.total_cost || 0) * whatIf.multiplier * 100) / 100 : null,
  })), [lineItems, whatIf.multiplier]);

  const updateLineItem = useCallback((id, field, value) => {
    setLineItems((prev) => prev.map((item) => {
      if (String(item.id) !== String(id)) return item;
      const next = { ...item, [field]: value };
      if (field === "quantity" || field === "unit_cost") {
        const quantity = Math.max(0, Number(field === "quantity" ? value : next.quantity) || 0);
        const unitCost = Math.max(0, Number(field === "unit_cost" ? value : next.unit_cost) || 0);
        next.quantity = quantity;
        next.unit_cost = unitCost;
        next.total_cost = Math.round(quantity * unitCost * 100) / 100;
      }
      return next;
    }));
    setDirty(true);
  }, []);

  const updateMargin = useCallback((value) => {
    setDesiredMargin(value);
    setDirty(true);
  }, []);

  const updateProposal = useCallback((value) => {
    setProposalText(value);
    setDirty(true);
  }, []);

  const saveChanges = useCallback(async () => {
    if (!bid?.id) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = {
        desired_margin_percent: Number(desiredMargin) || null,
        proposal_text: proposalText,
        line_items: shownLineItems.map((item) => ({
          id: String(item.id).startsWith("line-") ? undefined : item.id,
          category: item.category,
          name: item.name,
          description: item.description || null,
          quantity: Number(item.quantity || 0),
          unit: item.unit || "allowance",
          unit_cost: Number(item.unit_cost || 0),
          total_cost: Number(item.total_cost || 0),
          markup_percent: item.markup_percent,
          selling_price: item.selling_price,
          source: item.source || "manual",
        })),
        recalculate: true,
      };
      if (usingDemo) {
        const updated = {
          ...bid,
          ...payload,
          line_items: shownLineItems,
          estimated_total_cost: whatIf.estimatedCost,
          recommended_price: whatIf.recommendedPrice,
          projected_margin_percent: whatIf.projectedMarginPercent,
          deposit_amount: whatIf.depositAmount,
          proposal_text: proposalText,
        };
        onBidUpdated(updated);
      } else {
        const updated = await updateBidEstimate(bid.id, { businessId, ...payload });
        onBidUpdated(updated || {
          ...bid,
          line_items: shownLineItems,
          estimated_total_cost: whatIf.estimatedCost,
          recommended_price: whatIf.recommendedPrice,
          projected_margin_percent: whatIf.projectedMarginPercent,
          deposit_amount: whatIf.depositAmount,
          proposal_text: proposalText,
        });
      }
      setDirty(false);
      setMessage("Bid changes saved.");
      await onReloadRecent?.();
    } catch (e) {
      setError(e?.message || "Could not save bid changes.");
    } finally {
      setSaving(false);
    }
  }, [bid, businessId, desiredMargin, onBidUpdated, onReloadRecent, proposalText, setError, setMessage, shownLineItems, usingDemo, whatIf]);

  const markOutcome = useCallback(async (outcome) => {
    if (!bid?.id) return;
    setOutcomeBusy(outcome);
    setError("");
    setMessage("");
    try {
      if (usingDemo) {
        const updated = { ...bid, status: outcome };
        onBidUpdated(updated);
        setMessage(`Bid marked ${outcome}.`);
      } else {
        const result = await saveBidOutcome(bid.id, {
          businessId,
          outcome,
          won_amount: outcome === "won" ? whatIf.recommendedPrice : undefined,
        });
        if (result?.bid) onBidUpdated(result.bid);
        setMessage(`Bid marked ${outcome}.`);
      }
      await onReloadRecent?.();
    } catch (e) {
      setError(e?.message || `Could not mark bid ${outcome}.`);
    } finally {
      setOutcomeBusy("");
    }
  }, [bid, businessId, onBidUpdated, onReloadRecent, setError, setMessage, usingDemo, whatIf.recommendedPrice]);

  const canConvert = ["won", "draft"].includes(String(bid?.status || "").toLowerCase()) && !bid?.converted_job_id;
  const confirmConvertToJob = useCallback(async () => {
    if (!bid?.id) return;
    setConverting(true);
    setError("");
    setMessage("");
    try {
      await onConvertToJob?.(bid);
      setConfirmConvert(false);
    } finally {
      setConverting(false);
    }
  }, [bid, onConvertToJob, setError, setMessage]);

  const handleAttachmentUpload = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file || !bid?.id) return;
    setAttachmentUploading(true);
    setError("");
    setMessage("");
    try {
      if (usingDemo) {
        const demoAttachment = {
          id: `attachment-${Date.now()}`,
          file_url: URL.createObjectURL(file),
          file_name: file.name,
          mime_type: file.type,
          notes: attachmentNotes || null,
          extraction_status: "not_started",
          created_at: new Date().toISOString(),
        };
        setAttachments((prev) => [demoAttachment, ...prev]);
      } else {
        const attachment = await uploadBidAttachment(bid.id, {
          businessId,
          file,
          notes: attachmentNotes,
        });
        if (attachment) setAttachments((prev) => [attachment, ...prev]);
      }
      setAttachmentNotes("");
      setMessage("Attachment added.");
    } catch (e) {
      setError(e?.message || "Could not upload bid attachment.");
    } finally {
      setAttachmentUploading(false);
      if (event.target) event.target.value = "";
    }
  }, [attachmentNotes, bid?.id, businessId, setError, setMessage, usingDemo]);

  const removeAttachment = useCallback(async (attachmentId) => {
    setAttachmentDeletingId(attachmentId);
    setError("");
    setMessage("");
    try {
      if (!usingDemo) {
        await deleteBidAttachment(attachmentId, { businessId });
      }
      setAttachments((prev) => prev.filter((attachment) => String(attachment.id) !== String(attachmentId)));
      setMessage("Attachment removed.");
    } catch (e) {
      setError(e?.message || "Could not delete bid attachment.");
    } finally {
      setAttachmentDeletingId("");
    }
  }, [businessId, setError, setMessage, usingDemo]);

  return (
    <div className="space-y-4">
      <section className={`${glass} p-4 sm:p-5`}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <button type="button" onClick={onBack} className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.05] text-white/70 transition hover:bg-white/[0.09]" aria-label="Back to Bid Builder">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/65">Bid detail</p>
              <h2 className="mt-1 truncate text-xl font-semibold text-white">{bid.bid_title}</h2>
              <p className="mt-1 text-sm text-white/45">{bid.customer_name || bid.prospect_name || "No customer"} • {bid.trade_type || "Unassigned trade"}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dirty ? <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs font-semibold text-amber-100">Unsaved changes</span> : null}
            <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-semibold text-emerald-100">{bid.status || "draft"}</span>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <BidBuilderMetric label="Recommended Price" value={money.format(whatIf.recommendedPrice)} tone="green" />
          <BidBuilderMetric label="Estimated Cost" value={money.format(whatIf.estimatedCost)} />
          <BidBuilderMetric label="Projected Margin" value={`${whatIf.projectedMarginPercent.toFixed(1)}%`} tone="green" />
          <BidBuilderMetric label="Deposit Amount" value={money.format(whatIf.depositAmount)} tone="amber" />
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[240px,1fr]">
          <label className="block rounded-[18px] bg-white/[0.04] p-4">
            <span className="text-xs font-medium uppercase tracking-[0.16em] text-white/40">Desired Margin %</span>
            <input type="number" min="1" max="94" value={desiredMargin} onChange={(e) => updateMargin(e.target.value)} className="mt-2 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" />
          </label>
          <div className="rounded-[18px] bg-white/[0.04] p-4">
            <h3 className="text-sm font-semibold text-white">What-if preview</h3>
            <p className="mt-1 text-sm text-white/50">Line item edits and margin changes update the preview locally before saving.</p>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1fr,0.9fr]">
        <section className={`${glass} p-4 sm:p-5`}>
          <div className="mb-4">
            <h2 className="text-base font-semibold text-white">Historical Basis</h2>
            <p className="mt-1 text-sm text-white/45">{buildPricingExplanation(bid, whatIf)}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-[16px] bg-white/[0.04] p-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">Similar Jobs</div>
              <div className="mt-1 text-lg font-semibold text-white">{historicalDisplay.similarCount}</div>
            </div>
            <div className="rounded-[16px] bg-white/[0.04] p-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">Avg Revenue</div>
              <div className="mt-1 text-lg font-semibold text-emerald-100">{money.format(historicalDisplay.averageRevenue)}</div>
            </div>
            <div className="rounded-[16px] bg-white/[0.04] p-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">Avg Cost</div>
              <div className="mt-1 text-lg font-semibold text-white">{money.format(historicalDisplay.averageCost)}</div>
            </div>
            <div className="rounded-[16px] bg-white/[0.04] p-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">Avg Margin</div>
              <div className="mt-1 text-lg font-semibold text-white">{historicalDisplay.averageMargin !== null && historicalDisplay.averageMargin !== undefined ? `${Number(historicalDisplay.averageMargin || 0).toFixed(1)}%` : "N/A"}</div>
            </div>
            <div className="rounded-[16px] bg-white/[0.04] p-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">Avg Cost / Sqft</div>
              <div className="mt-1 text-lg font-semibold text-white">{historicalDisplay.costPerSqft ? money.format(Number(historicalDisplay.costPerSqft)) : "N/A"}</div>
            </div>
          </div>
          <div className="mt-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/35">Similar job names</div>
            {historicalDisplay.similarRecords.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {historicalDisplay.similarRecords.slice(0, 6).map((record) => (
                  <span key={`${record.source}-${record.id}`} className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs font-semibold text-white/65">
                    {record.title || record.job_name || "Similar job"}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-white/45">No similar job names available.</p>
            )}
          </div>
        </section>

        <section className={`${glass} p-4 sm:p-5`}>
          <div className="mb-4">
            <h2 className="text-base font-semibold text-white">Risk Flags</h2>
            <p className="mt-1 text-sm text-white/45">Deterministic pricing checks from job history.</p>
          </div>
          {normalizedRiskFlags.length ? (
            <div className="space-y-2">
              {normalizedRiskFlags.map((flag, index) => (
                <div key={`${flag.code || flag.message}-${index}`} className={`rounded-[14px] border px-3 py-2 text-sm ${getRiskSeverityClass(flag.severity)}`}>
                  <div className="flex items-start justify-between gap-3">
                    <span>{flag.message}</span>
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] opacity-70">{flag.severity}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-[14px] border border-emerald-300/20 bg-emerald-300/10 px-3 py-3 text-sm text-emerald-100">No risk flags.</div>
          )}
        </section>
      </div>

      <section className={`${glass} overflow-hidden p-4 sm:p-5`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Editable line items</h2>
            <p className="text-xs text-white/45">Quantity and unit cost recalculate total cost immediately.</p>
          </div>
          <button type="button" onClick={saveChanges} disabled={!dirty || saving} className="rounded-[12px] bg-emerald-300 px-4 py-2 text-xs font-semibold text-zinc-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50">
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.16em] text-white/35">
              <tr className="border-b border-white/10">
                <th className="px-3 py-3">Category</th>
                <th className="px-3 py-3">Item</th>
                <th className="px-3 py-3 text-right">Quantity</th>
                <th className="px-3 py-3 text-right">Unit Cost</th>
                <th className="px-3 py-3 text-right">Total Cost</th>
                <th className="px-3 py-3 text-right">Markup / Selling Price</th>
              </tr>
            </thead>
            <tbody>
              {shownLineItems.map((item) => (
                <tr key={item.id} className="border-b border-white/7 last:border-0">
                  <td className="px-3 py-3"><input value={item.category} onChange={(e) => updateLineItem(item.id, "category", e.target.value)} className="w-32 rounded-[10px] border border-white/10 bg-black/20 px-2 py-1.5 text-white outline-none focus:border-emerald-300/50" /></td>
                  <td className="px-3 py-3"><input value={item.name} onChange={(e) => updateLineItem(item.id, "name", e.target.value)} className="w-48 rounded-[10px] border border-white/10 bg-black/20 px-2 py-1.5 text-white outline-none focus:border-emerald-300/50" /></td>
                  <td className="px-3 py-3 text-right"><input type="number" min="0" value={item.quantity} onChange={(e) => updateLineItem(item.id, "quantity", e.target.value)} className="ml-auto w-24 rounded-[10px] border border-white/10 bg-black/20 px-2 py-1.5 text-right text-white outline-none focus:border-emerald-300/50" /></td>
                  <td className="px-3 py-3 text-right"><input type="number" min="0" value={item.unit_cost} onChange={(e) => updateLineItem(item.id, "unit_cost", e.target.value)} className="ml-auto w-28 rounded-[10px] border border-white/10 bg-black/20 px-2 py-1.5 text-right text-white outline-none focus:border-emerald-300/50" /></td>
                  <td className="px-3 py-3 text-right font-semibold text-white">{money.format(Number(item.total_cost || 0))}</td>
                  <td className="px-3 py-3 text-right text-white/65">{item.markup_percent !== null && item.markup_percent !== undefined ? `${Number(item.markup_percent || 0).toFixed(1)}%` : "-"}{item.selling_price !== null && item.selling_price !== undefined ? ` / ${money.format(Number(item.selling_price || 0))}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`${glass} p-4 sm:p-5`}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Attachments / Site Photos</h2>
            <p className="mt-1 text-sm text-white/45">Attach site photos or files for bid context. Photo analysis coming soon.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input ref={fileInputRef} type="file" accept="image/*,.pdf" className="hidden" onChange={handleAttachmentUpload} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={attachmentUploading} className="inline-flex items-center gap-2 rounded-[12px] bg-emerald-300 px-3 py-2 text-xs font-semibold text-zinc-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60">
              <Upload className="h-3.5 w-3.5" />
              {attachmentUploading ? "Uploading..." : "Upload"}
            </button>
          </div>
        </div>

        <label className="mb-4 block">
          <span className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Notes for next upload</span>
          <input value={attachmentNotes} onChange={(e) => setAttachmentNotes(e.target.value)} placeholder="Optional context for the photo or file" className="mt-2 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-emerald-300/50" />
        </label>

        {attachmentsLoading ? (
          <div className="rounded-[16px] border border-white/10 bg-white/[0.04] px-4 py-5 text-sm text-white/55">Loading attachments...</div>
        ) : attachments.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="overflow-hidden rounded-[18px] border border-white/10 bg-black/20">
                {isImageAttachment(attachment) ? (
                  <a href={attachment.file_url} target="_blank" rel="noreferrer" className="block aspect-[4/3] bg-white/[0.04]">
                    <img src={attachment.file_url} alt={attachment.file_name || "Bid attachment"} className="h-full w-full object-cover" />
                  </a>
                ) : (
                  <a href={attachment.file_url} target="_blank" rel="noreferrer" className="flex aspect-[4/3] items-center justify-center bg-white/[0.04] text-white/50 transition hover:text-emerald-100">
                    <ImageIcon className="h-8 w-8" />
                  </a>
                )}
                <div className="space-y-2 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <a href={attachment.file_url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-sm font-semibold text-white transition hover:text-emerald-100">
                      {attachment.file_name || "Attachment"}
                    </a>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} disabled={attachmentDeletingId === attachment.id} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/45 transition hover:border-rose-300/30 hover:bg-rose-300/10 hover:text-rose-100 disabled:opacity-50" aria-label="Delete attachment">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {attachment.notes ? <p className="line-clamp-2 text-xs leading-5 text-white/45">{attachment.notes}</p> : null}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-white/30">
                    <span>{attachment.mime_type || "file"}</span>
                    <span>{attachment.extraction_status || "not_started"}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[16px] border border-white/10 bg-white/[0.04] px-4 py-5 text-sm text-white/50">
            No site photos attached yet.
          </div>
        )}
      </section>

      <section className={`${glass} p-4 sm:p-5`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Proposal text</h2>
            <p className="text-xs text-white/45">Editable client-facing draft.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={saveChanges} disabled={!dirty || saving} className="rounded-[12px] border border-white/12 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] disabled:opacity-50">{saving ? "Saving..." : "Save Changes"}</button>
            <button type="button" onClick={() => onCopyProposal(proposalText)} className="inline-flex items-center gap-2 rounded-[12px] bg-emerald-300 px-3 py-2 text-xs font-semibold text-zinc-950 transition hover:bg-emerald-200"><Copy className="h-3.5 w-3.5" />{copied ? "Copied" : "Copy Proposal"}</button>
            <button type="button" onClick={() => markOutcome("won")} disabled={Boolean(outcomeBusy)} className="rounded-[12px] border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-300/16 disabled:opacity-50">{outcomeBusy === "won" ? "Saving..." : "Mark Won"}</button>
            <button type="button" onClick={() => markOutcome("lost")} disabled={Boolean(outcomeBusy)} className="rounded-[12px] border border-rose-300/25 bg-rose-300/10 px-3 py-2 text-xs font-semibold text-rose-100 transition hover:bg-rose-300/16 disabled:opacity-50">{outcomeBusy === "lost" ? "Saving..." : "Mark Lost"}</button>
            {canConvert ? (
              <button type="button" onClick={() => setConfirmConvert(true)} className="rounded-[12px] border border-emerald-300/35 bg-emerald-300/16 px-3 py-2 text-xs font-semibold text-emerald-50 transition hover:bg-emerald-300/22">Convert to Job</button>
            ) : null}
          </div>
        </div>
        <textarea value={proposalText} onChange={(e) => updateProposal(e.target.value)} rows={7} className="w-full resize-none rounded-[16px] border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none transition focus:border-emerald-300/50" />
      </section>

      {confirmConvert ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[24px] border border-white/10 bg-zinc-950 p-5 shadow-[0_28px_80px_rgba(0,0,0,0.55)]">
            <h2 className="text-lg font-semibold text-white">Create an active job bucket from this bid?</h2>
            <p className="mt-2 text-sm leading-6 text-white/55">
              This will add the bid as an active job in Job Costing. It will not assign transactions or create invoices.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setConfirmConvert(false)} disabled={converting} className="rounded-[12px] border border-white/12 bg-white/[0.05] px-4 py-2 text-sm font-semibold text-white/70 transition hover:bg-white/[0.09] disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={confirmConvertToJob} disabled={converting} className="rounded-[12px] bg-emerald-300 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-200 disabled:opacity-60">
                {converting ? "Creating..." : "Convert to Job"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function JobsFeatureComingSoon({ title }) {
  return (
    <div className="w-full px-3 pb-28 pt-0 md:px-4">
      <div className="mx-auto max-w-[1180px] space-y-4">
        <ModuleHeader
          module="jobs"
          title={title}
          subtitle="This workspace is not available yet."
        />
        <section className={`${glass} p-5 sm:p-6`} aria-label={`${title} coming soon`}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-emerald-200/65">Coming Soon!</p>
              <h2 className="mt-2 text-xl font-semibold text-white">{title} is still being built</h2>
              <p className="mt-2 max-w-2xl text-sm text-white/55">
                This tab will unlock once the workflow is ready. Use Collections and Job Costing for now.
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-white/55">
              Coming Soon!
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

function BidBuilderPage({ businessId, usingDemo }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { bidId: routeBidId } = useParams();
  const [form, setForm] = useState(emptyBidForm);
  const [recentBids, setRecentBids] = useState([]);
  const [currentBid, setCurrentBid] = useState(null);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [loadingDetailId, setLoadingDetailId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const bidBuilderBasePath = useMemo(
    () => location.pathname.replace(/\/bid-builder(?:\/[^/?#]+)?$/, "/bid-builder"),
    [location.pathname]
  );
  const requestedBidId = useMemo(() => {
    const queryBidId = new URLSearchParams(location.search).get("bid_id");
    return queryBidId || routeBidId || "";
  }, [location.search, routeBidId]);

  const updateField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const loadRecentBids = useCallback(async () => {
    if (usingDemo) {
      setRecentBids(demoRecentBids);
      setLoadingRecent(false);
      return;
    }
    if (!businessId) {
      setLoadingRecent(false);
      return;
    }
    setLoadingRecent(true);
    try {
      const bids = await listBidEstimates({ businessId, limit: 8 });
      setRecentBids(bids);
    } catch (e) {
      console.warn("[BidBuilder] recent bids failed", e?.message || e);
      setError(e?.message || "Could not load recent bids.");
    } finally {
      setLoadingRecent(false);
    }
  }, [businessId, usingDemo]);

  useEffect(() => {
    loadRecentBids();
  }, [loadRecentBids]);

  const submit = useCallback(async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    setCopied(false);
    if (!form.bid_title.trim()) {
      setError("Bid Title is required.");
      return;
    }
    if (!form.scope_description.trim()) {
      setError("Scope Description is required.");
      return;
    }
    setGenerating(true);
    try {
      if (usingDemo) {
        const demoBid = buildDemoBidFromForm(form);
        setCurrentBid(demoBid);
        setRecentBids((prev) => [demoBid, ...prev].slice(0, 8));
        setMessage("Demo bid generated.");
        return;
      }
      const bid = await generateBidEstimateRequest({
        businessId,
        bid_title: form.bid_title,
        customer_name: form.customer_name,
        prospect_name: form.customer_name,
        job_type: form.job_type,
        trade_type: form.trade_type,
        scope_description: form.scope_description,
        square_footage: form.square_footage,
        desired_margin_percent: form.desired_margin_percent,
        minimum_margin_percent: form.minimum_margin_percent,
      });
      setCurrentBid(bid);
      if (bid?.id) {
        navigate(`${bidBuilderBasePath}?bid_id=${encodeURIComponent(bid.id)}`, { replace: true });
      }
      setMessage("Bid generated and saved.");
      await loadRecentBids();
    } catch (e) {
      setError(e?.message || "Could not generate bid.");
    } finally {
      setGenerating(false);
    }
  }, [bidBuilderBasePath, businessId, form, loadRecentBids, navigate, usingDemo]);

  const openBid = useCallback(async (bid) => {
    if (!bid?.id) return;
    setError("");
    setMessage("");
    navigate(`${bidBuilderBasePath}?bid_id=${encodeURIComponent(bid.id)}`, { replace: false });
    if (usingDemo) {
      setCurrentBid(buildDemoBidFromForm({
        ...emptyBidForm,
        bid_title: bid.bid_title,
        customer_name: bid.customer_name || bid.prospect_name || "",
        job_type: bid.job_type || "",
        trade_type: bid.trade_type || "",
        scope_description: "Demo scope for saved bid detail.",
      }));
      return;
    }
    setLoadingDetailId(bid.id);
    try {
      const detail = await getBidEstimate({ businessId, bidId: bid.id });
      setCurrentBid(detail);
    } catch (e) {
      setError(e?.message || "Could not open bid detail.");
    } finally {
      setLoadingDetailId("");
    }
  }, [bidBuilderBasePath, businessId, navigate, usingDemo]);

  useEffect(() => {
    if (!requestedBidId || usingDemo || !businessId || String(currentBid?.id || "") === String(requestedBidId)) return;
    let cancelled = false;
    setLoadingDetailId(requestedBidId);
    setError("");
    getBidEstimate({ businessId, bidId: requestedBidId })
      .then((detail) => {
        if (!cancelled) setCurrentBid(detail);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "Could not open bid detail.");
      })
      .finally(() => {
        if (!cancelled) setLoadingDetailId("");
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, currentBid?.id, requestedBidId, usingDemo]);

  const convertCurrentBidToJob = useCallback(async (bid) => {
    if (!bid?.id) return;
    setError("");
    setMessage("");
    try {
      const demoJobId = `demo-job-from-bid-${Date.now()}`;
      const result = usingDemo
        ? {
            job: {
              id: demoJobId,
              job_name: bid.bid_title,
              customer_name: bid.customer_name || bid.prospect_name || "",
              trade_type: bid.trade_type || "",
              status: "active",
            },
            bid: { ...bid, status: "converted", converted_job_id: demoJobId, converted_at: new Date().toISOString() },
          }
        : await convertBidToJob(bid.id, { businessId });
      if (result?.bid) setCurrentBid(result.bid);
      setMessage("Bid converted to an active job.");
      await loadRecentBids();
      const jobId = result?.job?.id || result?.bid?.converted_job_id;
      const base = location.pathname.startsWith("/dashboard/jobs") ? "/dashboard/jobs" : "/dashboard/leads-jobs";
      navigate(`${base}/job-costing${jobId ? `?job_id=${encodeURIComponent(jobId)}` : ""}`);
    } catch (e) {
      setError(e?.message || "Could not convert bid to job.");
      throw e;
    }
  }, [businessId, loadRecentBids, location.pathname, navigate, usingDemo]);

  return (
    <div className="w-full px-3 pb-28 pt-0 md:px-4">
      <div className="mx-auto max-w-[1180px] space-y-4">
        <ModuleHeader module="jobs" title="Bid Builder" subtitle="Create profitable bids from your real job history." />

        {error ? <div className="rounded-[18px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">{error}</div> : null}
        {message ? <div className="rounded-[18px] border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">{message}</div> : null}

        <div className="grid gap-4 xl:grid-cols-[390px,1fr]">
          <div className="space-y-4">
            <form onSubmit={submit} className={`${glass} p-4 sm:p-5`}>
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-[14px] bg-emerald-300/12 text-emerald-100"><Wand2 className="h-4 w-4" /></div>
                <div>
                  <h2 className="text-base font-semibold text-white">New bid</h2>
                  <p className="text-xs text-white/45">Scope, margin, and job context.</p>
                </div>
              </div>
              <div className="space-y-3">
                <label className="block"><span className="text-xs font-medium text-white/55">Bid Title</span><input value={form.bid_title} onChange={(e) => updateField("bid_title", e.target.value)} className="mt-1 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" /></label>
                <label className="block"><span className="text-xs font-medium text-white/55">Customer / Prospect Name</span><input value={form.customer_name} onChange={(e) => updateField("customer_name", e.target.value)} className="mt-1 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" /></label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block"><span className="text-xs font-medium text-white/55">Job Type</span><input value={form.job_type} onChange={(e) => updateField("job_type", e.target.value)} className="mt-1 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" /></label>
                  <label className="block"><span className="text-xs font-medium text-white/55">Trade Type</span><input value={form.trade_type} onChange={(e) => updateField("trade_type", e.target.value)} className="mt-1 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" /></label>
                </div>
                <label className="block"><span className="text-xs font-medium text-white/55">Scope Description</span><textarea value={form.scope_description} onChange={(e) => updateField("scope_description", e.target.value)} rows={5} className="mt-1 w-full resize-none rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" /></label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block"><span className="text-xs font-medium text-white/55">Square Footage</span><input type="number" min="0" value={form.square_footage} onChange={(e) => updateField("square_footage", e.target.value)} className="mt-1 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" /></label>
                  <label className="block"><span className="text-xs font-medium text-white/55">Desired Margin %</span><input type="number" min="0" max="94" value={form.desired_margin_percent} onChange={(e) => updateField("desired_margin_percent", e.target.value)} className="mt-1 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" /></label>
                  <label className="block"><span className="text-xs font-medium text-white/55">Minimum Margin %</span><input type="number" min="0" max="94" value={form.minimum_margin_percent} onChange={(e) => updateField("minimum_margin_percent", e.target.value)} className="mt-1 w-full rounded-[14px] border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-300/50" /></label>
                </div>
                <button type="submit" disabled={generating} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[14px] bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60">
                  <Wand2 className={generating ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
                  {generating ? "Generating bid from job history..." : "Generate Bid"}
                </button>
              </div>
            </form>

            <section className={`${glass} p-4 sm:p-5`}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div><h2 className="text-base font-semibold text-white">Recent bids</h2><p className="text-xs text-white/45">Saved pricing drafts and outcomes.</p></div>
                {loadingRecent ? <RefreshCcw className="h-4 w-4 animate-spin text-white/40" /> : null}
              </div>
              {recentBids.length ? (
                <div className="space-y-2">
                  {recentBids.map((bid) => (
                    <button key={bid.id} type="button" onClick={() => openBid(bid)} className="w-full rounded-[16px] bg-white/[0.04] px-3 py-3 text-left transition hover:bg-white/[0.07]">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><div className="truncate text-sm font-semibold text-white">{bid.bid_title}</div><div className="mt-1 truncate text-xs text-white/45">{bid.customer_name || bid.prospect_name || "No customer"} • {formatDate(bid.created_at)}</div></div>
                        <span className="rounded-full bg-white/[0.07] px-2 py-1 text-[11px] font-semibold text-white/60">{bid.status || "draft"}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs"><span className="font-semibold text-emerald-100">{money.format(Number(bid.recommended_price || 0))}</span><span className="text-white/45">{Number(bid.projected_margin_percent || 0).toFixed(1)}% margin</span></div>
                      {loadingDetailId === bid.id ? <div className="mt-2 text-xs text-emerald-100">Opening bid...</div> : null}
                    </button>
                  ))}
                </div>
              ) : <div className="rounded-[16px] border border-dashed border-white/12 bg-black/15 px-4 py-6 text-center text-sm text-white/50">No bids yet.</div>}
            </section>
          </div>

          <div className="space-y-4">
            {generating ? <SkeletonCard lines={7} className="min-h-[360px]" /> : currentBid ? (
              <>
                <BidDetailPanel
                  bid={currentBid}
                  businessId={businessId}
                  usingDemo={usingDemo}
                  onBack={() => {
                    setCurrentBid(null);
                    setCopied(false);
                    setMessage("");
                    setError("");
                    navigate(bidBuilderBasePath, { replace: true });
                  }}
                  onBidUpdated={setCurrentBid}
                  onReloadRecent={loadRecentBids}
                  copied={copied}
                  setError={setError}
                  setMessage={setMessage}
                  onConvertToJob={convertCurrentBidToJob}
                  onCopyProposal={async (text) => {
                    try {
                      if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(text || "");
                      } else {
                        const el = document.createElement("textarea");
                        el.value = text || "";
                        el.setAttribute("readonly", "");
                        el.style.position = "fixed";
                        el.style.opacity = "0";
                        document.body.appendChild(el);
                        el.select();
                        document.execCommand("copy");
                        document.body.removeChild(el);
                      }
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1600);
                    } catch {
                      setError("Could not copy proposal text.");
                    }
                  }}
                />
              </>
            ) : (
              <section className={`${glass} flex min-h-[520px] items-center justify-center p-6 text-center`}>
                <div className="max-w-md"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[18px] bg-emerald-300/12 text-emerald-100"><Wand2 className="h-5 w-5" /></div><h2 className="mt-4 text-xl font-semibold text-white">No bids yet</h2><p className="mt-2 text-sm text-white/50">Generate a bid to see recommended pricing, cost breakdowns, risk flags, and proposal copy.</p></div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChangeOrdersPage({ businessId, usingDemo }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [changeOrders, setChangeOrders] = useState([]);
  const [potentialChangeOrders, setPotentialChangeOrders] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState("");

  const loadChangeOrders = useCallback(async () => {
    if (usingDemo) {
      setChangeOrders([]);
      setPotentialChangeOrders([]);
      setJobs(buildDemoJobCostingJobs(demoJobCostingTransactions));
      setLoading(false);
      return;
    }
    if (!businessId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [changeOrderData, potentialData, summary] = await Promise.all([
        safeFetch(apiUrl(`/api/job-costing/change-orders?business_id=${encodeURIComponent(businessId)}&limit=300`)),
        safeFetch(apiUrl(`/api/job-costing/potential-change-orders?business_id=${encodeURIComponent(businessId)}&limit=150`)),
        safeFetch(apiUrl(`/api/job-costing/jobs/summary?business_id=${encodeURIComponent(businessId)}`)),
      ]);
      setChangeOrders(Array.isArray(changeOrderData?.change_orders) ? changeOrderData.change_orders : []);
      setPotentialChangeOrders(Array.isArray(potentialData?.potential_change_orders) ? potentialData.potential_change_orders : []);
      setJobs(filterActiveUiJobs(Array.isArray(summary?.jobs) ? summary.jobs : []));
    } catch (e) {
      console.warn("[ChangeOrdersPage] load failed", e?.message || e);
      setError(e?.message || "Failed to load change orders.");
    } finally {
      setLoading(false);
    }
  }, [businessId, usingDemo]);

  useEffect(() => {
    loadChangeOrders();
  }, [loadChangeOrders]);

  const updateChangeOrder = useCallback(async (order, patch) => {
    if (!order?.id) return null;
    setBusyId(`${order.id}:${patch.status || "update"}`);
    setMessage("");
    try {
      if (usingDemo) {
        setChangeOrders((prev) => prev.map((candidate) => String(candidate.id) === String(order.id)
          ? { ...candidate, ...patch, updated_at: new Date().toISOString() }
          : candidate));
        setMessage("Change order updated.");
        return null;
      }
      const data = await safeFetch(apiUrl(`/api/job-costing/change-orders/${encodeURIComponent(order.id)}`), {
        method: "PATCH",
        body: { business_id: businessId, ...patch },
      });
      setMessage("Change order updated.");
      await loadChangeOrders();
      return data?.change_order || null;
    } catch (e) {
      setError(e?.message || "Could not update change order.");
      return null;
    } finally {
      setBusyId("");
    }
  }, [businessId, loadChangeOrders, usingDemo]);

  const convertPotentialChangeOrder = useCallback(async (suggestion) => {
    if (!suggestion?.id) return;
    setBusyId(`${suggestion.id}:convert`);
    setMessage("");
    try {
      if (usingDemo) {
        setPotentialChangeOrders((prev) => prev.filter((item) => String(item.id) !== String(suggestion.id)));
      } else {
        await safeFetch(apiUrl(`/api/job-costing/potential-change-orders/${encodeURIComponent(suggestion.id)}/convert`), {
          method: "POST",
          body: { business_id: businessId },
        });
        await loadChangeOrders();
      }
      setMessage("Potential change order converted.");
    } catch (e) {
      setError(e?.message || "Could not create change order.");
    } finally {
      setBusyId("");
    }
  }, [businessId, loadChangeOrders, usingDemo]);

  const dismissPotentialChangeOrder = useCallback(async (suggestion) => {
    if (!suggestion?.id) return;
    setBusyId(`${suggestion.id}:dismiss`);
    setMessage("");
    try {
      if (!usingDemo) {
        await safeFetch(apiUrl(`/api/job-costing/potential-change-orders/${encodeURIComponent(suggestion.id)}/dismiss`), {
          method: "POST",
          body: { business_id: businessId },
        });
      }
      setPotentialChangeOrders((prev) => prev.filter((item) => String(item.id) !== String(suggestion.id)));
      setMessage("Potential change order dismissed.");
    } catch (e) {
      setError(e?.message || "Could not dismiss suggestion.");
    } finally {
      setBusyId("");
    }
  }, [businessId, usingDemo]);

  const openJobCosting = useCallback(() => {
    const base = location.pathname.startsWith("/dashboard/jobs") ? "/dashboard/jobs" : "/dashboard/leads-jobs";
    navigate(`${base}/job-costing`);
  }, [location.pathname, navigate]);

  const sortedOrders = changeOrders.slice().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  const openOrders = sortedOrders.filter((order) => ["proposed", "client_approved", "billed"].includes(String(order.status || "")));

  return (
    <div className="w-full px-3 pb-24 pt-0 md:px-4">
      <div className="mx-auto max-w-[1180px] space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <ModuleHeader
            module="jobs"
            title="Change Orders"
            subtitle="Track extra work, follow-ups, and unbilled change order money."
          />
          <button
            type="button"
            onClick={loadChangeOrders}
            disabled={loading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border text-white/85 transition hover:bg-white/14 hover:border-white/50 focus:outline-none focus:ring-2 focus:ring-white/14 disabled:opacity-60"
            style={{ borderColor: "rgba(255,255,255,0.22)", background: "rgba(18,18,20,0.86)" }}
            aria-label="Refresh change orders"
            title="Refresh"
          >
            <RefreshCcw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          </button>
        </div>

        {error ? (
          <div className="rounded-[18px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">{error}</div>
        ) : null}
        {message ? (
          <div className="rounded-[18px] border border-emerald-300/25 bg-emerald-300/10 px-4 py-3 text-sm font-medium text-emerald-100">{message}</div>
        ) : null}

        <ChangeOrderOverview changeOrders={changeOrders} loading={loading} onStatusChange={updateChangeOrder} />
        <ChangeOrderFollowUpCard changeOrders={changeOrders} jobs={jobs} onViewJob={openJobCosting} />

        <section className="overflow-hidden rounded-[22px] border border-white/10 bg-black/20" aria-label="All change orders">
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
            <div>
              <h2 className="text-lg font-semibold text-white">All Change Orders</h2>
              <p className="mt-1 text-sm text-white/45">{openOrders.length} open • {changeOrders.length} total</p>
            </div>
            <button type="button" onClick={openJobCosting} className="rounded-full border border-emerald-300/35 bg-emerald-300/12 px-4 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-300/18">
              Open Job Costing
            </button>
          </div>
          {loading ? (
            <div className="border-t border-white/8 p-4"><SkeletonCard lines={4} /></div>
          ) : sortedOrders.length ? (
            <div className="custom-scrollbar overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="border-y border-white/8 text-[11px] uppercase tracking-[0.12em] text-white/40">
                  <tr>
                    <th className="px-4 py-3 font-medium">Job</th>
                    <th className="px-4 py-3 font-medium">Title</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Estimated Cost</th>
                    <th className="px-4 py-3 text-right font-medium">Proposed</th>
                    <th className="px-4 py-3 text-right font-medium">Billed / Paid</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  {sortedOrders.map((order) => {
                    const statusMeta = getChangeOrderStatusMeta(order.status);
                    const action = getOverviewChangeOrderAction(order);
                    return (
                      <tr key={order.id} className="hover:bg-white/[0.03]">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-white/85">{order.job_name || "Job"}</div>
                          <div className="mt-0.5 text-xs text-white/40">{order.customer_name || ""}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-white/80">{order.title || "Untitled change order"}</div>
                          <div className="mt-0.5 line-clamp-1 text-xs text-white/42">{order.description}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusMeta.className}`}>{statusMeta.label}</span>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-rose-100">{money.format(Number(order.estimated_cost || 0))}</td>
                        <td className="px-4 py-3 text-right font-semibold text-emerald-100">{money.format(Number(order.proposed_price || 0))}</td>
                        <td className="px-4 py-3 text-right text-white/65">{money.format(Number(order.billed_amount || 0))} / {money.format(Number(order.paid_amount || 0))}</td>
                        <td className="px-4 py-3 text-white/55">{formatDate(order.created_at)}</td>
                        <td className="px-4 py-3 text-right">
                          {action ? (
                            <button
                              type="button"
                              onClick={() => updateChangeOrder(order, getChangeOrderStatusPatch(order, action.status))}
                              disabled={busyId === `${order.id}:${action.status}`}
                              className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/18 disabled:opacity-50"
                            >
                              {busyId === `${order.id}:${action.status}` ? "Saving..." : action.label}
                            </button>
                          ) : (
                            <span className="text-xs text-white/35">{getChangeOrderTerminalHint(order.status)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="border-t border-white/8 px-4 py-8 text-sm text-white/55">No change orders logged yet.</div>
          )}
        </section>

        <section className="overflow-hidden rounded-[22px] border border-amber-300/15 bg-amber-300/[0.045]" aria-label="Potential change orders">
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Potential Change Orders</h2>
              <p className="mt-1 text-sm text-white/45">Suggestions only. Nothing is logged until you create one.</p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs text-white/55">{potentialChangeOrders.length} pending</span>
          </div>
          {loading ? (
            <div className="border-t border-white/8 p-4"><SkeletonCard lines={3} /></div>
          ) : potentialChangeOrders.length ? (
            <div className="grid gap-3 border-t border-white/8 p-4">
              {potentialChangeOrders.map((suggestion) => (
                <div key={suggestion.id} className="rounded-[18px] border border-white/10 bg-black/20 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-white">{suggestion.title || "Potential change order"}</h3>
                        <span className="rounded-full border border-amber-200/25 bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-100">{Math.round(Number(suggestion.confidence_score || 0))}% confidence</span>
                      </div>
                      <p className="mt-2 text-sm leading-5 text-white/58">{suggestion.explanation}</p>
                      <p className="mt-1 text-xs text-white/40">{suggestion.job_name || "Job"}</p>
                    </div>
                    <div className="grid min-w-[220px] grid-cols-2 gap-2 text-sm">
                      <div className="rounded-[14px] border border-white/10 bg-white/[0.04] p-3">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">Extra Cost</div>
                        <div className="mt-1 font-semibold text-rose-100">{money.format(Number(suggestion.estimated_extra_cost || 0))}</div>
                      </div>
                      <div className="rounded-[14px] border border-white/10 bg-white/[0.04] p-3">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">Suggested Price</div>
                        <div className="mt-1 font-semibold text-emerald-100">{money.format(Number(suggestion.suggested_price || 0))}</div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={() => convertPotentialChangeOrder(suggestion)} disabled={busyId === `${suggestion.id}:convert`} className="rounded-full border border-emerald-300/35 bg-emerald-300/12 px-3 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/18 disabled:opacity-55">
                      {busyId === `${suggestion.id}:convert` ? "Creating..." : "Create Change Order"}
                    </button>
                    <button type="button" onClick={() => dismissPotentialChangeOrder(suggestion)} disabled={busyId === `${suggestion.id}:dismiss`} className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/65 hover:bg-white/[0.09] disabled:opacity-55">
                      {busyId === `${suggestion.id}:dismiss` ? "Dismissing..." : "Dismiss"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="border-t border-white/8 px-4 py-8 text-sm text-white/55">No potential change orders flagged.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function JobCostingDrawer({ open, title, eyebrow, onClose, children, widthClass = "max-w-[720px]" }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  const close = useCallback(() => {
    setVisible(false);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setMounted(false);
      onClose?.();
    }, 220);
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      if (mounted) close();
      return undefined;
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setMounted(true);
    const frame = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [close, mounted, open]);

  useEffect(() => {
    if (!mounted) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, mounted]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[92] flex justify-end bg-black/55 backdrop-blur-sm transition-opacity duration-200 ease-out ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`h-full w-full ${widthClass} overflow-hidden border-l border-emerald-300/18 bg-[#111713]/95 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl transition-all duration-200 ease-out ${
          visible ? "translate-x-0 opacity-100" : "translate-x-6 opacity-0"
        }`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/8 px-5 py-4">
          <div className="min-w-0">
            {eyebrow ? <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-200/70">{eyebrow}</p> : null}
            <h2 className="mt-1 truncate text-lg font-semibold text-white">{title}</h2>
          </div>
          <button
            type="button"
            onClick={close}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-white/70 transition hover:border-emerald-300/30 hover:bg-emerald-300/10 hover:text-white"
            aria-label={`Close ${title}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="custom-scrollbar h-[calc(100%-65px)] overflow-y-auto px-5 py-4">
          {children}
        </div>
      </aside>
    </div>,
    document.body
  );
}

function JobCostingModal({ open, title, eyebrow, onClose, children, widthClass = "max-w-[560px]" }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  const close = useCallback(() => {
    setVisible(false);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setMounted(false);
      onClose?.();
    }, 180);
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      if (mounted) close();
      return undefined;
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setMounted(true);
    const frame = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [close, mounted, open]);

  useEffect(() => {
    if (!mounted) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, mounted]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`fixed bottom-0 left-0 right-0 top-0 z-[96] flex items-center justify-center bg-black/60 px-4 pb-[220px] pt-6 backdrop-blur-sm transition-opacity duration-300 ease-out md:left-[var(--nav-w,0px)] sm:pt-[5vh] ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[calc(100vh-260px)] w-full ${widthClass} overflow-hidden rounded-[24px] border border-emerald-300/18 bg-[#111713]/95 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-4 scale-[0.96] opacity-0"
        }`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/8 px-5 py-4">
          <div className="min-w-0">
            {eyebrow ? <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-200/70">{eyebrow}</p> : null}
            <h2 className="mt-1 truncate text-lg font-semibold text-white">{title}</h2>
          </div>
          <button
            type="button"
            onClick={close}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-white/70 transition hover:border-emerald-300/30 hover:bg-emerald-300/10 hover:text-white"
            aria-label={`Close ${title}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="custom-scrollbar max-h-[calc(100vh-325px)] overflow-y-auto px-5 py-4">
          {children}
        </div>
      </section>
    </div>,
    document.body
  );
}

function RevenueDetailDrawer({ job, onClose }) {
  const basis = getJobRevenueBasisView(job || {});
  const rows = getRevenueWaterfallRows(job || {});
  const documents = Array.isArray(job?.revenue_documents) ? job.revenue_documents : [];
  const payments = Array.isArray(job?.payment_records) ? job.payment_records : Array.isArray(job?.payments) ? job.payments : [];
  const evidence = Array.isArray(job?.revenue_evidence) ? job.revenue_evidence : Array.isArray(job?.evidence) ? job.evidence : [];
  const sources = [...documents, ...payments, ...evidence];
  const [activeSource, setActiveSource] = useState(null);
  const activeSourceView = activeSource ? normalizeRevenueSourceRecordView(activeSource) : null;
  return (
    <JobCostingDrawer open={Boolean(job)} title={job?.jobName || job?.job_name || "Job revenue"} eyebrow="Revenue detail" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-[18px] border border-emerald-300/16 bg-emerald-300/[0.055] p-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/70">Selected job-costing basis</div>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-base font-semibold text-white">{basis.label}</div>
              <div className="mt-1 text-xs text-white/45">Margin and card revenue are based on this source.</div>
            </div>
            <div className="text-2xl font-black text-emerald-100">{money.format(basis.amount)}</div>
          </div>
        </div>

        <div className="overflow-hidden rounded-[18px] border border-white/10 bg-black/18">
          {rows.map((row) => (
            <div
              key={row.key}
              className={`grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-white/6 px-4 py-3 last:border-b-0 ${
                row.selected ? "bg-emerald-300/[0.06]" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white/85">{row.label}</div>
                <div className="mt-0.5 text-[11px] text-white/38">{row.sourceKey === "selected" ? basis.sourceStatus : row.sourceKey}</div>
              </div>
              <div className={`font-semibold ${row.inverse ? "text-rose-100" : "text-white"}`}>{row.inverse ? "-" : ""}{money.format(row.amount)}</div>
              <button
                type="button"
                onClick={() => {
                  const source = sources.find((item) => {
                    const view = normalizeRevenueSourceRecordView(item);
                    return row.sourceKey === "payments"
                      ? view.type === "payment"
                      : row.sourceKey === "credit_memos"
                        ? view.type === "credit_memo"
                        : row.sourceKey === "invoices"
                          ? ["invoice", "sales_receipt"].includes(view.type)
                          : row.sourceKey === "contracts"
                            ? view.type === "estimate"
                            : ["bank_evidence", "source"].includes(view.type);
                  }) || sources[0] || null;
                  setActiveSource(source);
                }}
                disabled={!sources.length}
                className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-white/55 transition hover:border-emerald-300/25 hover:bg-emerald-300/[0.08] hover:text-emerald-50"
              >
                Sources
              </button>
            </div>
          ))}
        </div>

        <div className="rounded-[18px] border border-white/10 bg-white/[0.035] p-4">
          <div className="text-sm font-semibold text-white">Source documents</div>
          <div className="mt-3 grid gap-2">
            {documents.length ? documents.slice(0, 8).map((doc) => (
              <div key={doc.id || doc.external_document_id || doc.document_number} className="flex items-center justify-between gap-3 rounded-[14px] border border-white/8 bg-black/18 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-white/82">{doc.document_number || doc.source_document_type || "Source document"}</div>
                  <div className="truncate text-xs text-white/42">{doc.source_document_type || doc.document_type || "Revenue document"} · {formatDate(doc.date || doc.document_date)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="font-semibold text-white">{money.format(Number(doc.total_amount || doc.amount || 0))}</div>
                  <button type="button" onClick={() => setActiveSource(doc)} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-white/55 transition hover:border-emerald-300/25 hover:bg-emerald-300/[0.08] hover:text-emerald-50">
                    Detail
                  </button>
                </div>
              </div>
            )) : (
              <div className="rounded-[14px] border border-white/8 bg-black/18 px-3 py-4 text-sm text-white/50">
                Source documents will appear here after canonical QBO sync links them to this job.
              </div>
            )}
          </div>
        </div>
        {activeSourceView ? (
          <div className="rounded-[18px] border border-emerald-300/16 bg-emerald-300/[0.055] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/70">{activeSourceView.title}</div>
                <div className="mt-1 text-sm font-semibold text-white">{activeSourceView.displayId}</div>
                <div className="mt-1 text-xs text-white/45">{formatDate(activeSourceView.date)} · {activeSourceView.sourceSystem}</div>
              </div>
              <button type="button" onClick={() => setActiveSource(null)} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-white/55">Close</button>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-[12px] bg-black/18 p-2.5"><div className="text-[9px] uppercase tracking-wide text-white/35">Amount</div><div className="mt-0.5 font-semibold text-white">{money.format(activeSourceView.amount)}</div></div>
              <div className="rounded-[12px] bg-black/18 p-2.5"><div className="text-[9px] uppercase tracking-wide text-white/35">Status</div><div className="mt-0.5 font-semibold text-white">{activeSourceView.status || "Recorded"}</div></div>
              <div className="rounded-[12px] bg-black/18 p-2.5"><div className="text-[9px] uppercase tracking-wide text-white/35">Type</div><div className="mt-0.5 font-semibold text-white">{activeSourceView.type.replace(/_/g, " ")}</div></div>
            </div>
            {activeSourceView.explanation ? <p className="mt-3 text-xs leading-5 text-white/55">{activeSourceView.explanation}</p> : null}
          </div>
        ) : null}
      </div>
    </JobCostingDrawer>
  );
}

class SuggestedJobCardBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    if (import.meta.env?.DEV) {
      console.error("[job-costing.suggested-job-card]", {
        candidate_id: this.props.candidateId || null,
        message: error?.message || "render_failed",
      });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <article className="flex h-[318px] w-[340px] shrink-0 items-center justify-center rounded-[18px] border border-amber-300/18 bg-amber-300/[0.055] p-4 text-center text-sm font-semibold text-amber-50/75">
          Unable to display this suggested job.
        </article>
      );
    }
    return this.props.children;
  }
}

function CandidateBucketCard({ candidate, jobs = [], busyId, onApproveNew, onLinkExisting, onDismiss, onMerge, readOnly = false }) {
  const firstMatch = candidate.possibleMatches?.[0] || null;
  const matchJobId = firstMatch?.job_id || firstMatch?.id || jobs?.[0]?.id || "";
  const busy = busyId === candidate.id;
  return (
    <article className={`group flex h-[318px] w-[340px] shrink-0 flex-col rounded-[18px] border border-amber-300/22 bg-[linear-gradient(135deg,rgba(251,191,36,0.08),rgba(16,185,129,0.045)_58%,rgba(255,255,255,0.025))] p-3.5 shadow-[0_18px_42px_rgba(0,0,0,0.26)] transition-all duration-300 ease-out hover:border-amber-200/35 ${
      busy ? "scale-[0.98] opacity-55" : "scale-100 opacity-100"
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileSearch className="h-3.5 w-3.5 shrink-0 text-amber-100/75" />
            <h3 className="truncate text-sm font-semibold text-white">{candidate.name}</h3>
          </div>
          <div className="mt-1 truncate text-xs font-medium text-white/52">{candidate.customer}</div>
          {candidate.address ? <div className="mt-0.5 truncate text-[11px] text-white/36">{candidate.address}</div> : null}
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${candidate.confidence >= 80 ? compactBadgeClass("emerald") : compactBadgeClass("amber")}`}>
          {Math.round(candidate.confidence)}%
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 rounded-[14px] border border-white/8 bg-black/18 p-2.5 text-[11px] text-white/55">
        <div className="min-w-0">
          <div className="text-[9px] uppercase tracking-wide text-white/32">Source</div>
          <div className="mt-0.5 truncate font-semibold text-white/75">{candidate.sourceDocument}</div>
        </div>
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-wide text-white/32">Value</div>
          <div className="mt-0.5 font-semibold text-emerald-100">{money.format(candidate.amount)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[9px] uppercase tracking-wide text-white/32">Date</div>
          <div className="mt-0.5 truncate">{formatDate(candidate.date)}</div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-[9px] uppercase tracking-wide text-white/32">Match</div>
          <div className="mt-0.5 truncate">{firstMatch?.job_name || firstMatch?.jobName || "Review"}</div>
        </div>
      </div>

      <div className="mt-3 flex min-h-[56px] flex-wrap content-start gap-1.5 overflow-hidden">
        {candidate.reasons.length ? candidate.reasons.slice(0, 3).map((reason) => (
          <span key={reason} className="max-w-full truncate rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-white/50">{reason}</span>
        )) : (
          <span className="text-[11px] text-white/38">No resolver reasons available.</span>
        )}
      </div>

      <div className="mt-auto grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onApproveNew?.(candidate.raw)} disabled={busy || readOnly} title={readOnly ? "Suggested job changes are unavailable in read-only Admin View." : undefined} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-300/28 bg-emerald-300/[0.1] px-2.5 py-1.5 text-[11px] font-semibold text-emerald-50 hover:bg-emerald-300/[0.16] disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" />
          Create job
        </button>
        <button type="button" onClick={() => matchJobId && onLinkExisting?.(candidate.raw, matchJobId)} disabled={busy || readOnly || !matchJobId} title={readOnly ? "Suggested job changes are unavailable in read-only Admin View." : undefined} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-[11px] font-semibold text-white/65 hover:border-emerald-300/25 hover:bg-emerald-300/[0.08] hover:text-emerald-50 disabled:opacity-50">
          <Link2 className="h-3.5 w-3.5" />
          Link
        </button>
        <button type="button" onClick={() => onMerge?.([candidate.raw])} disabled={busy || readOnly} title={readOnly ? "Suggested job changes are unavailable in read-only Admin View." : undefined} className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-[11px] font-semibold text-white/60 hover:bg-white/[0.09] disabled:opacity-50">
          Merge
        </button>
        <button type="button" onClick={() => onDismiss?.(candidate.raw)} disabled={busy || readOnly} title={readOnly ? "Suggested job changes are unavailable in read-only Admin View." : undefined} className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1.5 text-[11px] font-semibold text-white/45 hover:bg-white/[0.08] disabled:opacity-50">
          Dismiss
        </button>
      </div>
    </article>
  );
}

function AssignmentImpactModal({ preview, busy, onCancel, onConfirm }) {
  if (!preview) return null;
  const view = normalizeAssignmentImpactView(preview.impact);
  const txn = preview.transaction || {};
  const job = preview.job || {};
  const rows = [
    ["Revenue", view.revenueDelta],
    ["Collected cash", view.collectedCashDelta],
    ["Receivable", view.receivableDelta],
    ["Cost", view.costDelta],
  ];
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-3 py-[8vh] backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[22px] border border-white/10 bg-[#17211d] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/70">Assignment impact</p>
            <h2 className="mt-1 text-base font-semibold text-white">{view.label}</h2>
            <p className="mt-1 text-sm text-white/50">{txn.vendor || txn.payee || "Posted transaction"} to {job.jobName || job.job_name || "job"}</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs font-semibold text-white/60">Cancel</button>
        </div>
        <p className="mt-3 rounded-[14px] border border-white/8 bg-white/[0.035] px-3 py-2 text-sm text-white/62">{view.explanation || "Review the backend-calculated financial impact before committing this assignment."}</p>
        {view.requiresUserChoice ? (
          <div className="mt-3 rounded-[14px] border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-xs text-amber-50/80">
            This inflow requires a user choice before it can be assigned.
          </div>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {rows.map(([label, amount]) => (
            <div key={label} className="rounded-[12px] bg-white/[0.04] p-2.5">
              <div className="text-[9px] uppercase tracking-wide text-white/35">{label}</div>
              <div className="mt-0.5 font-semibold text-white">{money.format(Number(amount || 0))}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-xs text-white/48">
          Duplicate prevention: {view.duplicateRevenuePrevented ? "Revenue will not be counted twice." : "No duplicate revenue prevention was needed."}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/55 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy || view.requiresUserChoice} className="rounded-full border border-emerald-300/30 bg-emerald-300/[0.12] px-3 py-1.5 text-xs font-semibold text-emerald-50 disabled:opacity-50">
            {busy ? "Assigning..." : "Confirm assignment"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CandidateApprovalImpactModal({ preview, busy, onCancel, onConfirm }) {
  if (!preview) return null;
  const view = normalizeCandidateApprovalImpactView(preview.preview);
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-3 py-[8vh] backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[22px] border border-white/10 bg-[#17211d] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/70">Candidate approval impact</p>
        <h2 className="mt-1 text-base font-semibold text-white">{view.jobName}</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-[12px] bg-white/[0.04] p-2.5"><div className="text-[9px] uppercase tracking-wide text-white/35">Documents</div><div className="mt-0.5 font-semibold text-white">{view.documentCount}</div></div>
          <div className="rounded-[12px] bg-white/[0.04] p-2.5"><div className="text-[9px] uppercase tracking-wide text-white/35">Invoiced</div><div className="mt-0.5 font-semibold text-white">{money.format(view.invoicedRevenueChange)}</div></div>
          <div className="rounded-[12px] bg-white/[0.04] p-2.5"><div className="text-[9px] uppercase tracking-wide text-white/35">Collected</div><div className="mt-0.5 font-semibold text-white">{money.format(view.collectedCashChange)}</div></div>
          <div className="rounded-[12px] bg-white/[0.04] p-2.5"><div className="text-[9px] uppercase tracking-wide text-white/35">Receivable</div><div className="mt-0.5 font-semibold text-white">{money.format(view.receivableChange)}</div></div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/55 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy} className="rounded-full border border-emerald-300/30 bg-emerald-300/[0.12] px-3 py-1.5 text-xs font-semibold text-emerald-50 disabled:opacity-50">
            {busy ? "Saving..." : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddJobDrawer({ open, onClose, onSubmit, projectsCapability, submitting = false }) {
  const [form, setForm] = useState({
    customer: "",
    jobName: "",
    address: "",
    startDate: "",
    endDate: "",
    targetMargin: "",
    jobNumber: "",
    revenueBasis: "invoiced",
    contractValue: "",
    createInQbo: false,
  });
  const submittingRef = useRef(false);
  const capability = getProjectsCapabilityView(projectsCapability || {});
  const canCreateInQbo = false;
  const qboCreateUnavailableMessage = "QuickBooks Project creation is not available for this connection.";
  useEffect(() => {
    if (!open) return;
    submittingRef.current = false;
    setForm((current) => ({ ...current, createInQbo: false }));
  }, [open]);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (!form.customer.trim() || !form.jobName.trim() || submitting || submittingRef.current) return;
    submittingRef.current = true;
    try {
      await Promise.resolve(onSubmit?.({
        customer: { display_name: form.customer.trim() },
        job: {
          job_name: form.jobName.trim(),
          client_name: form.customer.trim(),
          address: form.address.trim() || null,
          start_date: form.startDate || null,
          end_date: form.endDate || null,
          target_margin: form.targetMargin ? Number(form.targetMargin) : null,
          job_number: form.jobNumber.trim() || null,
          job_costing_revenue_basis: form.revenueBasis,
          contract_amount: form.contractValue ? Number(form.contractValue) : null,
          creation_method: "manual",
        },
        createInQbo: Boolean(form.createInQbo && canCreateInQbo),
      }));
    } finally {
      submittingRef.current = false;
    }
  };
  return (
    <JobCostingModal open={open} title="Add Job" eyebrow="Manual job" onClose={onClose} widthClass="max-w-[560px]">
      <div className="grid gap-3 pb-8">
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["customer", "Customer", true],
            ["jobName", "Job name", true],
            ["address", "Address", false],
            ["jobNumber", "Job number", false],
          ].map(([key, label, required]) => (
            <label key={key} className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/38">{label}{required ? " *" : ""}</span>
              <input
                id={`add-job-${key}`}
                name={`add_job_${key}`}
                value={form[key]}
                onChange={(event) => update(key, event.target.value)}
                className="mt-1 h-10 w-full rounded-[14px] border border-white/10 bg-black/22 px-3 text-sm text-white outline-none focus:border-emerald-300/45"
              />
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/38">Start date</span>
            <input id="add-job-startDate" name="add_job_startDate" type="date" value={form.startDate} onChange={(event) => update("startDate", event.target.value)} className="mt-1 h-10 w-full rounded-[14px] border border-white/10 bg-black/22 px-3 text-sm text-white outline-none focus:border-emerald-300/45" />
          </label>
          <label>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/38">End date</span>
            <input id="add-job-endDate" name="add_job_endDate" type="date" value={form.endDate} onChange={(event) => update("endDate", event.target.value)} className="mt-1 h-10 w-full rounded-[14px] border border-white/10 bg-black/22 px-3 text-sm text-white outline-none focus:border-emerald-300/45" />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/38">Target margin</span>
            <input id="add-job-targetMargin" name="add_job_targetMargin" type="number" value={form.targetMargin} onChange={(event) => update("targetMargin", event.target.value)} className="mt-1 h-10 w-full rounded-[14px] border border-white/10 bg-black/22 px-3 text-sm text-white outline-none focus:border-emerald-300/45" />
          </label>
          <label>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/38">Contract/estimate value</span>
            <input id="add-job-contractValue" name="add_job_contractValue" type="number" value={form.contractValue} onChange={(event) => update("contractValue", event.target.value)} className="mt-1 h-10 w-full rounded-[14px] border border-white/10 bg-black/22 px-3 text-sm text-white outline-none focus:border-emerald-300/45" />
          </label>
        </div>
        <label>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/38">Revenue basis</span>
          <select id="add-job-revenueBasis" name="add_job_revenueBasis" value={form.revenueBasis} onChange={(event) => update("revenueBasis", event.target.value)} className="dark-dropdown mt-1 h-10 w-full appearance-none rounded-[14px] border border-white/10 bg-[#0f1115] px-3 text-sm text-white outline-none transition focus:border-emerald-300/45 [color-scheme:dark]">
            <option value="invoiced" className="bg-[#0b0e12] text-white">Invoiced revenue</option>
            <option value="collected" className="bg-[#0b0e12] text-white">Collected cash</option>
            <option value="contract_value" className="bg-[#0b0e12] text-white">Contract value</option>
            <option value="recognized" className="bg-[#0b0e12] text-white">Recognized revenue</option>
          </select>
        </label>
        <div className="rounded-[16px] border border-white/10 bg-white/[0.035] px-3 py-3">
          <div className="flex items-start gap-3">
            <input id="add-job-createInQbo" name="add_job_createInQbo" type="checkbox" checked={false} disabled className="mt-1" aria-label="Create in QuickBooks too unavailable" />
            <span>
              <span className="block text-sm font-semibold text-white/82">Create in QuickBooks too</span>
              <span className="mt-0.5 block text-xs text-white/42">{qboCreateUnavailableMessage}</span>
            </span>
          </div>
          {capability.available ? (
            <div className="mt-2 rounded-[12px] border border-amber-300/18 bg-amber-300/[0.07] px-3 py-2 text-xs text-amber-50/72">
              Project import is available, but project creation requires a verified Intuit mutation and entitlement that is not configured for this connection.
            </div>
          ) : (
            <div className="mt-2 text-xs text-white/38">{capability.label}</div>
          )}
        </div>
        <button type="button" onClick={submit} disabled={!form.customer.trim() || !form.jobName.trim() || submitting} className="mt-2 rounded-full border border-emerald-300/30 bg-emerald-300/[0.12] px-4 py-2 text-sm font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.18] disabled:opacity-50">
          {submitting ? "Creating..." : "Add Job"}
        </button>
      </div>
    </JobCostingModal>
  );
}

function ImportJobsDrawer({ open, onClose, projectsCapability, onSyncProjects, loading }) {
  const capability = getProjectsCapabilityView(projectsCapability || {});
  const sources = [
    {
      key: "projects",
      title: "QBO Projects",
      detail: capability.available ? "Import QuickBooks Projects as authoritative job identities." : capability.label,
      enabled: capability.available,
      action: onSyncProjects,
      actionLabel: "Sync Projects",
    },
    {
      key: "csv",
      title: "CSV import",
      detail: "Future integration.",
      enabled: false,
      actionLabel: "Coming Soon",
    },
  ];
  return (
    <JobCostingModal open={open} title="Import Jobs" eyebrow="Available sources" onClose={onClose} widthClass="max-w-[640px]">
      {!capability.available ? (
        <div className="mb-3 rounded-[16px] border border-amber-300/18 bg-amber-300/[0.08] px-3 py-3 text-xs text-amber-50/75">
          QuickBooks Projects are not enabled for this company. Create jobs manually or use Suggested Jobs from the main page.
        </div>
      ) : null}
      <div className="space-y-3">
        {sources.map((source) => (
          <div key={source.key} className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-white/10 bg-black/18 p-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white">{source.title}</div>
              <div className="mt-1 max-w-lg text-xs text-white/45">{source.detail}</div>
              {source.key === "projects" && capability.detail ? <div className="mt-1 text-[11px] text-amber-100/70">{capability.detail}</div> : null}
            </div>
            <button
              type="button"
              onClick={source.action}
              disabled={!source.enabled || loading}
              className="rounded-full border border-emerald-300/25 bg-emerald-300/[0.09] px-3 py-1.5 text-xs font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.15] disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-white/35"
            >
              {loading ? "Working..." : source.actionLabel}
            </button>
          </div>
        ))}
      </div>
    </JobCostingModal>
  );
}

function JobCostingPage({ businessId, usingDemo, readOnly = false }) {
  const location = useLocation();
  const initialLiveCache = usingDemo ? null : readJobCostingLiveCache(businessId, readOnly);
  const [transactions, setTransactions] = useState(() => initialLiveCache?.transactions || []);
  const [jobs, setJobs] = useState(() => initialLiveCache?.jobs || []);
  const [loading, setLoading] = useState(() => !hasJobCostingCacheData(initialLiveCache));
  const [error, setError] = useState("");
  const [transactionsError, setTransactionsError] = useState("");
  const [jobsError, setJobsError] = useState("");
  const [selectedJob, setSelectedJob] = useState(null);
  const assignmentRef = useRef(null);
  const [instruction, setInstruction] = useState("");
  const [assignmentPreview, setAssignmentPreview] = useState(null);
  const [assignmentHistory, setAssignmentHistory] = useState(() => initialLiveCache?.assignmentHistory || []);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmingAssignment, setConfirmingAssignment] = useState(false);
  const [assignmentError, setAssignmentError] = useState("");
  const [assignmentMessage, setAssignmentMessage] = useState("");
  const [listening, setListening] = useState(false);
  const [suggestions, setSuggestions] = useState(() => initialLiveCache?.suggestions || []);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionBusyId, setSuggestionBusyId] = useState("");
  const [marginTargets, setMarginTargets] = useState(() => initialLiveCache?.marginTargets || []);
  const [qboGlAccounts, setQboGlAccounts] = useState(() => initialLiveCache?.qboGlAccounts || []);
  const [_changeOrders, setChangeOrders] = useState([]);
  const [potentialChangeOrders, setPotentialChangeOrders] = useState([]);
  const [savingChangeOrder, setSavingChangeOrder] = useState(false);
  const [changeOrderMessage, setChangeOrderMessage] = useState("");
  const [draggedTransactionId, setDraggedTransactionId] = useState("");
  const [draggedTransaction, setDraggedTransaction] = useState(null);
  const [dragOverJobId, setDragOverJobId] = useState("");
  const [assignmentPickerTxn, setAssignmentPickerTxn] = useState(null);
  const [assignmentPickerVisible, setAssignmentPickerVisible] = useState(false);
  const [assignmentPickerJobId, setAssignmentPickerJobId] = useState("");
  const [assignmentPickerPercent, setAssignmentPickerPercent] = useState("100");
  const [assignmentPickerAtBottom, setAssignmentPickerAtBottom] = useState(false);
  const [assigningTransactionId, setAssigningTransactionId] = useState("");
  const [viewAssignedJob, setViewAssignedJob] = useState(null);
  const [removingAssignmentId, setRemovingAssignmentId] = useState("");
  const [markingCompleteJobId, setMarkingCompleteJobId] = useState("");
  const [revertingCandidateJobId, setRevertingCandidateJobId] = useState("");
  const [bucketMode, setBucketMode] = useState("live");
  const [jobCandidates, setJobCandidates] = useState(() => initialLiveCache?.jobCandidates || []);
  const [jobCandidatesTotal, setJobCandidatesTotal] = useState(() => Number(initialLiveCache?.jobCandidatesTotal || 0));
  const [jobCandidatesError, setJobCandidatesError] = useState("");
  const [jobCandidateBusyId, setJobCandidateBusyId] = useState("");
  const [addJobOpen, setAddJobOpen] = useState(false);
  const [creatingManualJob, setCreatingManualJob] = useState(false);
  const creatingManualJobRef = useRef(false);
  const [deletingJobId, setDeletingJobId] = useState("");
  const [importJobsOpen, setImportJobsOpen] = useState(false);
  const [revenueDrawerJob, setRevenueDrawerJob] = useState(null);
  const [projectsCapability, setProjectsCapability] = useState(() => initialLiveCache?.projectsCapability || null);
  const [importJobsLoading, setImportJobsLoading] = useState(false);
  const [assignmentImpactPreview, setAssignmentImpactPreview] = useState(null);
  const [candidateApprovalPreview, setCandidateApprovalPreview] = useState(null);
  const assignmentPickerTimerRef = useRef(null);
  const hasVisibleJobCostingDataRef = useRef(hasJobCostingCacheData(initialLiveCache));
  const pendingDeletedJobIdsRef = useRef(new Set());
  const confirmedDeletedJobIdsRef = useRef(new Set());

  useEffect(() => {
    if (usingDemo) return;
    if (!businessId) {
      hasVisibleJobCostingDataRef.current = false;
      setTransactions([]);
      setJobs([]);
      setJobCandidates([]);
      setJobCandidatesTotal(0);
      setProjectsCapability(null);
      setSuggestions([]);
      setAssignmentHistory([]);
      setLoading(false);
      return;
    }
    const cached = readJobCostingLiveCache(businessId, readOnly);
    const hasCachedData = hasJobCostingCacheData(cached);
    hasVisibleJobCostingDataRef.current = hasCachedData;
    if (hasCachedData) {
      const excludedJobIds = new Set([
        ...pendingDeletedJobIdsRef.current,
        ...confirmedDeletedJobIdsRef.current,
      ]);
      setTransactions(cached?.transactions || []);
      setJobs(filterActiveUiJobs(cached?.jobs || [], excludedJobIds));
      setJobCandidates(cached?.jobCandidates || []);
      setJobCandidatesTotal(Number(cached?.jobCandidatesTotal || 0));
      setProjectsCapability(cached?.projectsCapability || null);
      setSuggestions(cached?.suggestions || []);
      setAssignmentHistory(cached?.assignmentHistory || []);
      setMarginTargets(cached?.marginTargets || []);
      setQboGlAccounts(cached?.qboGlAccounts || []);
      setTransactionsError("");
      setJobsError("");
      setJobCandidatesError("");
      setLoading(false);
    } else {
      setTransactions([]);
      setJobs([]);
      setJobCandidates([]);
      setJobCandidatesTotal(0);
      setProjectsCapability(null);
      setSuggestions([]);
      setAssignmentHistory([]);
      setMarginTargets([]);
      setQboGlAccounts([]);
      setLoading(true);
    }
  }, [businessId, readOnly, usingDemo]);

  const loadJobCosting = useCallback(async () => {
    if (usingDemo) {
      setTransactions(demoJobCostingTransactions);
      setJobs(buildDemoJobCostingJobs(demoJobCostingTransactions));
      setChangeOrders([]);
      setPotentialChangeOrders([]);
      setTransactionsError("");
      setJobsError("");
      setLoading(false);
      return;
    }
    if (!businessId) {
      setLoading(false);
      return;
    }
    setLoading(!hasVisibleJobCostingDataRef.current);
    setError("");
    setTransactionsError("");
    setJobsError("");
    try {
      const [dataResult, summaryResult] = await Promise.allSettled([
        safeFetch(apiUrl(`/api/jobs/job-costing?business_id=${encodeURIComponent(businessId)}`)),
        safeFetch(apiUrl(`/api/job-costing/jobs/summary?business_id=${encodeURIComponent(businessId)}`)),
      ]);

      if (dataResult.status === "fulfilled") {
        const data = dataResult.value || {};
        const nextTransactions = Array.isArray(data?.transactions) ? data.transactions : [];
        setTransactions(nextTransactions);
        writeJobCostingLiveCache(businessId, readOnly, { transactions: nextTransactions });
        hasVisibleJobCostingDataRef.current = true;
      } else {
        console.warn("[JobCosting] posted transactions failed", dataResult.reason?.message || dataResult.reason);
        setTransactionsError("Unable to load posted QuickBooks transactions.");
      }

      if (summaryResult.status === "fulfilled") {
        const summary = summaryResult.value || {};
        const fallbackData = dataResult.status === "fulfilled" ? dataResult.value : {};
        const excludedJobIds = new Set([
          ...pendingDeletedJobIdsRef.current,
          ...confirmedDeletedJobIdsRef.current,
        ]);
        const nextJobs = filterActiveUiJobs(
          Array.isArray(summary?.jobs) ? summary.jobs : Array.isArray(fallbackData?.jobs) ? fallbackData.jobs : [],
          excludedJobIds
        );
        setJobs(nextJobs);
        writeJobCostingLiveCache(businessId, readOnly, { jobs: nextJobs });
        hasVisibleJobCostingDataRef.current = true;
      } else {
        console.warn("[JobCosting] jobs summary failed", summaryResult.reason?.message || summaryResult.reason);
        setJobsError("Unable to load jobs.");
      }

      if (dataResult.status === "rejected" && summaryResult.status === "rejected") {
        setError("Unable to load Job Costing data.");
      }
    } catch (e) {
      console.warn("[JobCosting] load failed", e?.message || e);
      setError(e?.message || "Failed to load job costing.");
    } finally {
      setLoading(false);
    }
  }, [businessId, readOnly, usingDemo]);

  useEffect(() => {
    loadJobCosting();
  }, [loadJobCosting]);

  const loadSuggestions = useCallback(async () => {
    if (usingDemo) {
      setSuggestions(buildDemoSuggestions(jobs, transactions));
      return;
    }
    if (!businessId) return;
    setSuggestionsLoading(true);
    try {
      const data = await safeFetch(apiUrl(`/api/job-costing/suggestions?business_id=${encodeURIComponent(businessId)}`));
      const nextSuggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
      setSuggestions(nextSuggestions);
      writeJobCostingLiveCache(businessId, readOnly, { suggestions: nextSuggestions });
    } catch (e) {
      console.warn("[JobCosting] suggestions failed", e?.message || e);
      setAssignmentError("Could not load assignment suggestions. Manual assignment is still available.");
    } finally {
      setSuggestionsLoading(false);
    }
  }, [businessId, jobs, readOnly, transactions, usingDemo]);

  useEffect(() => {
    if (loading) return;
    loadSuggestions();
  }, [loadSuggestions, loading]);

  const loadAssignmentHistory = useCallback(async () => {
    if (usingDemo) return;
    if (!businessId) return;
    try {
      const data = await safeFetch(apiUrl(`/api/job-costing/assignment-history?business_id=${encodeURIComponent(businessId)}`));
      const nextHistory = Array.isArray(data?.history) ? data.history : [];
      setAssignmentHistory(nextHistory);
      writeJobCostingLiveCache(businessId, readOnly, { assignmentHistory: nextHistory });
    } catch (e) {
      console.warn("[JobCosting] assignment history failed", e?.message || e);
      setAssignmentError("Could not load assignment history. New assignments can still be created.");
    }
  }, [businessId, readOnly, usingDemo]);

  useEffect(() => {
    if (loading) return;
    loadAssignmentHistory();
  }, [loadAssignmentHistory, loading]);

  const loadJobCandidates = useCallback(async () => {
    if (usingDemo) {
      setJobCandidates(demoJobCandidates);
      setJobCandidatesTotal(demoJobCandidates.length);
      setJobCandidatesError("");
      return;
    }
    if (!businessId) return;
    setJobCandidatesError("");
    try {
      const data = await safeFetch(apiUrl(`/api/job-costing/job-candidates?business_id=${encodeURIComponent(businessId)}&limit=250`));
      const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
      const nextTotal = Number(data?.total_count ?? candidates.length) || candidates.length;
      setJobCandidates(candidates);
      setJobCandidatesTotal(nextTotal);
      writeJobCostingLiveCache(businessId, readOnly, {
        jobCandidates: candidates,
        jobCandidatesTotal: nextTotal,
      });
    } catch (e) {
      console.warn("[JobCosting] job candidates failed", e?.message || e);
      setJobCandidatesError("Unable to load suggested jobs.");
      setAssignmentError("Could not load suggested jobs. Manual jobs are still available.");
    }
  }, [businessId, readOnly, usingDemo]);

  const loadProjectsCapability = useCallback(async () => {
    if (usingDemo) {
      setProjectsCapability(demoProjectsCapability);
      return;
    }
    if (readOnly) {
      setProjectsCapability({ status: "unavailable", detail: "QuickBooks capability refresh is unavailable in read-only Admin View." });
      return;
    }
    if (!businessId) return;
    try {
      const data = await safeFetch(apiUrl(`/api/job-costing/qbo/projects/capability?business_id=${encodeURIComponent(businessId)}`));
      const capability = data?.capability || data?.projects_capability || data;
      const nextCapability = typeof capability === "string" ? { status: capability } : capability || null;
      setProjectsCapability(nextCapability);
      writeJobCostingLiveCache(businessId, readOnly, { projectsCapability: nextCapability });
    } catch (e) {
      console.warn("[JobCosting] QBO Projects capability failed", e?.message || e);
      const nextCapability = { status: "unknown", detail: e?.message || "Could not check Projects capability." };
      setProjectsCapability(nextCapability);
      writeJobCostingLiveCache(businessId, readOnly, { projectsCapability: nextCapability });
    }
  }, [businessId, readOnly, usingDemo]);

  useEffect(() => {
    if (loading) return;
    loadJobCandidates();
    loadProjectsCapability();
  }, [loadJobCandidates, loadProjectsCapability, loading]);

  const loadMarginTargets = useCallback(async () => {
    if (usingDemo || !businessId) {
      setMarginTargets([]);
      return;
    }
    try {
      const data = await safeFetch(apiUrl(`/api/job-costing/margin-targets?business_id=${encodeURIComponent(businessId)}`));
      const nextTargets = Array.isArray(data?.targets) ? data.targets : [];
      setMarginTargets(nextTargets);
      writeJobCostingLiveCache(businessId, readOnly, { marginTargets: nextTargets });
    } catch (e) {
      console.warn("[JobCosting] margin targets fallback", e?.message || e);
      setMarginTargets([]);
    }
  }, [businessId, readOnly, usingDemo]);

  useEffect(() => {
    loadMarginTargets();
  }, [loadMarginTargets]);

  useEffect(() => {
    let active = true;
    async function loadQboGlAccounts() {
      if (usingDemo || !businessId) {
        setQboGlAccounts([]);
        return;
      }
      if (readOnly) {
        setQboGlAccounts([]);
        return;
      }
      try {
        const data = await getQboCoa(businessId);
        if (!active) return;
        const accounts = Array.isArray(data?.accounts) ? data.accounts : Array.isArray(data) ? data : [];
        setQboGlAccounts(accounts);
        writeJobCostingLiveCache(businessId, readOnly, { qboGlAccounts: accounts });
      } catch (e) {
        console.warn("[JobCosting] QBO chart of accounts fallback", e?.message || e);
        if (active) setQboGlAccounts([]);
      }
    }
    loadQboGlAccounts();
    return () => {
      active = false;
    };
  }, [businessId, readOnly, usingDemo]);

  const jobRows = useMemo(() => buildJobRows(jobs, transactions), [jobs, transactions]);
  const currentJobRows = useMemo(
    () => jobRows.filter((job) => !isCompletedJobStatus(job.status)),
    [jobRows]
  );
  const completedJobRows = useMemo(
    () => jobRows.filter((job) => isCompletedJobStatus(job.status)),
    [jobRows]
  );
  const assignedModalJob = viewAssignedJob
    ? jobRows.find((job) => String(job.id) === String(viewAssignedJob.id)) || viewAssignedJob
    : null;
  const openAssignmentPicker = useCallback((txn, job = null) => {
    if (readOnly) {
      setAssignmentError("Job assignment changes are unavailable in read-only Admin View.");
      return;
    }
    const remainingPercent = Math.max(0, Number(txn?.remaining_percent ?? (100 - Number(txn?.assigned_total_percent || 0))));
    const defaultPercent = remainingPercent > 0 && remainingPercent < 100 ? remainingPercent : 100;
    if (assignmentPickerTimerRef.current) window.clearTimeout(assignmentPickerTimerRef.current);
    setAssignmentPickerTxn(txn);
    setAssignmentPickerVisible(false);
    setAssignmentPickerJobId(job?.id || "");
    setAssignmentPickerPercent(String(Math.round(defaultPercent * 100) / 100));
    setAssignmentPickerAtBottom(false);
    window.requestAnimationFrame(() => setAssignmentPickerVisible(true));
  }, [readOnly]);

  const closeAssignmentPicker = useCallback(() => {
    setAssignmentPickerVisible(false);
    if (assignmentPickerTimerRef.current) window.clearTimeout(assignmentPickerTimerRef.current);
    assignmentPickerTimerRef.current = window.setTimeout(() => {
      setAssignmentPickerTxn(null);
      setAssignmentPickerJobId("");
      setAssignmentPickerAtBottom(false);
    }, 220);
  }, []);

  useEffect(() => () => {
    if (assignmentPickerTimerRef.current) window.clearTimeout(assignmentPickerTimerRef.current);
  }, []);

  useEffect(() => {
    if (!assignmentPickerTxn) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeAssignmentPicker();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [assignmentPickerTxn, closeAssignmentPicker]);

  const saveChangeOrder = useCallback(async (job, payload) => {
    if (readOnly) throw new Error("Change orders are unavailable in read-only Admin View.");
    if (!job?.id) throw new Error("Job is missing an id.");
    setSavingChangeOrder(true);
    setChangeOrderMessage("");
    setAssignmentError("");
    try {
      if (usingDemo) {
        const proposedPrice = payload.proposed_price ?? (
          payload.estimated_cost > 0 ? Math.round((payload.estimated_cost / 0.65) * 100) / 100 : 0
        );
        const changeOrder = {
          id: `demo-change-order-${Date.now()}`,
          business_id: businessId || "demo-business",
          job_id: job.id,
          title: payload.title,
          description: payload.description,
          status: "proposed",
          proposed_price: proposedPrice,
          approved_price: null,
          estimated_cost: Number(payload.estimated_cost || 0),
          target_margin_percent: payload.target_margin_percent ?? 35,
          recommended_price: proposedPrice,
          recommendation_reason: {
            estimated_cost: Number(payload.estimated_cost || 0),
            target_margin_percent: payload.target_margin_percent ?? 35,
            recommended_price: proposedPrice,
            basis: "fallback",
            explanation: "Used the fallback 35% target margin.",
          },
          draft_client_message: payload.draft_client_message || buildChangeOrderClientDraftPreview(job, payload, null),
          draft_scope_summary: `Additional work requested: ${payload.description}`,
          client_notes: payload.client_notes || "",
          internal_notes: payload.internal_notes || "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setJobs((prev) => prev.map((item) => String(item.id || item.job_id) === String(job.id)
          ? { ...item, change_orders: [...(item.change_orders || []), changeOrder] }
          : item));
        setChangeOrders((prev) => [{ ...changeOrder, job_name: job.jobName || job.job_name }, ...prev]);
        setChangeOrderMessage("Change order logged.");
        return changeOrder;
      }
      const data = await safeFetch(apiUrl(`/api/job-costing/jobs/${encodeURIComponent(job.id)}/change-orders`), {
        method: "POST",
        body: {
          business_id: businessId,
          title: payload.title,
          description: payload.description,
          estimated_cost: Number(payload.estimated_cost || 0),
          target_margin_percent: payload.target_margin_percent,
          proposed_price: payload.proposed_price,
          draft_client_message: payload.draft_client_message || "",
          client_notes: payload.client_notes || "",
          internal_notes: payload.internal_notes || "",
        },
      });
      setChangeOrderMessage(data?.message || "Change order logged.");
      await loadJobCosting();
      await loadSuggestions();
      return data?.change_order || null;
    } catch (e) {
      throw new Error(e?.message || "Could not log change order.");
    } finally {
      setSavingChangeOrder(false);
    }
  }, [businessId, loadJobCosting, loadSuggestions, readOnly, usingDemo]);

  const previewChangeOrderPrice = useCallback(async (job, payload) => {
    if (readOnly) throw new Error("Change order pricing is unavailable in read-only Admin View.");
    if (usingDemo) {
      const estimatedCost = Number(payload?.estimated_cost || 0);
      const targetMargin = Number(payload?.target_margin_percent || 35);
      const safeMargin = Number.isFinite(targetMargin) && targetMargin > 0 && targetMargin < 95 ? targetMargin : 35;
      const recommendedPrice = estimatedCost > 0 ? Math.round((estimatedCost / (1 - safeMargin / 100)) * 100) / 100 : 0;
      return {
        estimated_cost: estimatedCost,
        target_margin_percent: safeMargin,
        recommended_price: recommendedPrice,
        gross_margin_amount: Math.round((recommendedPrice - estimatedCost) * 100) / 100,
        markup_percent: estimatedCost > 0 ? Math.round(((recommendedPrice - estimatedCost) / estimatedCost) * 10000) / 100 : 0,
        basis: "fallback",
        explanation: `Used the fallback ${safeMargin}% target margin.`,
      };
    }
    const data = await safeFetch(apiUrl("/api/job-costing/change-orders/recommend-price"), {
      method: "POST",
      body: {
        business_id: businessId,
        job_id: job.id,
        estimated_cost: Number(payload?.estimated_cost || 0),
        target_margin_percent: payload?.target_margin_percent,
      },
    });
    return data?.recommendation || null;
  }, [businessId, readOnly, usingDemo]);

  const updateChangeOrder = useCallback(async (order, patch) => {
    if (readOnly) throw new Error("Change order updates are unavailable in read-only Admin View.");
    if (!order?.id) throw new Error("Change order is missing an id.");
    if (usingDemo) {
      setJobs((prev) => prev.map((item) => {
        const orders = Array.isArray(item.change_orders) ? item.change_orders : [];
        if (!orders.some((candidate) => String(candidate.id) === String(order.id))) return item;
        return {
          ...item,
          change_orders: orders.map((candidate) => String(candidate.id) === String(order.id)
            ? {
                ...candidate,
                ...patch,
                approved_at: patch.status === "client_approved" ? new Date().toISOString() : candidate.approved_at,
                billed_at: patch.status === "billed" ? new Date().toISOString() : candidate.billed_at,
                paid_at: patch.status === "paid" ? new Date().toISOString() : candidate.paid_at,
                updated_at: new Date().toISOString(),
              }
            : candidate),
        };
      }));
      setChangeOrders((prev) => prev.map((candidate) => String(candidate.id) === String(order.id)
        ? {
            ...candidate,
            ...patch,
            approved_at: patch.status === "client_approved" ? new Date().toISOString() : candidate.approved_at,
            billed_at: patch.status === "billed" ? new Date().toISOString() : candidate.billed_at,
            paid_at: patch.status === "paid" ? new Date().toISOString() : candidate.paid_at,
            updated_at: new Date().toISOString(),
          }
        : candidate));
      setChangeOrderMessage("Change order updated.");
      return null;
    }
    const data = await safeFetch(apiUrl(`/api/job-costing/change-orders/${encodeURIComponent(order.id)}`), {
      method: "PATCH",
      body: { business_id: businessId, ...patch },
    });
    setChangeOrderMessage("Change order updated.");
    await loadJobCosting();
    return data?.change_order || null;
  }, [businessId, loadJobCosting, readOnly, usingDemo]);

  const convertPotentialChangeOrder = useCallback(async (suggestion) => {
    if (readOnly) throw new Error("Change orders are unavailable in read-only Admin View.");
    if (!suggestion?.id) throw new Error("Potential change order is missing an id.");
    if (usingDemo) {
      const changeOrder = {
        id: `demo-converted-change-order-${Date.now()}`,
        business_id: businessId || "demo-business",
        job_id: suggestion.job_id,
        title: suggestion.title,
        description: suggestion.explanation,
        status: "proposed",
        proposed_price: Number(suggestion.suggested_price || 0),
        approved_price: null,
        estimated_cost: Number(suggestion.estimated_extra_cost || 0),
        recommended_price: Number(suggestion.suggested_price || 0),
        recommendation_reason: {
          source: "potential_change_order",
          trigger_type: suggestion.trigger_type,
          confidence_score: suggestion.confidence_score,
        },
        draft_client_message: "",
        draft_scope_summary: `Additional work requested: ${suggestion.explanation}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setJobs((prev) => prev.map((item) => String(item.id || item.job_id) === String(suggestion.job_id)
        ? { ...item, change_orders: [...(item.change_orders || []), changeOrder] }
        : item));
      setChangeOrders((prev) => [changeOrder, ...prev]);
      setPotentialChangeOrders((prev) => prev.filter((item) => String(item.id) !== String(suggestion.id)));
      setChangeOrderMessage("Potential change order converted.");
      return changeOrder;
    }
    const data = await safeFetch(apiUrl(`/api/job-costing/potential-change-orders/${encodeURIComponent(suggestion.id)}/convert`), {
      method: "POST",
      body: { business_id: businessId },
    });
    setChangeOrderMessage("Potential change order converted.");
    await loadJobCosting();
    await loadSuggestions();
    return data?.change_order || null;
  }, [businessId, loadJobCosting, loadSuggestions, readOnly, usingDemo]);

  const dismissPotentialChangeOrder = useCallback(async (suggestion) => {
    if (readOnly) throw new Error("Change order suggestions are read-only in Admin View.");
    if (!suggestion?.id) throw new Error("Potential change order is missing an id.");
    if (usingDemo) {
      setPotentialChangeOrders((prev) => prev.filter((item) => String(item.id) !== String(suggestion.id)));
      return null;
    }
    await safeFetch(apiUrl(`/api/job-costing/potential-change-orders/${encodeURIComponent(suggestion.id)}/dismiss`), {
      method: "POST",
      body: { business_id: businessId },
    });
    setPotentialChangeOrders((prev) => prev.filter((item) => String(item.id) !== String(suggestion.id)));
    return null;
  }, [businessId, readOnly, usingDemo]);

  const approveCandidateNew = useCallback(async (candidate) => {
    if (!candidate?.id) return;
    const view = normalizeCandidateView(candidate);
    setJobCandidateBusyId(candidate.id);
    setAssignmentError("");
    try {
      if (!candidate.__previewConfirmed) {
        const preview = usingDemo
          ? buildDemoCandidateApprovalPreview(candidate, null, "create_new")
          : (await safeFetch(apiUrl(`/api/job-costing/job-candidates/${encodeURIComponent(candidate.id)}/approval-preview`), {
              method: "POST",
              body: { business_id: businessId, mode: "create_new" },
            }))?.preview;
        if (!preview) throw new Error("Candidate approval preview was unavailable.");
        setCandidateApprovalPreview({ candidate, preview, mode: "create_new" });
        return;
      }
      if (usingDemo) {
        setJobCandidates((prev) => prev.map((item) => (
          String(item.id) === String(candidate.id)
            ? { ...item, candidate_status: "approved_new", confirmed_job_id: item.confirmed_job_id || `demo-job-${item.id}` }
            : item
        )));
        setJobs((prev) => {
          const alreadyExists = prev.some((job) => String(job.jobName || job.job_name || "").toLowerCase() === view.name.toLowerCase());
          if (alreadyExists) return prev;
          return [
            ...prev,
            {
              id: `demo-job-${candidate.id}`,
              jobName: view.name,
              job_name: view.name,
              customerName: view.customer,
              client_name: view.customer,
              status: "active",
              source_type: "candidate_invoice",
              revenue_source_status: "canonical",
              source_entity_type: candidate.source_entity_type || "Invoice",
              job_costing_revenue_basis: "invoiced",
              selected_basis_amount: view.amount,
              gross_invoiced_revenue: view.amount,
              net_invoiced_revenue: view.amount,
              collected_cash: 0,
              outstanding_receivable: view.amount,
              remaining_to_bill: 0,
              total_assigned_cost: 0,
              margin_percent: view.amount > 0 ? 100 : 0,
              source_document_count: 1,
            },
          ];
        });
        return;
      }
      const result = await safeFetch(apiUrl(`/api/job-costing/job-candidates/${encodeURIComponent(candidate.id)}/approve-new`), {
        method: "POST",
        body: {
          business_id: businessId,
          job: {
            job_name: view.name,
            client_name: view.customer,
            address: view.address || null,
            job_costing_revenue_basis: "invoiced",
          },
          approval_preview_confirmed: true,
        },
      });
      const createdJob = result?.job || {};
      const jobId = createdJob.id || result?.candidate?.confirmed_job_id || `candidate-job-${candidate.id}`;
      const candidateJob = {
        ...createdJob,
        id: jobId,
        jobName: createdJob.jobName || createdJob.job_name || view.name,
        job_name: createdJob.job_name || createdJob.jobName || view.name,
        customerName: createdJob.customerName || createdJob.customer_name || view.customer,
        customer_name: createdJob.customer_name || createdJob.customerName || view.customer,
        status: createdJob.status || "active",
        source_type: createdJob.source_type || "quickbooks",
        creation_method: createdJob.creation_method || "job_candidate",
        source_entity_type: candidate.source_entity_type || "invoice",
        job_costing_revenue_basis: createdJob.job_costing_revenue_basis || "invoiced",
        selected_revenue_basis: "invoiced",
        revenue_source_status: "canonical",
        source_document_count: Number(createdJob.source_document_count || 1),
        revenue_document_count: Number(createdJob.revenue_document_count || 1),
        selected_basis_amount: view.amount,
        gross_invoiced_revenue: view.amount,
        net_invoiced_revenue: view.amount,
        job_costing_revenue: view.amount,
        base_revenue: view.amount,
        revenue: view.amount,
        total_revenue: view.amount,
        total_cost: 0,
        base_total_cost: 0,
        gross_margin: view.amount,
        gross_margin_dollars: view.amount,
        margin_percent: view.amount > 0 ? 100 : 0,
        marginPercent: view.amount > 0 ? 100 : 0,
        assigned_transaction_count: 0,
      };
      const nextCandidates = jobCandidates.map((item) => (
        String(item.id) === String(candidate.id)
          ? { ...item, candidate_status: "approved_new", confirmed_job_id: jobId }
          : item
      ));
      setJobs((prev) => {
        const withoutExisting = prev.filter((job) => String(job.id || job.job_id) !== String(jobId));
        const nextJobs = [candidateJob, ...withoutExisting];
        writeJobCostingLiveCache(businessId, readOnly, { jobs: nextJobs });
        return nextJobs;
      });
      setJobCandidates(nextCandidates);
      writeJobCostingLiveCache(businessId, readOnly, { jobCandidates: nextCandidates });
      setAssignmentMessage(`${view.name} moved to Live Jobs.`);
      void Promise.all([loadJobCosting(), loadJobCandidates()]).catch((refreshError) => {
        console.warn("[JobCosting] post-candidate-create refresh failed", refreshError?.message || refreshError);
      });
    } catch (e) {
      setAssignmentError(e?.message || "Could not create job from candidate.");
    } finally {
      setJobCandidateBusyId("");
    }
  }, [businessId, jobCandidates, loadJobCandidates, loadJobCosting, readOnly, usingDemo]);

  const linkCandidateExisting = useCallback(async (candidate, jobId) => {
    if (!candidate?.id || !jobId) return;
    setJobCandidateBusyId(candidate.id);
    setAssignmentError("");
    try {
      if (!candidate.__previewConfirmed) {
        const targetJob = jobRows.find((job) => String(job.id) === String(jobId)) || null;
        const preview = usingDemo
          ? buildDemoCandidateApprovalPreview(candidate, targetJob, "link_existing")
          : (await safeFetch(apiUrl(`/api/job-costing/job-candidates/${encodeURIComponent(candidate.id)}/approval-preview`), {
              method: "POST",
              body: { business_id: businessId, mode: "link_existing", job_id: jobId },
            }))?.preview;
        if (!preview) throw new Error("Candidate approval preview was unavailable.");
        setCandidateApprovalPreview({ candidate, jobId, preview, mode: "link_existing" });
        return;
      }
      if (usingDemo) {
        setJobCandidates((prev) => prev.map((item) => (
          String(item.id) === String(candidate.id)
            ? { ...item, candidate_status: "linked_existing", confirmed_job_id: jobId }
            : item
        )));
        return;
      }
      await safeFetch(apiUrl(`/api/job-costing/job-candidates/${encodeURIComponent(candidate.id)}/link-existing`), {
        method: "POST",
        body: { business_id: businessId, job_id: jobId, mapping_types: ["source_document"], approval_preview_confirmed: true },
      });
      await loadJobCosting();
      await loadJobCandidates();
    } catch (e) {
      setAssignmentError(e?.message || "Could not link candidate to job.");
    } finally {
      setJobCandidateBusyId("");
    }
  }, [businessId, jobRows, loadJobCandidates, loadJobCosting, usingDemo]);

  const dismissJobCandidate = useCallback(async (candidate) => {
    if (!candidate?.id) return;
    setJobCandidateBusyId(candidate.id);
    setAssignmentError("");
    try {
      if (usingDemo) {
        setJobCandidates((prev) => prev.map((item) => (
          String(item.id) === String(candidate.id)
            ? { ...item, candidate_status: "dismissed", dismissal_reason: "user_dismissed" }
            : item
        )));
        return;
      }
      await safeFetch(apiUrl(`/api/job-costing/job-candidates/${encodeURIComponent(candidate.id)}/dismiss`), {
        method: "POST",
        body: { business_id: businessId, reason: "user_dismissed" },
      });
      await loadJobCandidates();
    } catch (e) {
      setAssignmentError(e?.message || "Could not dismiss suggested job.");
    } finally {
      setJobCandidateBusyId("");
    }
  }, [businessId, loadJobCandidates, usingDemo]);

  const mergeJobCandidates = useCallback(async (candidatesToMerge) => {
    const ids = (Array.isArray(candidatesToMerge) ? candidatesToMerge : [])
      .map((candidate) => candidate?.id)
      .filter(Boolean);
    if (ids.length < 2) {
      setAssignmentError("Merge requires at least two suggested jobs.");
      return;
    }
    setJobCandidateBusyId(ids[0]);
    try {
      if (usingDemo) {
        setJobCandidates((prev) => prev.map((item) => (ids.includes(item.id) ? { ...item, candidate_status: "merged" } : item)));
        return;
      }
      await safeFetch(apiUrl("/api/job-costing/job-candidates/merge"), {
        method: "POST",
        body: { business_id: businessId, primary_candidate_id: ids[0], candidate_ids: ids.slice(1) },
      });
      await loadJobCandidates();
    } catch (e) {
      setAssignmentError(e?.message || "Could not merge suggested jobs.");
    } finally {
      setJobCandidateBusyId("");
    }
  }, [businessId, loadJobCandidates, usingDemo]);

  const generateJobCandidates = useCallback(async () => {
    setImportJobsLoading(true);
    setAssignmentError("");
    try {
      if (usingDemo) {
        setJobCandidates(demoJobCandidates);
        setBucketMode("suggested");
        return;
      }
      await safeFetch(apiUrl("/api/job-costing/job-candidates/generate"), {
        method: "POST",
        body: { business_id: businessId },
      });
      await loadJobCandidates();
      setBucketMode("suggested");
    } catch (e) {
      setAssignmentError(e?.message || "Could not generate suggested jobs.");
    } finally {
      setImportJobsLoading(false);
    }
  }, [businessId, loadJobCandidates, usingDemo]);

  const createManualJob = useCallback(async (payload) => {
    if (creatingManualJobRef.current) return;
    creatingManualJobRef.current = true;
    setCreatingManualJob(true);
    setAssignmentError("");
    setAssignmentMessage("");
    const optimisticId = `optimistic-manual-job-${Date.now()}`;
    const optimisticJob = {
      id: optimisticId,
      jobName: payload.job.job_name,
      job_name: payload.job.job_name,
      customerName: payload.customer.display_name,
      client_name: payload.customer.display_name,
      status: payload.job.status || "active",
      source_type: "manual",
      creation_method: "manual",
      revenue_source_status: "manual_no_revenue_source",
      job_costing_revenue_basis: payload.job.job_costing_revenue_basis,
      selected_basis_amount: Number(payload.job.contract_amount || 0),
      contract_value: Number(payload.job.contract_amount || 0),
      total_assigned_cost: 0,
      margin_percent: null,
      source_document_count: 0,
      assigned_transaction_count: 0,
    };
    try {
      if (usingDemo) {
        const id = `demo-manual-job-${Date.now()}`;
        setJobs((prev) => [
          ...prev,
          {
            ...optimisticJob,
            id,
            revenue_source_status: "canonical",
            margin_percent: 0,
          },
        ]);
        setAddJobOpen(false);
        return;
      }
      setJobs((prev) => [optimisticJob, ...prev]);
      writeJobCostingLiveCache(businessId, readOnly, { jobs: [optimisticJob, ...jobs] });
      setAddJobOpen(false);
      const data = await safeFetch(apiUrl("/api/job-costing/jobs/manual"), {
        method: "POST",
        body: {
          business_id: businessId,
          customer: payload.customer,
          job: payload.job,
          create_in_qbo: payload.createInQbo,
        },
      });
      if (data?.job) {
        setJobs((prev) => prev.map((job) => String(job.id) === optimisticId ? normalizeJob(data.job) : job));
      }
      await loadJobCosting();
    } catch (e) {
      setJobs((prev) => prev.filter((job) => String(job.id) !== optimisticId));
      setAssignmentError(e?.message || "Could not add job.");
    } finally {
      creatingManualJobRef.current = false;
      setCreatingManualJob(false);
    }
  }, [businessId, jobs, loadJobCosting, readOnly, usingDemo]);

  const deleteManualJob = useCallback(async (job) => {
    const jobId = String(getLocalJobId(job) || "");
    if (!jobId || deletingJobId) return;
    setDeletingJobId(jobId);
    pendingDeletedJobIdsRef.current.add(jobId);
    setAssignmentError("");
    setAssignmentMessage("");
    const previousJobs = jobs;
    const previousSelectedJob = selectedJob;
    try {
      const nextJobs = jobs.filter((item) => String(getLocalJobId(item)) !== jobId);
      setJobs(nextJobs);
      writeJobCostingLiveCache(businessId, readOnly, { jobs: nextJobs });
      if (getLocalJobId(selectedJob) && String(getLocalJobId(selectedJob)) === jobId) setSelectedJob(null);
      if (usingDemo) {
        setAssignmentMessage(`${getJobDisplayName(job)} deleted.`);
        return;
      }
      const data = await safeFetch(apiUrl(`/api/job-costing/jobs/${encodeURIComponent(jobId)}/manual`), {
        method: "DELETE",
        body: { business_id: businessId },
      });
      confirmedDeletedJobIdsRef.current.add(jobId);
      if (Array.isArray(data?.jobs)) {
        const nextServerJobs = filterActiveUiJobs(data.jobs, confirmedDeletedJobIdsRef.current);
        setJobs(nextServerJobs);
        writeJobCostingLiveCache(businessId, readOnly, { jobs: nextServerJobs });
      }
      if (Array.isArray(data?.transactions)) {
        setTransactions(data.transactions);
        writeJobCostingLiveCache(businessId, readOnly, {
          jobs: Array.isArray(data?.jobs) ? filterActiveUiJobs(data.jobs, confirmedDeletedJobIdsRef.current) : nextJobs,
          transactions: data.transactions,
          transactionTotal: Number(data?.transactions_total ?? data?.total_count ?? data.transactions.length) || data.transactions.length,
        });
      }
      setAssignmentMessage(`${getJobDisplayName(job)} deleted.`);
      void loadJobCosting();
    } catch (e) {
      pendingDeletedJobIdsRef.current.delete(jobId);
      setJobs(previousJobs);
      writeJobCostingLiveCache(businessId, readOnly, { jobs: previousJobs });
      setSelectedJob(previousSelectedJob || null);
      setAssignmentError(e?.message || "Could not delete job.");
    } finally {
      pendingDeletedJobIdsRef.current.delete(jobId);
      setDeletingJobId("");
    }
  }, [businessId, deletingJobId, jobs, loadJobCosting, readOnly, selectedJob, usingDemo]);

  const syncQboProjects = useCallback(async () => {
    setImportJobsLoading(true);
    setAssignmentError("");
    try {
      if (usingDemo) {
        setProjectsCapability(demoProjectsCapability);
        return;
      }
      await safeFetch(apiUrl("/api/job-costing/qbo/projects/sync"), {
        method: "POST",
        body: { business_id: businessId },
      });
      await loadProjectsCapability();
      await loadJobCosting();
      await loadJobCandidates();
    } catch (e) {
      setAssignmentError(e?.message || "Could not sync QuickBooks Projects.");
    } finally {
      setImportJobsLoading(false);
    }
  }, [businessId, loadJobCandidates, loadJobCosting, loadProjectsCapability, usingDemo]);

  const currentDetail = selectedJob ? jobRows.find((job) => String(job.id) === String(selectedJob.id)) || selectedJob : null;
  useEffect(() => {
    const jobId = new URLSearchParams(location.search || "").get("job_id");
    if (!jobId || !jobRows.length) return;
    const matchedJob = jobRows.find((job) => String(job.id) === String(jobId));
    if (matchedJob && String(selectedJob?.id || "") !== String(matchedJob.id)) {
      setSelectedJob(matchedJob);
    }
  }, [jobRows, location.search, selectedJob?.id]);

  const unassignedTransactions = useMemo(
    () => transactions.filter((txn) => !txn.job_id && !txn.job_label),
    [transactions]
  );
  const scrollToAssignment = useCallback(() => {
    assignmentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    assignmentRef.current?.focus?.({ preventScroll: true });
  }, []);

  const previewAssignment = useCallback(async () => {
    const clean = instruction.trim();
    if (!clean) return;
    setPreviewLoading(true);
    setAssignmentError("");
    setAssignmentMessage("");
    setAssignmentPreview(null);
    try {
      if (usingDemo) {
        setAssignmentPreview(buildDemoAssignmentPreview(clean, jobs, transactions));
        return;
      }
      const data = await safeFetch(apiUrl("/api/job-costing/assignment-preview"), {
        method: "POST",
        body: { business_id: businessId, instruction: clean },
      });
      setAssignmentPreview(data?.preview || null);
    } catch (e) {
      setAssignmentError(e?.message || "Could not preview assignment.");
    } finally {
      setPreviewLoading(false);
    }
  }, [businessId, instruction, jobs, transactions, usingDemo]);

  const confirmAssignment = useCallback(async () => {
    const clean = instruction.trim();
    if (!clean || !assignmentPreview) return;
    setConfirmingAssignment(true);
    setAssignmentError("");
    setAssignmentMessage("");
    try {
      if (usingDemo) {
        const allocation = assignmentPreview.allocations?.[0] || null;
        if (!allocation || assignmentPreview.parsed?.mode === "show") throw new Error("Add a target job before confirming an assignment.");
        const matchedIds = new Set((assignmentPreview.transactions || []).map((txn) => txn.id));
        const assigned = matchedIds.size;
        setTransactions((prev) => prev.map((txn) => matchedIds.has(txn.id)
          ? { ...txn, job_id: allocation.job_id, job_label: allocation.job_name, assignment_source: "natural_language", assignment_confidence: 0.86 }
          : txn));
        setAssignmentHistory((prev) => [buildDemoAssignmentHistory(clean, assignmentPreview, assigned), ...prev].slice(0, 12));
        setAssignmentMessage("Transactions assigned to job.");
        setAssignmentPreview(null);
        setInstruction("");
        return;
      }
      const data = await safeFetch(apiUrl("/api/job-costing/assignments/confirm"), {
        method: "POST",
        body: { business_id: businessId, instruction: clean },
      });
      const nextTransactions = Array.isArray(data?.transactions) ? data.transactions : [];
      const nextJobs = filterActiveUiJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      setTransactions(nextTransactions);
      setJobs(nextJobs);
      writeJobCostingLiveCache(businessId, readOnly, { transactions: nextTransactions, jobs: nextJobs });
      if (Array.isArray(data?.history)) {
        setAssignmentHistory(data.history);
        writeJobCostingLiveCache(businessId, readOnly, { assignmentHistory: data.history });
      }
      setAssignmentMessage(data?.message || "Transactions assigned to job.");
      setAssignmentPreview(null);
      setInstruction("");
      await loadSuggestions();
      if (!Array.isArray(data?.history)) await loadAssignmentHistory();
    } catch (e) {
      setAssignmentError(e?.message || "Could not confirm assignment.");
    } finally {
      setConfirmingAssignment(false);
    }
  }, [assignmentPreview, businessId, instruction, loadAssignmentHistory, loadSuggestions, readOnly, usingDemo]);

  const cancelAssignment = useCallback(() => {
    setAssignmentPreview(null);
    setAssignmentError("");
  }, []);

  const startVoice = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setAssignmentError("Voice input is not available in this browser.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      setAssignmentError("Voice input stopped before Bizzi caught the instruction.");
    };
    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript || "";
      if (text) setInstruction(text);
    };
    recognition.start();
  }, []);

  const acceptSuggestion = useCallback(async (suggestion) => {
    setSuggestionBusyId(suggestion.id);
    setAssignmentMessage("");
    setAssignmentError("");
    try {
      if (usingDemo) {
        const suggestedJob = getSuggestionJob(suggestion);
        setTransactions((prev) => prev.map((txn) => txn.id === suggestion.transaction_id
          ? { ...txn, job_id: suggestion.job_id, job_label: suggestedJob.jobName || suggestedJob.job_name, assignment_source: "suggestion", assignment_confidence: getSuggestionConfidence(suggestion) / 100 }
          : txn));
        setSuggestions((prev) => prev.filter((item) => item.id !== suggestion.id));
        setAssignmentMessage("Suggestion assigned to job.");
        return;
      }
      const data = await safeFetch(apiUrl(`/api/job-costing/suggestions/${encodeURIComponent(suggestion.id)}/approve`), {
        method: "POST",
        body: { business_id: businessId },
      });
      const nextTransactions = Array.isArray(data?.transactions) ? data.transactions : [];
      const nextJobs = filterActiveUiJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      setTransactions(nextTransactions);
      setJobs(nextJobs);
      setSuggestions((prev) => {
        const nextSuggestions = prev.filter((item) => item.id !== suggestion.id);
        writeJobCostingLiveCache(businessId, readOnly, {
          transactions: nextTransactions,
          jobs: nextJobs,
          suggestions: nextSuggestions,
        });
        return nextSuggestions;
      });
      setAssignmentMessage("Suggestion assigned to job.");
      await loadJobCosting();
      await loadSuggestions();
    } catch (e) {
      setAssignmentError(e?.message || "Could not assign suggestion.");
    } finally {
      setSuggestionBusyId("");
    }
  }, [businessId, loadJobCosting, loadSuggestions, readOnly, usingDemo]);

  const rejectSuggestion = useCallback(async (suggestion) => {
    setSuggestionBusyId(suggestion.id);
    setAssignmentError("");
    try {
      if (usingDemo) {
        setSuggestions((prev) => prev.filter((item) => item.id !== suggestion.id));
        return;
      }
      await safeFetch(apiUrl(`/api/job-costing/suggestions/${encodeURIComponent(suggestion.id)}/reject`), {
        method: "POST",
        body: { business_id: businessId, status: "ignored" },
      });
      setSuggestions((prev) => prev.filter((item) => item.id !== suggestion.id));
    } catch (e) {
      setAssignmentError(e?.message || "Could not reject suggestion.");
    } finally {
      setSuggestionBusyId("");
    }
  }, [businessId, usingDemo]);

  const assignTransactionToJob = useCallback(async (transaction, job, options = {}) => {
    if (!transaction?.id || !job?.id) return;
    if (isCompletedJobStatus(job.status)) {
      setAssignmentError("Completed jobs are archived from assignment. Reopen the job before assigning more transactions.");
      return;
    }
    const allocationPercent = Number(options.allocationPercent ?? 100);
    const alreadyAssignedPercent = Number(transaction.assigned_total_percent || 0);
    const replaceExisting = options.replaceExisting ?? alreadyAssignedPercent <= 0;
    setAssigningTransactionId(transaction.id);
    setAssignmentError("");
    setAssignmentMessage("");
    const previousTransactions = transactions;
    const previousJobs = jobs;
    const optimisticAssignmentId = `optimistic-${transaction.id}-${job.id}-${Date.now()}`;
    let optimisticApplied = false;
    try {
      if (!usingDemo) {
        optimisticApplied = true;
        setTransactions((prev) => prev.map((txn) => (
          String(txn.id) === String(transaction.id)
            ? withOptimisticAssignmentRows(txn, job, allocationPercent, optimisticAssignmentId)
            : txn
        )));
        setJobs((prev) => applyOptimisticJobAssignment(prev, transaction, job, allocationPercent));
        setAssignmentMessage(`Transaction assigned to ${getJobDisplayName(job)}.`);
      }
      let impact = options.impactPreview || null;
      if (!options.previewConfirmed) {
        if (usingDemo) {
          impact = buildDemoAssignmentImpactPreview(transaction, allocationPercent);
        } else {
          const previewData = await safeFetch(apiUrl("/api/job-costing/assignment-impact-preview"), {
            method: "POST",
            body: {
              business_id: businessId,
              transaction_id: transaction.id,
              job_id: job.id,
              allocation_percent: allocationPercent,
            },
          });
          impact = previewData?.impact || null;
        }
        if (!impact) throw new Error("Assignment impact preview was unavailable.");
        if (!canAssignWithoutImpactModal(impact)) {
          if (optimisticApplied) {
            setTransactions(previousTransactions);
            setJobs(previousJobs);
            setAssignmentMessage("");
          }
          setAssignmentImpactPreview({
            transaction,
            job,
            impact,
            options: { allocationPercent, replaceExisting },
          });
          return;
        }
      }
      if (usingDemo) {
        setTransactions((prev) => {
          const next = prev.map((txn) => {
            if (String(txn.id) !== String(transaction.id)) return txn;
            const currentRows = Array.isArray(txn.assignment_rows) ? txn.assignment_rows : [];
            const keptRows = replaceExisting
              ? currentRows.filter((row) => String(row.job_id) === String(job.id))
              : currentRows;
            const currentPercent = keptRows.reduce((sum, row) => sum + Number(row.allocation_percent || 0), 0);
            const availablePercent = Math.max(0, 100 - currentPercent);
            const percentToAssign = Math.min(allocationPercent, availablePercent);
            if (percentToAssign <= 0) return txn;
            const demoJob = { jobName: job.jobName || job.job_name || job.name || "Demo Job" };
            const allocatedAmount = Math.abs(Number(txn.amount || 0)) * (percentToAssign / 100);
            const signedAllocatedAmount = Number(txn.amount || 0) < 0 ? -allocatedAmount : allocatedAmount;
            const assignmentId = `demo-assignment-${txn.id}-${job.id}-${Date.now()}`;
            const newRow = {
              ...txn,
              amount: signedAllocatedAmount,
              job_id: job.id,
              job_label: demoJob.jobName,
              assignment_id: assignmentId,
              assignment_row_id: assignmentId,
              allocation_percent: percentToAssign,
              allocated_amount: allocatedAmount,
              assignment_source: "manual_drag_drop",
              assignment_confidence: 1,
            };
            return hydrateDemoAssignmentMetadata(txn, [...keptRows, newRow]);
          });
          setJobs(buildDemoJobCostingJobs(next));
          return next;
        });
        setAssignmentMessage(`Transaction assigned to ${job.jobName}.`);
        closeAssignmentPicker();
        return;
      }
      const data = await safeFetch(apiUrl("/api/job-costing/assignments"), {
        method: "POST",
        body: {
          business_id: businessId,
          transaction_id: transaction.id,
          job_id: job.id,
          allocation_percent: allocationPercent,
          replace_existing: replaceExisting,
          impact_preview_confirmed: true,
        },
      });
      const nextTransactions = Array.isArray(data?.transactions) ? data.transactions : [];
      const nextJobs = filterActiveUiJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      setTransactions(nextTransactions);
      setJobs(nextJobs);
      writeJobCostingLiveCache(businessId, readOnly, { transactions: nextTransactions, jobs: nextJobs });
      setAssignmentMessage(data?.message || `Transaction assigned to ${job.jobName}.`);
      closeAssignmentPicker();
      void loadSuggestions();
    } catch (e) {
      if (optimisticApplied) {
        setTransactions(previousTransactions);
        setJobs(previousJobs);
      }
      setAssignmentError(e?.message || "Could not assign transaction.");
    } finally {
      setAssigningTransactionId("");
      setDraggedTransactionId("");
      setDraggedTransaction(null);
      setDragOverJobId("");
    }
  }, [businessId, closeAssignmentPicker, jobs, loadSuggestions, readOnly, transactions, usingDemo]);

  const markJobComplete = useCallback(async (job) => {
    if (!job?.id) return;
    setMarkingCompleteJobId(job.id);
    setAssignmentError("");
    setAssignmentMessage("");
    try {
      const completedAt = new Date().toISOString();
      if (usingDemo) {
        setJobs((prev) => prev.map((item) => (
          String(item.id || item.job_id) === String(job.id)
            ? {
                ...item,
                status: "completed",
                completed_at: completedAt,
                end_date: item.end_date || completedAt.slice(0, 10),
              }
            : item
        )));
        if (String(selectedJob?.id || "") === String(job.id)) setSelectedJob(null);
        setBucketMode("completed");
        return;
      }
      const data = await safeFetch(apiUrl(`/api/job-costing/jobs/${encodeURIComponent(job.id)}/complete`), {
        method: "POST",
        body: { business_id: businessId },
      });
      if (Array.isArray(data?.jobs)) {
        const nextJobs = filterActiveUiJobs(data.jobs);
        setJobs(nextJobs);
        writeJobCostingLiveCache(businessId, readOnly, { jobs: nextJobs });
      } else {
        await loadJobCosting();
      }
      if (String(selectedJob?.id || "") === String(job.id)) setSelectedJob(null);
      setBucketMode("completed");
      await loadSuggestions();
    } catch (e) {
      setAssignmentError(e?.message || "Could not mark job complete.");
    } finally {
      setMarkingCompleteJobId("");
    }
  }, [businessId, loadJobCosting, loadSuggestions, readOnly, selectedJob?.id, usingDemo]);

  const reopenJob = useCallback(async (job) => {
    if (!job?.id) return;
    setMarkingCompleteJobId(job.id);
    setAssignmentError("");
    setAssignmentMessage("");
    try {
      if (usingDemo) {
        setJobs((prev) => prev.map((item) => (
          String(item.id || item.job_id) === String(job.id)
            ? {
                ...item,
                status: "active",
                completed_at: null,
            }
          : item
      )));
      setBucketMode("live");
      return;
    }
      const data = await safeFetch(apiUrl(`/api/job-costing/jobs/${encodeURIComponent(job.id)}/reopen`), {
        method: "POST",
        body: { business_id: businessId },
      });
      if (Array.isArray(data?.jobs)) {
        const nextJobs = filterActiveUiJobs(data.jobs);
        setJobs(nextJobs);
        writeJobCostingLiveCache(businessId, readOnly, { jobs: nextJobs });
    } else {
      await loadJobCosting();
    }
    setBucketMode("live");
    await loadSuggestions();
    } catch (e) {
      setAssignmentError(e?.message || "Could not move job back to Live Jobs.");
    } finally {
      setMarkingCompleteJobId("");
    }
  }, [businessId, loadJobCosting, loadSuggestions, readOnly, usingDemo]);

  const revertCandidateJob = useCallback(async (job) => {
    if (!job?.id) return;
    setRevertingCandidateJobId(job.id);
    setAssignmentError("");
    setAssignmentMessage("");
    try {
      if (usingDemo) {
        setJobs((prev) => prev.filter((item) => String(item.id || item.job_id) !== String(job.id)));
        setJobCandidates((prev) => prev.map((candidate) => (
          String(candidate.confirmed_job_id) === String(job.id)
            ? { ...candidate, candidate_status: "pending", confirmed_job_id: null }
            : candidate
        )));
        setAssignmentMessage(`${getJobDisplayName(job)} moved back to Suggested Jobs.`);
        return;
      }
      const data = await safeFetch(apiUrl(`/api/job-costing/jobs/${encodeURIComponent(job.id)}/revert-to-candidate`), {
        method: "POST",
        body: { business_id: businessId },
      });
      if (Array.isArray(data?.jobs)) {
        const nextJobs = filterActiveUiJobs(data.jobs);
        setJobs(nextJobs);
        writeJobCostingLiveCache(businessId, readOnly, { jobs: nextJobs });
      } else {
        setJobs((prev) => {
          const nextJobs = prev.filter((item) => String(item.id || item.job_id) !== String(job.id));
          writeJobCostingLiveCache(businessId, readOnly, { jobs: nextJobs });
          return nextJobs;
        });
      }
      if (Array.isArray(data?.candidates)) {
        setJobCandidates(data.candidates);
        setJobCandidatesTotal(Number(data?.total_count ?? data.candidates.length) || data.candidates.length);
        writeJobCostingLiveCache(businessId, readOnly, {
          jobCandidates: data.candidates,
          jobCandidatesTotal: Number(data?.total_count ?? data.candidates.length) || data.candidates.length,
        });
      } else if (data?.candidate?.id) {
        setJobCandidates((prev) => {
          const nextCandidates = [data.candidate, ...prev.filter((candidate) => String(candidate.id) !== String(data.candidate.id))];
          writeJobCostingLiveCache(businessId, readOnly, { jobCandidates: nextCandidates });
          return nextCandidates;
        });
        setJobCandidatesTotal((prev) => {
          const nextTotal = Math.max(prev, prev + 1);
          writeJobCostingLiveCache(businessId, readOnly, { jobCandidatesTotal: nextTotal });
          return nextTotal;
        });
      }
      setAssignmentMessage(`${getJobDisplayName(job)} moved back to Suggested Jobs.`);
      void loadJobCosting();
    } catch (e) {
      setAssignmentError(e?.message || "Could not move that job back to Suggested Jobs.");
    } finally {
      setRevertingCandidateJobId("");
    }
  }, [businessId, loadJobCosting, readOnly, usingDemo]);

  const removeAssignment = useCallback(async (txn) => {
    if (!txn?.assignment_id) return;
    setRemovingAssignmentId(txn.assignment_id);
    setAssignmentError("");
    setAssignmentMessage("");
    try {
      if (usingDemo) {
        setTransactions((prev) => {
          const next = prev.map((item) => {
            if (String(item.id) !== String(txn.id)) return item;
            const currentRows = Array.isArray(item.assignment_rows) ? item.assignment_rows : [];
            const remainingRows = currentRows.filter((row) => String(row.assignment_id) !== String(txn.assignment_id));
            return hydrateDemoAssignmentMetadata(item, remainingRows);
          });
          setJobs(buildDemoJobCostingJobs(next));
          return next;
        });
        setAssignmentMessage("Transaction removed from job.");
        return;
      }
      const data = await safeFetch(apiUrl(`/api/job-costing/assignments/${encodeURIComponent(txn.assignment_id)}`), {
        method: "DELETE",
        body: { business_id: businessId },
      });
      const nextTransactions = Array.isArray(data?.transactions) ? data.transactions : [];
      const nextJobs = filterActiveUiJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      setTransactions(nextTransactions);
      setJobs(nextJobs);
      writeJobCostingLiveCache(businessId, readOnly, { transactions: nextTransactions, jobs: nextJobs });
      setAssignmentMessage(data?.message || "Transaction removed from job.");
      await loadSuggestions();
    } catch (e) {
      setAssignmentError(e?.message || "Could not remove assignment.");
    } finally {
      setRemovingAssignmentId("");
    }
  }, [businessId, loadSuggestions, readOnly, usingDemo]);

  const handleDragStart = useCallback((event, transaction) => {
    const assignedPercent = Number(transaction?.assigned_total_percent || 0);
    const remainingPercent = Math.max(0, Number(transaction?.remaining_percent ?? (100 - assignedPercent)));
    if (assignedPercent >= 99.999 || remainingPercent <= 0.001) {
      event.preventDefault();
      setAssignmentError("This transaction is already fully allocated.");
      return;
    }
    const dragPayload = {
      id: transaction.id,
      date: transaction.date,
      vendor: transaction.vendor || transaction.payee || "",
      description: getTransactionMemo(transaction),
      amount: Number(transaction.amount || 0),
      assigned_total_percent: assignedPercent,
      remaining_percent: remainingPercent,
      financial_role: transaction.financial_role,
      transaction_role: transaction.transaction_role,
      source_role: transaction.source_role,
      qbo_txn_type: transaction.qbo_txn_type,
      qbo_entity_type: transaction.qbo_entity_type,
      source_entity_type: transaction.source_entity_type,
      source_system: transaction.source_system,
      qbo_txn_id: transaction.qbo_txn_id,
    };
    setDraggedTransactionId(transaction.id);
    setDraggedTransaction(dragPayload);
    setAssignmentError("");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", transaction.id);
    event.dataTransfer.setData("application/json", JSON.stringify(dragPayload));
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedTransactionId("");
    setDraggedTransaction(null);
    setDragOverJobId("");
  }, []);

  const handleDragOverJob = useCallback((event, job) => {
    if (isCompletedJobStatus(job?.status)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverJobId(job.id);
  }, []);

  const handleDropOnJob = useCallback((event, job) => {
    event.preventDefault();
    if (isCompletedJobStatus(job?.status)) {
      setAssignmentError("Completed jobs are archived from assignment. Reopen the job before assigning more transactions.");
      setDragOverJobId("");
      return;
    }
    let payload = null;
    try {
      const rawPayload = event.dataTransfer.getData("application/json");
      payload = rawPayload ? JSON.parse(rawPayload) : null;
    } catch {
      payload = null;
    }
    const transactionId = payload?.id || event.dataTransfer.getData("text/plain") || draggedTransactionId;
    const transaction = transactions.find((txn) => String(txn.id) === String(transactionId)) || draggedTransaction;
    if (!transaction) return;
    const assignedPercent = Number(transaction.assigned_total_percent || 0);
    const remainingPercent = Math.max(0, Number(transaction.remaining_percent ?? (100 - assignedPercent)));
    if (assignedPercent >= 99.999 || remainingPercent <= 0.001) {
      setAssignmentError("This transaction is already fully allocated.");
      setDragOverJobId("");
      return;
    }
    const roleMeta = getTransactionRoleMeta(transaction);
    if (assignedPercent > 0 || roleMeta.key !== "cost") {
      openAssignmentPicker(transaction, job);
      setDragOverJobId("");
      return;
    }
    assignTransactionToJob(transaction, job, { allocationPercent: 100, replaceExisting: true });
  }, [assignTransactionToJob, draggedTransaction, draggedTransactionId, openAssignmentPicker, transactions]);

  const pickerJobs = currentJobRows;
  const pickerSelectedJob = pickerJobs.find((job) => String(job.id) === String(assignmentPickerJobId)) || null;
  const pickerRemainingPercent = assignmentPickerTxn
    ? Math.max(0, Number(assignmentPickerTxn.remaining_percent ?? (100 - Number(assignmentPickerTxn.assigned_total_percent || 0))))
    : 0;
  const pickerPercentNumber = Math.max(0, Math.min(Number(assignmentPickerPercent || 0), pickerRemainingPercent || 100));
  const pickerAllocatedAmount = assignmentPickerTxn
    ? Math.abs(Number(assignmentPickerTxn.amount || 0)) * (pickerPercentNumber / 100)
    : 0;
  const pickerRoleMeta = assignmentPickerTxn ? getTransactionRoleMeta(assignmentPickerTxn) : null;

  return (
    <div className="w-full px-3 pb-28 pt-0 md:px-4">
      <div className="mx-auto max-w-[1180px] space-y-4">
        <div>
          <ModuleHeader
            module="jobs"
            title="Job Costing"
            subtitle="Drag posted QuickBooks transactions into job buckets to track profitability in real time."
          />
        </div>

        {error ? (
          <div className="rounded-[18px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">{error}</div>
        ) : null}

        <div className="-mt-16 sm:-mt-20 lg:-mt-24">
          <JobAssignmentBoard
            transactions={transactions}
            jobs={currentJobRows}
            completedJobs={completedJobRows}
            bucketMode={bucketMode}
            setBucketMode={setBucketMode}
            marginTargets={marginTargets}
            qboGlAccounts={qboGlAccounts}
            suggestions={suggestions}
            suggestionsLoading={suggestionsLoading}
            jobCandidates={jobCandidates}
            jobCandidatesTotal={jobCandidatesTotal}
            transactionsError={transactionsError}
            jobsError={jobsError}
            jobCandidatesError={jobCandidatesError}
            projectsCapability={projectsCapability}
            jobCandidateBusyId={jobCandidateBusyId}
            assignmentRef={assignmentRef}
            instruction={instruction}
            setInstruction={setInstruction}
            setAssignmentPreview={setAssignmentPreview}
            setAssignmentError={setAssignmentError}
            assignmentPreview={assignmentPreview}
            assignmentError={assignmentError}
            assignmentMessage={assignmentMessage}
            assignmentHistory={assignmentHistory}
            previewLoading={previewLoading}
            confirmingAssignment={confirmingAssignment}
            listening={listening}
            loading={loading}
            assigningId={assigningTransactionId}
            dragOverJobId={dragOverJobId}
            draggedTransactionId={draggedTransactionId}
            draggedTransaction={draggedTransaction}
            suggestionBusyId={suggestionBusyId}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOverJob={handleDragOverJob}
            onDragLeaveJob={() => setDragOverJobId("")}
            onDropOnJob={handleDropOnJob}
            onAssignClick={openAssignmentPicker}
            onViewAssigned={setViewAssignedJob}
            onOpenRevenueDetail={setRevenueDrawerJob}
            onRetrySummary={loadJobCosting}
            onMarkComplete={markJobComplete}
            onReopenJob={reopenJob}
            onRevertCandidateJob={revertCandidateJob}
            onDeleteJob={deleteManualJob}
            revertingCandidateJobId={revertingCandidateJobId}
            markingCompleteJobId={markingCompleteJobId}
            deletingJobId={deletingJobId}
            onAcceptSuggestion={acceptSuggestion}
            onRejectSuggestion={rejectSuggestion}
            onApproveCandidateNew={approveCandidateNew}
            onLinkCandidateExisting={linkCandidateExisting}
            onDismissCandidate={dismissJobCandidate}
            onMergeCandidates={mergeJobCandidates}
            onPreviewAssignment={previewAssignment}
            onConfirmAssignment={confirmAssignment}
            onCancelAssignment={cancelAssignment}
            onStartVoice={startVoice}
            onAddJob={readOnly ? null : () => setAddJobOpen(true)}
            onImportJobs={readOnly ? null : () => setImportJobsOpen(true)}
            onRefresh={loadJobCosting}
            readOnly={readOnly}
          />
        </div>

        {currentDetail ? (
          <JobDeepDive
            job={currentDetail}
            marginTargets={marginTargets}
            unassignedTransactions={unassignedTransactions}
            potentialChangeOrders={potentialChangeOrders.filter((suggestion) => String(suggestion.job_id) === String(currentDetail.id))}
            onBack={() => setSelectedJob(null)}
            onAssignMore={scrollToAssignment}
            onLogChangeOrder={saveChangeOrder}
            onPreviewChangeOrderPrice={previewChangeOrderPrice}
            onUpdateChangeOrder={updateChangeOrder}
            onConvertPotentialChangeOrder={convertPotentialChangeOrder}
            onDismissPotentialChangeOrder={dismissPotentialChangeOrder}
            changeOrderSaving={savingChangeOrder}
            changeOrderMessage={changeOrderMessage}
            readOnly={readOnly}
          />
        ) : null}

        {currentDetail ? (
          <section
            tabIndex={-1}
            className={`${glass} scroll-mt-4 p-4 outline-none sm:p-6`}
            aria-label="Assign more transactions"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Assign More Transactions</h2>
                <p className="mt-1 text-sm text-white/55">
                  Review unassigned Books transactions that may belong to {currentDetail.jobName}.
                </p>
              </div>
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs text-white/55">
                {unassignedTransactions.filter(isCostTransaction).length} cost candidates
              </span>
            </div>

            <div className="mt-4 grid gap-2">
              {unassignedTransactions.filter(isCostTransaction).slice(0, 5).map((txn) => (
                <div key={txn.id} className="grid gap-3 rounded-[16px] border border-white/8 bg-black/20 p-3 text-sm md:grid-cols-[0.8fr_1.5fr_1fr_0.7fr] md:items-center">
                  <div className="text-white/55">{formatDate(txn.date)}</div>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-white/85">{txn.vendor || "Unknown vendor"}</div>
                    <div className="truncate text-xs text-white/40">{getTransactionMemo(txn) || "No memo"}</div>
                  </div>
                  <div className="truncate text-white/60">{txn.gl_account || "Uncategorized"}</div>
                  <div className="font-semibold text-rose-100 md:text-right">{money.format(Math.abs(Number(txn.amount || 0)))}</div>
                </div>
              ))}
              {!unassignedTransactions.filter(isCostTransaction).length ? (
                <div className="rounded-[16px] border border-white/8 bg-white/[0.035] px-4 py-5 text-sm text-white/55">
                  No unassigned cost transactions are available right now.
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {assignmentPickerTxn ? (
          <div
            className={`fixed inset-0 z-[95] flex items-start justify-center bg-black/55 px-3 py-[6vh] backdrop-blur-sm transition-opacity duration-200 ease-out ${
              assignmentPickerVisible ? "opacity-100" : "opacity-0"
            }`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeAssignmentPicker();
            }}
          >
            <div className={`relative flex max-h-[54vh] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border border-white/10 bg-[#1b201e] p-3 shadow-[0_28px_80px_rgba(0,0,0,0.55)] transition-all duration-200 ease-out sm:p-4 ${
              assignmentPickerVisible ? "translate-y-0 scale-100 opacity-100" : "translate-y-3 scale-[0.97] opacity-0"
            }`}>
              <div className="flex shrink-0 items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/70">Split Assignment</p>
                  <h2 className="mt-0.5 text-base font-semibold text-white">Allocate to job</h2>
                  <p className="mt-1 text-sm text-white/50">
                    {assignmentPickerTxn.vendor || assignmentPickerTxn.payee || "Posted transaction"} • {money.format(Number(assignmentPickerTxn.amount || 0))}
                  </p>
                  <p className="mt-1 text-xs text-white/40">
                    {Math.round(Number(assignmentPickerTxn.assigned_total_percent || 0))}% assigned · {Math.round(pickerRemainingPercent)}% remaining
                  </p>
                  {pickerRoleMeta ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${compactBadgeClass(pickerRoleMeta.tone)}`}>
                        {pickerRoleMeta.source} · {pickerRoleMeta.label}
                      </span>
                      <span className="max-w-sm text-[11px] leading-snug text-white/45">{pickerRoleMeta.effect}</span>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={closeAssignmentPicker}
                  className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs font-semibold text-white/65 hover:bg-white/[0.1]"
                >
                  Cancel
                </button>
              </div>
              <div
                className="custom-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-10 pr-1"
                onScroll={(event) => {
                  const target = event.currentTarget;
                  setAssignmentPickerAtBottom(target.scrollTop + target.clientHeight >= target.scrollHeight - 8);
                }}
              >
                <div className="grid gap-2">
                  {pickerJobs.map((job) => (
                    <button
                      key={job.id || job.jobName}
                      type="button"
                      onClick={() => {
                        setAssignmentPickerJobId(job.id);
                        setAssignmentPickerAtBottom(false);
                      }}
                      disabled={assigningTransactionId === assignmentPickerTxn.id}
                      className={`rounded-[15px] border px-3 py-2 text-left transition disabled:opacity-55 ${
                        String(assignmentPickerJobId) === String(job.id)
                          ? "border-emerald-300/40 bg-emerald-300/[0.09]"
                          : "border-white/10 bg-black/20 hover:border-emerald-300/30 hover:bg-emerald-300/[0.06]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-semibold text-white">{job.jobName}</div>
                          <div className="truncate text-[11px] text-white/45">{job.customerName}</div>
                        </div>
                        <div className="shrink-0 text-[11px] text-white/45">{job.transactions?.length || 0} assigned</div>
                      </div>
                    </button>
                  ))}
                  {!pickerJobs.length ? (
                    <div className="rounded-[14px] border border-white/10 bg-white/[0.035] px-4 py-4 text-sm text-white/55">
                      No active jobs are available to assign this transaction.
                    </div>
                  ) : null}
                </div>
                <div className="mt-3 rounded-[16px] border border-white/10 bg-black/20 p-3">
                  {pickerRoleMeta?.key === "unmatched_inflow" ? (
                    <div className="mb-3 rounded-[14px] border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-[11px] leading-snug text-amber-50/78">
                      This inflow is ambiguous. Confirm only after choosing whether it is separate job revenue or a payment for an existing invoice.
                    </div>
                  ) : null}
                  <label className="block">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/40">Allocation percent</span>
                    <input
                      type="number"
                      min="1"
                      max={Math.max(1, pickerRemainingPercent)}
                      step="1"
                      value={assignmentPickerPercent}
                      onChange={(event) => setAssignmentPickerPercent(event.target.value)}
                      className="mt-2 h-10 w-full rounded-[12px] border border-white/10 bg-black/25 px-3 text-sm text-white outline-none focus:border-emerald-300/45"
                    />
                  </label>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-[12px] bg-white/[0.04] p-2.5">
                      <div className="text-[9px] uppercase tracking-wide text-white/35">Calculated amount</div>
                      <div className="mt-0.5 font-semibold text-white">{money.format(pickerAllocatedAmount)}</div>
                    </div>
                    <div className="rounded-[12px] bg-white/[0.04] p-2.5">
                      <div className="text-[9px] uppercase tracking-wide text-white/35">Remaining available</div>
                      <div className="mt-0.5 font-semibold text-white">{Math.round(pickerRemainingPercent)}%</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!pickerSelectedJob) return;
                      assignTransactionToJob(assignmentPickerTxn, pickerSelectedJob, {
                        allocationPercent: pickerPercentNumber,
                        replaceExisting: Number(assignmentPickerTxn.assigned_total_percent || 0) <= 0,
                      });
                    }}
                    disabled={!pickerSelectedJob || pickerPercentNumber <= 0 || pickerPercentNumber > pickerRemainingPercent || assigningTransactionId === assignmentPickerTxn.id}
                    className="mt-3 w-full rounded-full border border-emerald-300/35 bg-emerald-300/14 px-4 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/22 disabled:opacity-50"
                  >
                    {assigningTransactionId === assignmentPickerTxn.id ? "Assigning..." : "Confirm allocation"}
                  </button>
                </div>
              </div>
              {assignmentPickerJobId && !assignmentPickerAtBottom ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-emerald-300/22 bg-black/45 text-emerald-100/75 shadow-[0_10px_24px_rgba(0,0,0,0.35)] backdrop-blur"
                >
                  <ChevronDown className="h-3.5 w-3.5 animate-bounce" />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {assignedModalJob ? (
          <AssignedTransactionsModal
            job={assignedModalJob}
            onClose={() => setViewAssignedJob(null)}
            onRemove={removeAssignment}
            removingId={removingAssignmentId}
          />
        ) : null}
        <RevenueDetailDrawer job={revenueDrawerJob} onClose={() => setRevenueDrawerJob(null)} />
        <AddJobDrawer
          open={addJobOpen}
          onClose={() => setAddJobOpen(false)}
          onSubmit={createManualJob}
          projectsCapability={projectsCapability}
          submitting={creatingManualJob}
        />
        <ImportJobsDrawer
          open={importJobsOpen}
          onClose={() => setImportJobsOpen(false)}
          projectsCapability={projectsCapability}
          onSyncProjects={syncQboProjects}
          onGenerateCandidates={generateJobCandidates}
          loading={importJobsLoading}
        />
        <AssignmentImpactModal
          preview={assignmentImpactPreview}
          busy={Boolean(assigningTransactionId)}
          onCancel={() => {
            setAssignmentImpactPreview(null);
            setAssigningTransactionId("");
          }}
          onConfirm={() => {
            if (!assignmentImpactPreview) return;
            const { transaction, job, options, impact } = assignmentImpactPreview;
            setAssignmentImpactPreview(null);
            assignTransactionToJob(transaction, job, { ...options, impactPreview: impact, previewConfirmed: true });
          }}
        />
        <CandidateApprovalImpactModal
          preview={candidateApprovalPreview}
          busy={Boolean(jobCandidateBusyId)}
          onCancel={() => {
            setCandidateApprovalPreview(null);
            setJobCandidateBusyId("");
          }}
          onConfirm={() => {
            if (!candidateApprovalPreview) return;
            const { candidate, jobId, mode } = candidateApprovalPreview;
            setCandidateApprovalPreview(null);
            if (mode === "link_existing") linkCandidateExisting({ ...candidate, __previewConfirmed: true }, jobId);
            else approveCandidateNew({ ...candidate, __previewConfirmed: true });
          }}
        />
      </div>
    </div>
  );
}

function AssignedTransactionsModal({ job, onClose, onRemove, removingId }) {
  const [visible, setVisible] = useState(false);
  const closeTimerRef = useRef(null);
  const assigned = (Array.isArray(job?.transactions) ? job.transactions : [])
    .slice()
    .sort((a, b) => Date.parse(b.date || b.transaction_date || 0) - Date.parse(a.date || a.transaction_date || 0));
  const assignedBasis = getJobRevenueBasisView(job || {});
  const assignedRevenue = Number(assignedBasis.amount || 0);
  const assignedCost = Number(job?.total_assigned_cost ?? job?.assigned_cost_total ?? job?.total_cost ?? 0);
  const assignedMargin = Number(job?.margin_percent);
  const closeModal = useCallback(() => {
    setVisible(false);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(onClose, 220);
  }, [onClose]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setVisible(true));
    return () => {
      window.cancelAnimationFrame(frame);
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeModal]);
  return (
    <div
      className={`fixed inset-0 z-[90] flex items-start justify-center bg-black/55 px-3 pt-[10vh] backdrop-blur-sm transition-opacity duration-200 ease-out ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeModal();
      }}
    >
      <div className={`w-full max-w-[820px] overflow-hidden rounded-[22px] border border-emerald-300/25 bg-[#17211d]/98 shadow-[0_24px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl transition-all duration-200 ease-out ${
        visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-3 scale-[0.97] opacity-0"
      }`}>
        <div className="flex items-start justify-between gap-4 border-b border-white/8 p-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.16em] text-emerald-200/70">Job Transactions</p>
            <h2 className="mt-1 truncate text-lg font-semibold text-white">{job?.jobName || "Job"}</h2>
            <p className="mt-1 truncate text-sm text-white/50">{job?.customerName || job?.customer_name || "Unknown customer"}</p>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-lg leading-none text-white/70 hover:border-emerald-300/30 hover:bg-emerald-300/10 hover:text-white"
            aria-label="Close assigned transactions"
          >
            ×
          </button>
        </div>

        <div className="grid gap-3 border-b border-white/8 px-4 py-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">Assigned</div>
            <div className="mt-1 font-semibold text-white">{assigned.length}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">{assignedBasis.shortLabel || "Revenue"}</div>
            <div className="mt-1 font-semibold text-emerald-100">{money.format(assignedRevenue)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">Cost</div>
            <div className="mt-1 font-semibold text-rose-100">{money.format(assignedCost)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">Margin %</div>
            <div className="mt-1 font-semibold text-white">
              {Number.isFinite(assignedMargin) ? `${percent.format(assignedMargin)}%` : "—"}
            </div>
          </div>
        </div>

        {assigned.length ? (
          <div className="custom-scrollbar max-h-[50vh] overflow-y-auto px-3 py-2">
            <div className="hidden grid-cols-[0.65fr_1fr_1.35fr_1fr_0.75fr_0.65fr_0.75fr] gap-3 border-b border-white/8 px-2 pb-1.5 text-[10px] uppercase tracking-[0.12em] text-white/38 lg:grid">
              <div>Date</div>
              <div>Vendor / Payee</div>
              <div>Description</div>
              <div>GL Account</div>
              <div className="text-right">Amount</div>
              <div>Allocation</div>
              <div className="text-right">Action</div>
            </div>
            <div className="divide-y divide-white/6 overflow-hidden rounded-[18px] border border-white/8 bg-black/15 lg:rounded-none lg:border-0 lg:bg-transparent">
              {assigned.map((txn) => {
                const amount = Number(txn.amount || 0);
                const allocatedAmount = Math.abs(Number(txn.allocated_amount ?? txn.amount ?? 0));
                const signedAllocatedAmount = amount < 0 ? -allocatedAmount : allocatedAmount;
                return (
                  <div
                    key={txn.assignment_id || `${txn.id}-${txn.job_id}`}
                    className="grid gap-2.5 px-3 py-2 text-[13px] hover:bg-white/[0.035] lg:grid-cols-[0.65fr_1fr_1.35fr_1fr_0.75fr_0.65fr_0.75fr] lg:items-center"
                  >
                    <div className="text-white/60">{formatDate(txn.date || txn.transaction_date)}</div>
                    <div className="min-w-0 truncate font-semibold text-white/85">{txn.vendor || txn.payee || "Unknown payee"}</div>
                    <div className="min-w-0 truncate text-white/55">{getTransactionMemo(txn) || "No memo"}</div>
                    <div className="min-w-0">
                      <span className="inline-flex max-w-full rounded-full border border-emerald-300/20 bg-emerald-300/[0.08] px-2 py-0.5 text-[10px] font-semibold text-emerald-100">
                        <span className="truncate">{txn.gl_account || txn.final_qbo_account_name || "Uncategorized"}</span>
                      </span>
                    </div>
                    <div className={`font-semibold lg:text-right ${signedAllocatedAmount < 0 ? "text-rose-100" : "text-emerald-100"}`}>
                      {money.format(signedAllocatedAmount)}
                    </div>
                    <div className="text-white/60">{Number(txn.allocation_percent || 100)}%</div>
                    <div className="lg:text-right">
                      <button
                        type="button"
                        onClick={() => onRemove(txn)}
                        disabled={!txn.assignment_id || removingId === txn.assignment_id}
                        className="rounded-full border border-rose-300/25 bg-rose-300/10 px-2.5 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-300/16 disabled:opacity-45"
                      >
                        {removingId === txn.assignment_id ? "Removing..." : "Remove"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-3">
            <div className="rounded-[16px] border border-white/10 bg-white/[0.035] px-4 py-6 text-center text-sm text-white/55">
              No transactions assigned to this job yet.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function shouldRunDailySync(lastSyncedAt, businessId) {
  if (!businessId) return false;
  const now = Date.now();
  const lastSync = Date.parse(lastSyncedAt || "");
  if (Number.isFinite(lastSync) && now - lastSync < DAILY_AR_SYNC_MS) return false;
  try {
    const key = `bizzy:arDailySync:${businessId}`;
    const lastAttempt = Date.parse(localStorage.getItem(key) || "");
    if (Number.isFinite(lastAttempt) && now - lastAttempt < DAILY_AR_SYNC_MS) return false;
    localStorage.setItem(key, new Date(now).toISOString());
  } catch {
    // If storage is unavailable, still let the server-backed sync run.
  }
  return true;
}

export default function JobsDashboard() {
  const location = useLocation();
  const { currentBusiness } = useBusiness?.() || {};
  const adminView = useAdminView();
  const readOnly = adminView.active && adminView.readOnly;
  const businessId = adminView.active ? adminView.businessId : (currentBusiness?.id || localStorage.getItem("currentBusinessId") || "");

  const [openInvoices, setOpenInvoices] = useState([]);
  const [hero, setHero] = useState(null);
  const [loading, setLoading] = useState(true);
  const [arStatus, setArStatus] = useState({ last_synced_at: null, open_count: null });
  const [syncingAr, setSyncingAr] = useState(false);
  const [arError, setArError] = useState("");
  const [followupOverrides, setFollowupOverrides] = useState({});
  const [demoModeVersion, setDemoModeVersion] = useState(0);

  const integrationManager = useIntegrationManager({ businessId });
  const { getStatus, markStatus } = integrationManager;
  const qbStatus = getStatus("quickbooks")?.status || (adminView.active ? "loading" : "disconnected");
  const qbStatusLoading = adminView.active && ["loading", "connecting"].includes(qbStatus);

  const usingDemo = useMemo(() => {
    void demoModeVersion;
    return shouldUseDemoData(currentBusiness || businessId);
  }, [businessId, currentBusiness, demoModeVersion]);
  const canView = usingDemo || qbStatus === "connected";
  const normalizedPath = location.pathname.replace(/\/+$/, "");
  const isJobsBase = normalizedPath === "/dashboard/leads-jobs" || normalizedPath === "/dashboard/jobs";
  const isJobCosting = isJobsBase || location.pathname.includes("/job-costing");
  const isBidBuilder = location.pathname.includes("/bid-builder");
  const isChangeOrders = location.pathname.includes("/change-orders");

  useEffect(() => {
    const refreshDemoMode = () => setDemoModeVersion((version) => version + 1);
    window.addEventListener("bizzy:demo-mode-changed", refreshDemoMode);
    window.addEventListener("storage", refreshDemoMode);
    return () => {
      window.removeEventListener("bizzy:demo-mode-changed", refreshDemoMode);
      window.removeEventListener("storage", refreshDemoMode);
    };
  }, []);

  const refreshAr = useCallback(async ({ force = true, quiet = false } = {}) => {
    if (!businessId || usingDemo) return;
    if (readOnly) {
      if (!quiet) setArError("Live QuickBooks refresh is unavailable in read-only Admin View.");
      return;
    }
    if (!quiet) setSyncingAr(true);
    setArError("");
    try {
      await safeFetch(apiUrl("/api/ar/sync/open-items"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_id: businessId, force }),
      });
      const [refreshed, status] = await Promise.all([
        getJobsTopUnpaid(businessId),
        getArStatus(businessId),
      ]);
      setOpenInvoices(refreshed || []);
      if (status) setArStatus(status);
    } catch (e) {
      console.warn("[JobsDashboard] AR sync failed", e?.message || e);
      setArError(e?.message || "Failed to refresh QuickBooks AR.");
    } finally {
      if (!quiet) setSyncingAr(false);
    }
  }, [businessId, readOnly, usingDemo]);

  const reloadOpenInvoices = useCallback(async () => {
    if (!businessId || usingDemo) return;
    const refreshed = await getJobsTopUnpaid(businessId);
    setOpenInvoices(refreshed || []);
  }, [businessId, usingDemo]);

  const applyFollowupOverride = useCallback((row, round, patch) => {
    const key = getInvoiceKey(row);
    setFollowupOverrides((prev) => {
      const current = prev[key] || {};
      const rounds = Array.isArray(current.rounds) ? [...current.rounds] : [];
      const idx = rounds.findIndex((item) => Number(item.round) === Number(round));
      const nextRound = {
        ...(idx >= 0 ? rounds[idx] : {}),
        round,
        ...patch,
      };
      if (idx >= 0) rounds[idx] = nextRound;
      else rounds.push(nextRound);
      const sentRounds = rounds.filter((item) => item.status === "sent");
      const draftedRounds = rounds.filter((item) => item.status === "drafted" || item.status === "draft");
      const scheduledRounds = rounds.filter((item) => item.status === "scheduled");
      const latest = (items, field) =>
        items
          .map((item) => item[field])
          .filter(Boolean)
          .sort()
          .at(-1) || null;
      const earliest = (items, field) =>
        items
          .map((item) => item[field])
          .filter(Boolean)
          .sort()[0] || null;
      return {
        ...prev,
        [key]: {
          ...current,
          rounds,
          sent_count: sentRounds.length,
          draft_count: draftedRounds.length,
          last_sent_at: latest(sentRounds, "sent_at") || current.last_sent_at || null,
          last_drafted_at: latest(draftedRounds, "drafted_at") || current.last_drafted_at || null,
          next_scheduled_at: earliest(scheduledRounds, "scheduled_for") || null,
        },
      };
    });
  }, []);

  const draftFollowup = useCallback(async (row, round) => {
    const draft = buildEmailCopy(row, round);
    const now = new Date().toISOString();
    applyFollowupOverride(row, round, {
      status: "drafted",
      subject: draft.subject,
      body: draft.body,
      drafted_at: now,
      scheduled_for: null,
    });
    const qboInvoiceId = row.qbo_invoice_id;
    if (readOnly) {
      setArError("Follow-up generation is unavailable in read-only Admin View.");
      return;
    }
    if (usingDemo || !businessId || !qboInvoiceId) return;
    setArError("");
    try {
      await safeFetch(apiUrl("/api/ar/followups/draft"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_id: businessId,
          qbo_invoice_id: qboInvoiceId,
          round,
        }),
      });
      await reloadOpenInvoices();
    } catch (e) {
      console.warn("[JobsDashboard] draft follow-up failed", e?.message || e);
      setArError(e?.message || "Failed to generate follow-up copy.");
    }
  }, [applyFollowupOverride, businessId, readOnly, reloadOpenInvoices, usingDemo]);

  const markFollowupSent = useCallback(async (row, round, copy = {}) => {
    const sentAt = new Date();
    applyFollowupOverride(row, round, {
      status: "sent",
      subject: copy.subject,
      body: copy.body,
      drafted_at: sentAt.toISOString(),
      sent_at: sentAt.toISOString(),
      scheduled_for: null,
    });
    if (round < 3) {
      const scheduledFor = new Date(sentAt);
      scheduledFor.setDate(scheduledFor.getDate() + 7);
      const nextDraft = buildEmailCopy(row, round + 1);
      applyFollowupOverride(row, round + 1, {
        status: "scheduled",
        subject: nextDraft.subject,
        body: nextDraft.body,
        scheduled_for: scheduledFor.toISOString(),
      });
    }
    const qboInvoiceId = row.qbo_invoice_id;
    if (readOnly) {
      setArError("Follow-up updates are unavailable in read-only Admin View.");
      return;
    }
    if (usingDemo || !businessId || !qboInvoiceId) return;
    setArError("");
    try {
      await safeFetch(apiUrl("/api/ar/followups/mark-sent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_id: businessId,
          qbo_invoice_id: qboInvoiceId,
          round,
          subject: copy.subject,
          body: copy.body,
        }),
      });
      await reloadOpenInvoices();
    } catch (e) {
      console.warn("[JobsDashboard] mark follow-up sent failed", e?.message || e);
      setArError(e?.message || "Failed to mark follow-up sent.");
    }
  }, [applyFollowupOverride, businessId, readOnly, reloadOpenInvoices, usingDemo]);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!businessId || !canView) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setArError("");
      const [u, statusResult] = await Promise.allSettled([
        getJobsTopUnpaid(businessId),
        usingDemo ? Promise.resolve(null) : getArStatus(businessId),
      ]);
      if (!alive) return;
      const nextStatus = statusResult.status === "fulfilled" ? statusResult.value : null;
      setOpenInvoices(u.status === "fulfilled" ? (u.value || []) : []);
      if (nextStatus) setArStatus(nextStatus);
      setLoading(false);
      if (!readOnly && !usingDemo && qbStatus === "connected" && shouldRunDailySync(nextStatus?.last_synced_at, businessId)) {
        refreshAr({ force: false, quiet: true });
      }
    }
    load();
    return () => { alive = false; };
  }, [businessId, canView, qbStatus, readOnly, refreshAr, usingDemo]);

  const usingMock = usingDemo;

  useEffect(() => {
    if (usingMock) {
      setHero({
        id: "mock-jobs-hero",
        title: "Collect on the oldest open invoices first",
        summary:
          "Bizzi is watching AR by invoice and drafting follow-ups for past-due balances.",
        metric: "3-step cadence",
        severity: "good",
        dismissible: true,
      });
    } else {
      setHero(null);
    }
  }, [usingMock]);

  useEffect(() => {
    if (!usingDemo) return;
    ["jobber"].forEach((provider) => {
      const status = getStatus(provider);
      if (status?.status === "connected") {
        markStatus(provider, "disconnected");
      }
    });
  }, [getStatus, markStatus, usingDemo]);

  const invoiceRows = useMemo(() => {
    const rows = usingMock ? getDemoJobsTopUnpaid() : openInvoices || [];
    return rows.map((row) => ({
      ...row,
      client_name: row.client_name || row.title,
      due_date: row.due_date || null,
      days_overdue: row.days_overdue ?? (row.id === "mock-unpaid-1" ? 18 : row.id === "mock-unpaid-2" ? 8 : 0),
      followups: mergeFollowupState(row.followups || {
        sent_count: row.id === "mock-unpaid-1" ? 1 : 0,
        draft_count: row.id === "mock-unpaid-2" ? 1 : 0,
        last_sent_at: row.id === "mock-unpaid-1" ? new Date(Date.now() - 3 * 86400000).toISOString() : null,
        last_drafted_at: row.id === "mock-unpaid-2" ? new Date(Date.now() - 1 * 86400000).toISOString() : null,
        next_scheduled_at: row.id === "mock-unpaid-1" ? new Date(Date.now() + 4 * 86400000).toISOString() : null,
        rounds: [],
      }, followupOverrides[getInvoiceKey(row)]),
    }));
  }, [followupOverrides, openInvoices, usingMock]);

  if (qbStatusLoading) {
    return (
      <div className="w-full px-3 md:px-4 pt-0 pb-4">
        <div className="max-w-[1100px] mx-auto space-y-4">
          <ModuleHeader module="jobs" subtitle="Loading persisted QuickBooks status for Admin View." />
          <SkeletonCard lines={5} />
        </div>
      </div>
    );
  }

  if (!canView) {
    return <LiveModePlaceholder title="Connect QuickBooks to view Jobs" />;
  }

  if (isChangeOrders) {
    return <JobsFeatureComingSoon title="Change Orders" />;
  }

  if (isBidBuilder) {
    return <JobsFeatureComingSoon title="Bid Builder" />;
  }

  if (isJobCosting) {
    return <JobCostingPage businessId={businessId} usingDemo={usingDemo} readOnly={readOnly} />;
  }

  return (
    <div className="w-full px-3 md:px-4 pt-0 pb-4">
      <div className="max-w-[1100px] mx-auto space-y-4">
        <ModuleHeader
          module="jobs"
          subtitle="Track collections and overdue invoices from QuickBooks."
          hero={hero}
          onDismissHero={() => setHero(null)}
        />

        {loading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <SkeletonCard lines={5} />
            <SkeletonCard lines={5} />
          </div>
        ) : (
          <AgingChart
            rows={invoiceRows}
            status={arStatus}
            refreshing={syncingAr}
            onRefresh={() => refreshAr({ force: true })}
            showRefresh={!usingDemo && qbStatus === "connected"}
          />
        )}

        {arError ? (
          <div className="rounded-[18px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
            {arError}
          </div>
        ) : null}

        {loading ? <SkeletonCard lines={5} /> : <OutstandingInvoices rows={invoiceRows} />}

        {loading ? (
          <SkeletonCard lines={5} />
        ) : (
          <ArTracker
            rows={invoiceRows}
            onDraftFollowup={draftFollowup}
            onMarkSent={markFollowupSent}
          />
        )}
      </div>
    </div>
  );
}
