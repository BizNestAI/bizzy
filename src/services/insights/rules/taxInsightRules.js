const DEFAULT_MODULE = "contractor_cfo";
const DAY_MS = 24 * 60 * 60 * 1000;

export const TAX_INSIGHT_CATEGORIES = Object.freeze({
  LIABILITY_CHANGE: "tax_liability_change",
  RESERVE_GAP: "tax_reserve_gap",
  PAYMENT_DUE: "tax_payment_due",
  SAFE_HARBOR_GAP: "tax_safe_harbor_gap",
  PROFILE_INCOMPLETE: "tax_profile_incomplete",
  ENTITY_UNKNOWN: "tax_entity_unknown",
  CLASSIFICATION_REVIEW: "tax_classification_review",
  STATE_UNAVAILABLE: "tax_state_unavailable",
  CONFIDENCE_LOW: "tax_confidence_low",
  SOURCE_STALE: "tax_source_stale",
  PAYMENT_MISSING: "tax_payment_missing",
  POSITIVE_PROGRESS: "tax_positive_progress",
  RULE_SUPPORT_CHANGED: "tax_rule_support_changed",
  PROJECTION_RISK: "tax_projection_risk",
  DEDUCTION_OPPORTUNITY: "tax_deduction_opportunity",
  CAPITALIZABLE_REVIEW: "tax_capitalizable_review",
});

const ROUTES = Object.freeze({
  overview: "/dashboard/tax",
  setup: "/dashboard/tax?setup=profile",
  deductions: "/dashboard/tax",
  needsReview: "/dashboard/tax",
  planning: "/dashboard/tax?section=planning",
  confidence: "/dashboard/tax?drawer=confidence",
  changes: "/dashboard/tax?drawer=changes",
  books: "/dashboard/accounting",
});

const DEFAULT_THRESHOLDS = Object.freeze({
  liabilityIncreaseAmount: 1000,
  liabilityIncreasePct: 0.1,
  reserveGapAmount: 2500,
  safeHarborGapAmount: 1000,
  reviewExposureAmount: 1000,
  reviewExposurePct: 0.05,
  staleDays: 7,
  positiveReserveImprovementAmount: 1000,
});

