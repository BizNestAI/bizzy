import React from "react";
import { CheckCircle2 } from "lucide-react";
import useFinancialMonthlyReviewStamp from "../../hooks/useFinancialMonthlyReviewStamp.js";

export default function FinancialMonthlyReviewStamp({
  businessId,
  period = null,
  className = "",
}) {
  const { stamp } = useFinancialMonthlyReviewStamp({ businessId, period });
  if (!stamp) return null;

  const monthLabel = formatReviewMonth(stamp.review_month);
  const completedLabel = formatCompletedAt(stamp.completed_at);
  const statusLabel = stamp.status === "closed" ? "Closed" : "Finalized";
  const title = completedLabel
    ? `${monthLabel} ${statusLabel.toLowerCase()} after monthly human review on ${completedLabel}.`
    : `${monthLabel} ${statusLabel.toLowerCase()} after monthly human review.`;

  return (
    <div
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-emerald-300/22 bg-emerald-300/[0.075] px-2.5 py-1 text-[11px] font-medium text-emerald-100 shadow-[0_10px_30px_rgba(0,0,0,0.22)] ${className}`}
      title={title}
      aria-label={title}
    >
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-200/90" />
      <span className="truncate">{monthLabel} {statusLabel}</span>
    </div>
  );
}

function formatReviewMonth(value) {
  const date = parseMonth(value);
  if (!date) return "Monthly review";
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function formatCompletedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function parseMonth(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return Number.isNaN(date.getTime()) ? null : date;
}
