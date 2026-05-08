import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { getJobsTopUnpaid, getArStatus } from "../../services/jobs/jobs";
import { getDemoJobsTopUnpaid } from "./jobsMockData.js";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";
import { useBusiness } from "../../context/BusinessContext.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { apiUrl, safeFetch } from "../../utils/safeFetch.js";

const DAILY_AR_SYNC_MS = 24 * 60 * 60 * 1000;

const glass =
  "rounded-[28px] bg-white/[0.04] border-0 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

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

function AgingChart({ rows, status, refreshing, onRefresh }) {
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
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="px-3 py-1.5 text-sm rounded-full border border-white/25 text-white bg-white/[0.08] hover:bg-white/[0.15] disabled:opacity-60 transition shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
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
          <div className="grid grid-cols-[1.25fr,0.8fr,0.7fr,0.65fr,0.7fr] gap-3 px-4 py-3 text-[11px] uppercase tracking-wide text-white/45 border-b border-white/8">
            <div>Customer</div>
            <div>Invoice</div>
            <div>Due</div>
            <div>Status</div>
            <div className="text-right">Balance</div>
          </div>
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

const demoJobCostingTransactions = [
  {
    id: "demo-job-cost-1",
    date: "2026-05-03",
    vendor: "Home Depot",
    description: "Deck materials",
    amount: -842.33,
    direction: "OUTFLOW",
    gl_account: "Job Materials",
    status: "auto_approved",
    job_label: "Johnson Deck Rebuild",
    assignment_source: "natural_language",
    assignment_confidence: 0.91,
  },
  {
    id: "demo-job-cost-2",
    date: "2026-05-02",
    vendor: "Amazon Business",
    description: "Fasteners and site supplies",
    amount: -214.19,
    direction: "OUTFLOW",
    gl_account: "Job Supplies",
    status: "needs_review",
    job_label: null,
    assignment_source: null,
    assignment_confidence: null,
  },
  {
    id: "demo-job-cost-3",
    date: "2026-05-01",
    vendor: "Hawthorne Builders",
    description: "Progress invoice",
    amount: 4200,
    direction: "INFLOW",
    gl_account: "Construction Income",
    status: "posted",
    job_label: "Hawthorne Porch",
    assignment_source: "auto_match",
    assignment_confidence: 0.88,
  },
];

function JobCostingPage({ businessId, usingDemo }) {
  const [transactions, setTransactions] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);

  const loadJobCosting = useCallback(async () => {
    if (usingDemo) {
      setTransactions(demoJobCostingTransactions);
      setJobs([
        { id: "demo-job-1", title: "Johnson Deck Rebuild", status: "in_progress" },
        { id: "demo-job-2", title: "Hawthorne Porch", status: "completed" },
      ]);
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
      const data = await safeFetch(apiUrl(`/api/jobs/job-costing?business_id=${encodeURIComponent(businessId)}`));
      setTransactions(Array.isArray(data?.transactions) ? data.transactions : []);
      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch (e) {
      console.warn("[JobCosting] load failed", e?.message || e);
      setError(e?.message || "Failed to load job costing.");
    } finally {
      setLoading(false);
    }
  }, [businessId, usingDemo]);

  useEffect(() => {
    loadJobCosting();
  }, [loadJobCosting]);

  const metrics = useMemo(() => {
    const assigned = transactions.filter((txn) => txn.job_label);
    const unassigned = transactions.length - assigned.length;
    const revenue = assigned.reduce((sum, txn) => sum + (Number(txn.amount) > 0 ? Number(txn.amount) : 0), 0);
    const costs = assigned.reduce((sum, txn) => sum + (Number(txn.amount) < 0 ? Math.abs(Number(txn.amount)) : 0), 0);
    return {
      assigned: assigned.length,
      unassigned,
      revenue,
      costs,
      margin: revenue - costs,
    };
  }, [transactions]);

  const runAssignment = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    setAssigning(true);
    setError("");
    setMessage("");
    try {
      if (usingDemo) {
        const lower = cleanPrompt.toLowerCase();
        const target = lower.includes("smith") ? "Smith Kitchen" : lower.includes("johnson") ? "Johnson Deck Rebuild" : "Johnson Deck Rebuild";
        const vendor = lower.includes("home depot") ? "home depot" : lower.includes("amazon") ? "amazon" : "";
        let assigned = 0;
        setTransactions((prev) =>
          prev.map((txn) => {
            const match = !vendor || `${txn.vendor} ${txn.description}`.toLowerCase().includes(vendor);
            if (match && Number(txn.amount) < 0) {
              assigned += 1;
              return { ...txn, job_label: target, assignment_source: "natural_language", assignment_confidence: 0.86 };
            }
            return txn;
          })
        );
        setMessage(`Assigned ${assigned} matching transactions to ${target}.`);
        return;
      }
      const data = await safeFetch(apiUrl("/api/jobs/job-costing/assign-natural-language"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_id: businessId, prompt: cleanPrompt }),
      });
      setTransactions(Array.isArray(data?.transactions) ? data.transactions : []);
      setJobs(Array.isArray(data?.jobs) ? data.jobs : jobs);
      setMessage(data?.message || `Assigned ${data?.assigned || 0} transactions${data?.job?.title ? ` to ${data.job.title}` : ""}.`);
    } catch (e) {
      console.warn("[JobCosting] assignment failed", e?.message || e);
      setError(e?.message || "Bizzi could not confidently apply that assignment.");
    } finally {
      setAssigning(false);
    }
  };

  const startVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Voice input is not available in this browser.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      setError("Voice input stopped before Bizzi caught the instruction.");
    };
    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript || "";
      if (text) setPrompt(text);
    };
    recognition.start();
  };

  return (
    <div className="w-full px-3 md:px-4 pt-0 pb-4">
      <div className="max-w-[1100px] mx-auto space-y-4">
        <ModuleHeader
          module="jobs"
          subtitle="Assign Books transactions to jobs with plain English, then let Bizzi learn the pattern."
        />

        <section className={`${glass} p-4 sm:p-6`} aria-label="Job costing command center">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/50">Job Costing</p>
              <h2 className="text-xl font-semibold text-white">Assign transactions by instruction</h2>
              <p className="mt-1 max-w-2xl text-sm text-white/55">
                Books still handles categorization and posting. This page maps those categorized transactions to jobs and projects.
              </p>
            </div>
            <button
              type="button"
              onClick={loadJobCosting}
              className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-sm font-semibold text-white/85 hover:bg-white/[0.12]"
            >
              Refresh
            </button>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-4">
            <div className="rounded-[18px] bg-white/[0.05] p-4">
              <div className="text-[11px] uppercase tracking-wide text-white/45">Assigned</div>
              <div className="mt-1 text-2xl font-semibold text-white">{metrics.assigned}</div>
            </div>
            <div className="rounded-[18px] bg-white/[0.05] p-4">
              <div className="text-[11px] uppercase tracking-wide text-white/45">Needs job</div>
              <div className="mt-1 text-2xl font-semibold text-amber-100">{metrics.unassigned}</div>
            </div>
            <div className="rounded-[18px] bg-white/[0.05] p-4">
              <div className="text-[11px] uppercase tracking-wide text-white/45">Job revenue</div>
              <div className="mt-1 text-2xl font-semibold text-white">{money.format(metrics.revenue)}</div>
            </div>
            <div className="rounded-[18px] bg-white/[0.05] p-4">
              <div className="text-[11px] uppercase tracking-wide text-white/45">Job margin</div>
              <div className="mt-1 text-2xl font-semibold text-white">{money.format(metrics.margin)}</div>
            </div>
          </div>

          <div className="mt-5 rounded-[20px] border border-[rgba(var(--accent-rgb),0.22)] bg-[rgba(var(--accent-rgb),0.08)] p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runAssignment();
                }}
                placeholder='Try: "Assign all Amazon expenses this month to the Johnson job"'
                className="min-w-0 flex-1 rounded-full border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder:text-white/35 outline-none focus:border-[rgba(var(--accent-rgb),0.55)]"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={startVoice}
                  className="rounded-full border border-white/15 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white/85 hover:bg-white/[0.12]"
                >
                  {listening ? "Listening..." : "Voice"}
                </button>
                <button
                  type="button"
                  onClick={runAssignment}
                  disabled={assigning || !prompt.trim()}
                  className="rounded-full border border-[rgba(var(--accent-rgb),0.45)] bg-[rgba(var(--accent-rgb),0.18)] px-4 py-3 text-sm font-semibold text-white hover:bg-[rgba(var(--accent-rgb),0.26)] disabled:opacity-60"
                >
                  {assigning ? "Assigning..." : "Assign"}
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/50">
              <span className="rounded-full bg-white/[0.05] px-2.5 py-1">Assign Home Depot from February 12 to Smith job</span>
              <span className="rounded-full bg-white/[0.05] px-2.5 py-1">Assign all Amazon expenses this month to Johnson job</span>
            </div>
          </div>
        </section>

        {error ? (
          <div className="rounded-[18px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">{error}</div>
        ) : null}
        {message ? (
          <div className="rounded-[18px] border border-[rgba(var(--accent-rgb),0.25)] bg-[rgba(var(--accent-rgb),0.1)] px-4 py-3 text-sm text-white">{message}</div>
        ) : null}

        <section className={`${glass} p-4 sm:p-6`} aria-label="Job costing transaction assignments">
          <div className="mb-4">
            <h3 className="text-lg font-semibold text-white">Books transactions mapped to jobs</h3>
            <p className="text-sm text-white/55">Revenue and expenses come from Books. Job assignment happens here.</p>
          </div>
          {loading ? (
            <SkeletonCard lines={6} />
          ) : !transactions.length ? (
            <div className="rounded-[18px] bg-white/[0.05] px-4 py-5 text-sm text-white/70">
              No transactions available yet. Sync Books first.
            </div>
          ) : (
            <div className="overflow-hidden rounded-[18px] bg-white/[0.04]">
              <div className="grid grid-cols-[0.7fr,1.2fr,0.75fr,1fr,1fr] gap-3 border-b border-white/8 px-4 py-3 text-[11px] uppercase tracking-wide text-white/45">
                <div>Date</div>
                <div>Transaction</div>
                <div className="text-right">Amount</div>
                <div>Books category</div>
                <div>Job / Project</div>
              </div>
              <div className="max-h-[520px] overflow-y-auto custom-scrollbar divide-y divide-white/6">
                {transactions.map((txn) => (
                  <div
                    key={txn.id}
                    className="grid grid-cols-[0.7fr,1.2fr,0.75fr,1fr,1fr] gap-3 px-4 py-3 text-sm items-center hover:bg-white/[0.04] transition"
                  >
                    <div className="text-white/60">{formatDate(txn.date)}</div>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-white">{txn.vendor || txn.description || "Unknown"}</div>
                      <div className="truncate text-[11px] text-white/45">{txn.description}</div>
                    </div>
                    <div className={`text-right font-semibold ${Number(txn.amount) < 0 ? "text-rose-100" : "text-emerald-100"}`}>
                      {money.format(Math.abs(Number(txn.amount || 0)))}
                    </div>
                    <div className="truncate text-white/70">{txn.gl_account}</div>
                    <div>
                      {txn.job_label ? (
                        <div>
                          <div className="truncate font-semibold text-white">{txn.job_label}</div>
                          <div className="text-[11px] text-white/45">
                            {txn.assignment_source || "assigned"}
                            {txn.assignment_confidence ? ` • ${Math.round(Number(txn.assignment_confidence) * 100)}%` : ""}
                          </div>
                        </div>
                      ) : (
                        <span className="rounded-full border border-amber-200/20 bg-amber-200/10 px-2.5 py-1 text-xs text-amber-100">
                          Needs job
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className={`${glass} p-4 sm:p-6`} aria-label="Autonomous job costing">
          <h3 className="text-lg font-semibold text-white">What Bizzi should automate next</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {[
              ["Learn repeat rules", "When you assign Home Depot to Johnson once, Bizzi should suggest the same mapping next time."],
              ["Flag uncertainty", "Low-confidence matches should land here for one-click review, not block Books."],
              ["Estimate job margin", "Revenue, materials, subs, and labor should roll into job-level profitability automatically."],
            ].map(([title, body]) => (
              <div key={title} className="rounded-[18px] border border-white/10 bg-white/[0.04] p-4">
                <div className="font-semibold text-white">{title}</div>
                <div className="mt-1 text-sm text-white/55">{body}</div>
              </div>
            ))}
          </div>
        </section>
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
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";

  const [openInvoices, setOpenInvoices] = useState([]);
  const [hero, setHero] = useState(null);
  const [loading, setLoading] = useState(true);
  const [arStatus, setArStatus] = useState({ last_synced_at: null, open_count: null });
  const [syncingAr, setSyncingAr] = useState(false);
  const [arError, setArError] = useState("");
  const [followupOverrides, setFollowupOverrides] = useState({});

  const integrationManager = useIntegrationManager({ businessId });
  const { getStatus, markStatus } = integrationManager;
  const qbStatus = getStatus("quickbooks")?.status;

  const usingDemo = useMemo(
    () => shouldUseDemoData(currentBusiness || businessId),
    [businessId, currentBusiness]
  );
  const canView = usingDemo || qbStatus === "connected";
  const isJobCosting = location.pathname.includes("/job-costing");

  const refreshAr = useCallback(async ({ force = true, quiet = false } = {}) => {
    if (!businessId || usingDemo) return;
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
  }, [businessId, usingDemo]);

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
  }, [applyFollowupOverride, businessId, reloadOpenInvoices, usingDemo]);

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
  }, [applyFollowupOverride, businessId, reloadOpenInvoices, usingDemo]);

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
      if (!usingDemo && qbStatus === "connected" && shouldRunDailySync(nextStatus?.last_synced_at, businessId)) {
        refreshAr({ force: false, quiet: true });
      }
    }
    load();
    return () => { alive = false; };
  }, [businessId, canView, qbStatus, refreshAr, usingDemo]);

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

  if (!canView) {
    return <LiveModePlaceholder title="Connect QuickBooks to view Jobs" />;
  }

  if (isJobCosting) {
    return <JobCostingPage businessId={businessId} usingDemo={usingDemo} />;
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