export const TAX_INSIGHT_RULES = [
  rule({
    id: "tax_material_liability_increase",
    category: TAX_INSIGHT_CATEGORIES.LIABILITY_CHANGE,
    severity: "warn",
    cooldownHours: 48,
    expiresInHours: 120,
    evaluate(ctx, t) {
      const change = ctx.changes?.changes?.projectedTotalTax;
      if (!change?.material || change.absoluteChange <= 0) return null;
      if (change.absoluteChange < t.liabilityIncreaseAmount && change.percentChange < t.liabilityIncreasePct) return null;
      if (confidenceLevel(ctx) === "unavailable") return null;
      const prefix = confidencePrefix(ctx);
      return candidate({
        ruleId: "tax_material_liability_increase",
        category: TAX_INSIGHT_CATEGORIES.LIABILITY_CHANGE,
        severity: confidenceLevel(ctx) === "low" ? "info" : "warn",
        confidenceScore: confidenceScore(ctx, 76),
        title: `Projected ${ctx.taxYear} tax increased`,
        body: `${prefix} projected ${ctx.taxYear} tax increased by ${money(change.absoluteChange)} since the last calculation.`,
        metrics: [{ label: "Tax increase", value: money(change.absoluteChange) }],
        actions: ["Review what changed", "Check reserve target", "Review deductions coverage"],
        cta: cta("View what changed", ROUTES.changes),
        dedupeKey: `tax_liability_change:${ctx.businessId}:${ctx.taxYear}:${ctx.currentRun?.id || "current"}`,
        refs: runRefs(ctx),
        materialityScore: Math.abs(change.absoluteChange),
      });
    },
  }),
  rule({
    id: "tax_reserve_gap",
    category: TAX_INSIGHT_CATEGORIES.RESERVE_GAP,
    severity: "warn",
    cooldownHours: 24,
    expiresInHours: 96,
    evaluate(ctx, t) {
      const gap = number(ctx.reserve?.reserveGap ?? ctx.reserve?.gap ?? ctx.summary?.reserveGap);
      const currentReserve = number(ctx.reserve?.currentReserve ?? ctx.reserve?.current_reserve ?? ctx.reserve?.balance);
      if (gap == null || gap < t.reserveGapAmount || currentReserve == null) return null;
      return candidate({
        ruleId: "tax_reserve_gap",
        category: TAX_INSIGHT_CATEGORIES.RESERVE_GAP,
        severity: gap >= t.reserveGapAmount * 3 ? "critical" : "warn",
        confidenceScore: confidenceScore(ctx, 78),
        title: "Tax reserve is below target",
        body: `${confidencePrefix(ctx)} you are ${money(gap)} below Bizzi's recommended tax reserve.`,
        metrics: [{ label: "Reserve gap", value: money(gap) }],
        actions: ["View reserve plan", "Update reserve account"],
        cta: cta("View reserve plan", ROUTES.planning),
        dedupeKey: `tax_reserve_gap:${ctx.businessId}:${ctx.taxYear}:${severityBand(gap, t.reserveGapAmount)}`,
        refs: runRefs(ctx),
        materialityScore: gap,
      });
    },
  }),
  rule({
    id: "tax_reserve_setup_incomplete",
    category: TAX_INSIGHT_CATEGORIES.RESERVE_GAP,
    severity: "warn",
    cooldownHours: 72,
    expiresInHours: 168,
    evaluate(ctx) {
      if (!estimateReady(ctx) || reserveReady(ctx)) return null;
      const missing = hasSetupCode(ctx, "reserve_setup_incomplete") || ctx.reserve?.currentReserve == null || ctx.reserve?.status === "setup_incomplete";
      if (!missing) return null;
      return candidate({
        ruleId: "tax_reserve_setup_incomplete",
        category: TAX_INSIGHT_CATEGORIES.RESERVE_GAP,
        confidenceScore: confidenceScore(ctx, 74),
        title: "Tax reserve tracking is not set up",
        body: "Your tax estimate is ready, but Bizzi cannot track what you have set aside until you select a reserve account.",
        metrics: [],
        actions: ["Set up reserve tracking", "Review reserve plan"],
        cta: cta("Set up reserve tracking", ROUTES.planning),
        dedupeKey: `tax_reserve_setup:${ctx.businessId}:${ctx.taxYear}`,
        refs: runRefs(ctx),
      });
    },
  }),
  rule({
    id: "tax_payment_due_soon",
    category: TAX_INSIGHT_CATEGORIES.PAYMENT_DUE,
    severity: "warn",
    cooldownHours: 24,
    expiresInHours: 72,
    evaluate(ctx) {
      const deadline = nextDeadline(ctx);
      if (!deadline) return null;
      const days = daysUntil(deadline.dueDate, ctx.generatedAt);
      if (days == null || days < 0 || days > 30) return null;
      const window = days <= 3 ? "3d" : days <= 7 ? "7d" : days <= 14 ? "14d" : "30d";
      const amountText = deadline.amount == null ? "The payment amount is not available yet." : `Expected amount: ${money(deadline.amount)}.`;
      return candidate({
        ruleId: "tax_payment_due_soon",
        category: TAX_INSIGHT_CATEGORIES.PAYMENT_DUE,
        severity: days <= 7 ? "critical" : "warn",
        confidenceScore: confidenceScore(ctx, 80),
        title: "Tax payment deadline is coming up",
        body: `${deadline.name || "Your next estimated tax payment"} is due in ${days} day${days === 1 ? "" : "s"}. ${amountText}`,
        metrics: [{ label: "Due in", value: `${days}d` }],
        actions: ["View payment plan", "Record payment if already paid"],
        cta: cta("View payment plan", ROUTES.planning),
        dedupeKey: `tax_deadline:${ctx.businessId}:${deadline.id || deadline.dueDate}:${window}`,
        refs: [{ type: "tax_deadline", id: deadline.id || null, date: deadline.dueDate }],
      });
    },
  }),
  rule({
    id: "tax_safe_harbor_gap",
    category: TAX_INSIGHT_CATEGORIES.SAFE_HARBOR_GAP,
    severity: "warn",
    cooldownHours: 48,
    expiresInHours: 120,
    evaluate(ctx, t) {
      const gap = number(ctx.safeHarbor?.remainingAmount ?? ctx.safeHarbor?.remainingTarget ?? ctx.safeHarbor?.remaining_amount);
      const status = String(ctx.safeHarbor?.status || "").toLowerCase();
      if (status && ["unavailable", "setup_incomplete"].includes(status)) return null;
      if (gap == null || gap < t.safeHarborGapAmount) return null;
      return candidate({
        ruleId: "tax_safe_harbor_gap",
        category: TAX_INSIGHT_CATEGORIES.SAFE_HARBOR_GAP,
        confidenceScore: confidenceScore(ctx, 75),
        title: "Safe-harbor coverage is behind",
        body: `${confidencePrefix(ctx)} you still need ${money(gap)} of coverage to meet the current safe-harbor target.`,
        metrics: [{ label: "Safe-harbor gap", value: money(gap) }],
        actions: ["Review safe harbor", "Record payments"],
        cta: cta("Review safe harbor", ROUTES.planning),
        dedupeKey: `tax_safe_harbor_gap:${ctx.businessId}:${ctx.taxYear}:${severityBand(gap, t.safeHarborGapAmount)}`,
        refs: runRefs(ctx),
        materialityScore: gap,
      });
    },
  }),
  rule({
    id: "tax_profile_blocker",
    category: TAX_INSIGHT_CATEGORIES.PROFILE_INCOMPLETE,
    severity: "warn",
    cooldownHours: 72,
    expiresInHours: 168,
    evaluate(ctx) {
      const blocker = firstBlocker(ctx);
      if (!blocker) return null;
      const entity = String(blocker.code || blocker).includes("entity") || String(blocker.code || blocker).includes("election");
      return candidate({
        ruleId: "tax_profile_blocker",
        category: entity ? TAX_INSIGHT_CATEGORIES.ENTITY_UNKNOWN : TAX_INSIGHT_CATEGORIES.PROFILE_INCOMPLETE,
        severity: entity ? "critical" : "warn",
        confidenceScore: 82,
        title: entity ? "Tax setup needs LLC election" : "Tax setup is incomplete",
        body: entity
          ? "Bizzi cannot produce an authoritative estimate until you confirm how the LLC is taxed."
          : "Bizzi needs a little more tax profile information before the estimate is ready.",
        metrics: [],
        actions: ["Complete tax setup"],
        cta: cta("Complete tax setup", ROUTES.setup),
        dedupeKey: `tax_profile_blocker:${ctx.businessId}:${ctx.taxYear}:${blocker.code || blocker}`,
        refs: runRefs(ctx),
      });
    },
  }),
  rule({
    id: "tax_classification_review_exposure",
    category: TAX_INSIGHT_CATEGORIES.CLASSIFICATION_REVIEW,
    severity: "warn",
    cooldownHours: 48,
    expiresInHours: 120,
    evaluate(ctx, t) {
      const amount = number(ctx.deductionsCoverage?.needsReviewAmount);
      const count = number(ctx.deductionsCoverage?.needsReviewCount) || 0;
      const taxableActivity = Math.abs(number(ctx.summary?.taxableIncomeYtd ?? ctx.currentRun?.taxable_income_ytd) || 0);
      const pct = taxableActivity > 0 && amount != null ? amount / taxableActivity : null;
      if ((amount == null || amount < t.reviewExposureAmount) && count < 5) return null;
      if (pct != null && pct < t.reviewExposurePct && amount < t.reviewExposureAmount * 2) return null;
      return candidate({
        ruleId: "tax_classification_review_exposure",
        category: TAX_INSIGHT_CATEGORIES.CLASSIFICATION_REVIEW,
        confidenceScore: confidenceScore(ctx, 70),
        title: "Tax classifications need review",
        body: `${money(amount || 0)} across ${count} posted transaction${count === 1 ? "" : "s"} still needs tax review, so the deduction estimate may change.`,
        metrics: [{ label: "Needs review", value: amount == null ? `${count} txns` : money(amount) }],
        actions: ["Review transactions", "Confirm tax treatments"],
        cta: cta("Review transactions", ROUTES.needsReview),
        dedupeKey: `tax_review_exposure:${ctx.businessId}:${ctx.taxYear}:${severityBand(amount || count, t.reviewExposureAmount)}`,
        refs: runRefs(ctx),
        materialityScore: amount || count,
      });
    },
  }),
  rule({
    id: "tax_state_unavailable",
    category: TAX_INSIGHT_CATEGORIES.STATE_UNAVAILABLE,
    severity: "info",
    cooldownHours: 168,
    expiresInHours: 336,
    evaluate(ctx) {
      if (!hasWarning(ctx, ["state_rule_missing", "state_tax_unavailable", "state_rules_missing"])) return null;
      return candidate({
        ruleId: "tax_state_unavailable",
        category: TAX_INSIGHT_CATEGORIES.STATE_UNAVAILABLE,
        confidenceScore: 72,
        title: "State tax is not included yet",
        body: "Your federal estimate is available, but state tax is not currently included for this setup.",
        metrics: [],
        actions: ["Review limitations", "Check tax setup"],
        cta: cta("Review limitations", ROUTES.confidence),
        dedupeKey: `tax_state_unavailable:${ctx.businessId}:${ctx.taxYear}`,
        refs: runRefs(ctx),
      });
    },
  }),
  rule({
    id: "tax_confidence_low",
    category: TAX_INSIGHT_CATEGORIES.CONFIDENCE_LOW,
    severity: "warn",
    cooldownHours: 72,
    expiresInHours: 168,
    evaluate(ctx) {
      if (!estimateReady(ctx) || confidenceLevel(ctx) !== "low") return null;
      const reason = topUncertainty(ctx);
      return candidate({
        ruleId: "tax_confidence_low",
        category: TAX_INSIGHT_CATEGORIES.CONFIDENCE_LOW,
        confidenceScore: 66,
        title: "Tax estimate confidence is low",
        body: `Based on incomplete information, the current estimate has low confidence${reason ? ` because ${reason}` : ""}.`,
        metrics: [{ label: "Confidence", value: "Low" }],
        actions: ["Improve estimate", "Review confidence details"],
        cta: cta("Improve estimate", ROUTES.confidence),
        dedupeKey: `tax_confidence_low:${ctx.businessId}:${ctx.taxYear}`,
        refs: runRefs(ctx),
      });
    },
  }),
  rule({
    id: "tax_source_stale",
    category: TAX_INSIGHT_CATEGORIES.SOURCE_STALE,
    severity: "info",
    cooldownHours: 72,
    expiresInHours: 168,
    evaluate(ctx, t) {
      const stale = staleSource(ctx, t.staleDays);
      if (!stale) return null;
      return candidate({
        ruleId: "tax_source_stale",
        category: TAX_INSIGHT_CATEGORIES.SOURCE_STALE,
        confidenceScore: 68,
        title: "Tax estimate source data is aging",
        body: `Your tax estimate is based on ${stale.label} last updated ${stale.days} days ago.`,
        metrics: [{ label: "Source age", value: `${stale.days}d` }],
        actions: ["Refresh books", "Review data freshness"],
        cta: cta("Refresh books", ROUTES.books),
        dedupeKey: `tax_source_stale:${ctx.businessId}:${ctx.taxYear}:${stale.key}`,
        refs: runRefs(ctx),
      });
    },
  }),
  rule({
    id: "tax_reserve_progress",
    category: TAX_INSIGHT_CATEGORIES.POSITIVE_PROGRESS,
    severity: "info",
    cooldownHours: 168,
    expiresInHours: 96,
    evaluate(ctx, t) {
      const change = ctx.changes?.changes?.reserveRecommendation;
      const gap = number(ctx.reserve?.reserveGap ?? ctx.reserve?.gap);
      if (gap == null || gap > 0) return null;
      return candidate({
        ruleId: "tax_reserve_progress",
        category: TAX_INSIGHT_CATEGORIES.POSITIVE_PROGRESS,
        severity: "info",
        confidenceScore: confidenceScore(ctx, 78),
        title: "Tax reserve is on track",
        body: "Your tax reserve is now on track against Bizzi's current recommendation.",
        metrics: [{ label: "Reserve gap", value: "$0" }],
        actions: ["Keep reserve updated", "Review payment plan"],
        cta: cta("View reserve", ROUTES.planning),
        dedupeKey: `tax_reserve_progress:${ctx.businessId}:${ctx.taxYear}:${ctx.currentRun?.id || "current"}`,
        refs: runRefs(ctx),
      });
    },
  }),
  rule({
    id: "tax_payment_recorded",
    category: TAX_INSIGHT_CATEGORIES.PAYMENT_MISSING,
    severity: "info",
    cooldownHours: 24,
    expiresInHours: 96,
    evaluate(ctx) {
      const payment = ctx.payments?.recentPayment;
      const remainingChange = ctx.changes?.changes?.remainingLiability;
      if (!payment || !remainingChange || remainingChange.absoluteChange >= 0) return null;
      const amount = number(payment.amount);
      if (amount == null || amount < 1000) return null;
      return candidate({
        ruleId: "tax_payment_recorded",
        category: TAX_INSIGHT_CATEGORIES.PAYMENT_MISSING,
        severity: "info",
        confidenceScore: confidenceScore(ctx, 78),
        title: "Tax payment reduced remaining liability",
        body: `Your ${money(amount)} tax payment reduced projected remaining liability.`,
        metrics: [{ label: "Payment", value: money(amount) }],
        actions: ["Review payment history", "Check safe-harbor coverage"],
        cta: cta("Review payments", ROUTES.planning),
        dedupeKey: `tax_payment_recorded:${ctx.businessId}:${payment.id || payment.payment_date || ctx.currentRun?.id}`,
        refs: [{ type: "tax_payment", id: payment.id || null }],
      });
    },
  }),
];

export function evaluateTaxInsightRules(context, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  return TAX_INSIGHT_RULES
    .filter((item) => item.enabled !== false)
    .map((item) => item.evaluate(context, thresholds))
    .filter(Boolean);
}

function rule({ id, category, severity = "info", cooldownHours = 24, expiresInHours = 72, evaluate }) {
  return {
    id,
    category,
    severity,
    enabled: true,
    priority: severity === "critical" ? 90 : severity === "warn" ? 70 : 40,
    evaluationFrequency: "event_or_scheduled",
    dedupeWindow: cooldownHours,
    cooldownHours,
    expiresInHours,
    requiredInputs: ["canonical_tax_run"],
    confidenceRequirement: "rule_specific",
    materialityThreshold: DEFAULT_THRESHOLDS,
    evaluate(context = {}, thresholds = DEFAULT_THRESHOLDS) {
      const taxContext = context.taxInsightContext || context;
      return evaluate(taxContext, thresholds);
    },
    buildInsight(candidate) {
      return {
        rule_id: id,
        module: DEFAULT_MODULE,
        category: candidate.category || category,
        severity: candidate.severity || severity,
        confidence_score: candidate.confidence_score,
        title: candidate.title,
        body: candidate.body,
        metrics: candidate.metrics || [],
        recommended_actions: candidate.recommended_actions || [],
        primary_cta: candidate.primary_cta || cta("Open Tax", ROUTES.overview),
        secondary_cta: candidate.secondary_cta || null,
        dedupe_key: candidate.dedupe_key,
        trigger_source: candidate.trigger_source || id,
        source_refs: candidate.source_refs || [],
        why_it_matters: "Tax insights are generated from persisted canonical tax runs, readiness, payments, deadlines, reserve, and confidence state.",
        explanation: "Bizzi provides estimates based on connected data and the information you provide. It does not prepare or file your tax return.",
        expires_at: candidate.expires_at || expiresAt(expiresInHours),
        materiality_key: candidate.materiality_key || null,
        materiality_score: candidate.materiality_score ?? null,
      };
    },
  };
}

function candidate({ ruleId, category, severity, confidenceScore, title, body, metrics, actions, cta: primary, secondary, dedupeKey, refs, materialityScore }) {
  return {
    rule_id: ruleId,
    category,
    severity,
    confidence_score: confidenceScore,
    title,
    body,
    metrics: metrics || [],
    recommended_actions: actions || [],
    primary_cta: primary,
    secondary_cta: secondary || null,
    dedupe_key: dedupeKey,
    source_refs: refs || [],
    materiality_score: materialityScore ?? null,
  };
}

function cta(label, route) {
  return { label, action: "navigate", payload: { route, path: route } };
}

function runRefs(ctx) {
  return [
    ctx.currentRun?.id ? { type: "tax_calculation_run", id: ctx.currentRun.id } : null,
    ctx.previousRun?.id ? { type: "tax_calculation_run", id: ctx.previousRun.id, role: "previous" } : null,
  ].filter(Boolean);
}

function estimateReady(ctx) {
  return Boolean(ctx.confidence?.estimateReady ?? ctx.readiness?.estimateReady ?? ctx.readiness?.estimate_ready);
}

function reserveReady(ctx) {
  return Boolean(ctx.confidence?.reserveReady ?? ctx.readiness?.reserveReady ?? ctx.readiness?.reserve_ready);
}

function confidenceLevel(ctx) {
  return String(ctx.confidence?.level || ctx.confidence?.confidenceLevel || ctx.currentRun?.confidence_level || "unavailable").toLowerCase();
}

function confidenceScore(ctx, fallback) {
  const score = number(ctx.confidence?.score ?? ctx.currentRun?.confidence_score);
  return Math.round(score ?? fallback);
}

function confidencePrefix(ctx) {
  const level = confidenceLevel(ctx);
  if (level === "high") return "Bizzi estimates";
  if (level === "medium") return "Bizzi currently estimates";
  if (level === "low") return "Based on incomplete information, Bizzi estimates";
  return "Bizzi cannot fully verify this yet, but";
}

function firstBlocker(ctx) {
  const blockers = [
    ...(Array.isArray(ctx.readiness?.blockers) ? ctx.readiness.blockers : []),
    ...(Array.isArray(ctx.confidence?.blockers) ? ctx.confidence.blockers : []),
    ...(Array.isArray(ctx.currentRun?.missing_inputs) ? ctx.currentRun.missing_inputs : []),
  ];
  return blockers.find(Boolean) || null;
}

function hasSetupCode(ctx, code) {
  const haystack = JSON.stringify([ctx.readiness, ctx.confidence, ctx.currentRun?.missing_inputs || []]).toLowerCase();
  return haystack.includes(String(code).toLowerCase());
}

function hasWarning(ctx, codes) {
  const wanted = new Set(codes);
  return (ctx.warnings || []).some((warning) => wanted.has(warning.code || warning));
}

function topUncertainty(ctx) {
  const action = ctx.confidence?.topImprovementAction || ctx.confidence?.topAction || null;
  if (typeof action === "string") return action.toLowerCase();
  if (action?.title) return action.title.toLowerCase();
  const review = number(ctx.deductionsCoverage?.needsReviewAmount);
  if (review && review > 0) return `${money(review)} of transactions remains unreviewed`;
  const blocker = firstBlocker(ctx);
  return blocker?.message || blocker?.code || null;
}

function nextDeadline(ctx) {
  const now = new Date(ctx.generatedAt || Date.now()).getTime();
  return (ctx.deadlines || [])
    .filter((row) => Number.isFinite(new Date(row.dueDate).getTime()) && new Date(row.dueDate).getTime() >= now - DAY_MS)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0] || null;
}

function staleSource(ctx, thresholdDays) {
  const sources = ctx.sourceFreshness || {};
  const candidates = [
    ["qbo", sources.lastQboSyncAt || sources.qboLastSyncAt || sources.qbo?.lastSyncAt, "books"],
    ["classification", sources.lastClassificationRunAt || sources.classification?.lastRunAt, "tax classification"],
    ["posted_transactions", sources.lastPostedTransactionAt || sources.postedTransactions?.lastPostedAt, "posted transactions"],
  ];
  const now = new Date(ctx.generatedAt || Date.now()).getTime();
  for (const [key, value, label] of candidates) {
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts)) continue;
    const days = Math.floor((now - ts) / DAY_MS);
    if (days >= thresholdDays) return { key, label, days };
  }
  return null;
}

function daysUntil(dateValue, nowValue) {
  const due = new Date(dateValue).getTime();
  const now = new Date(nowValue || Date.now()).getTime();
  if (!Number.isFinite(due) || !Number.isFinite(now)) return null;
  return Math.ceil((due - now) / DAY_MS);
}

function severityBand(value, threshold) {
  const n = Math.abs(Number(value || 0));
  if (n >= threshold * 4) return "critical";
  if (n >= threshold * 2) return "high";
  return "material";
}

function money(value) {
  const n = Math.round(Number(value || 0));
  return `$${n.toLocaleString()}`;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function expiresAt(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export default TAX_INSIGHT_RULES;
