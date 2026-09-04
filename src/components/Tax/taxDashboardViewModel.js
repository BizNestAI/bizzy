const SETUP_MESSAGES = {
  profile_incomplete: "Complete your tax profile so Bizzi can estimate your federal and state taxes.",
  entity_unknown: "Tell Bizzi how your LLC is taxed before using this estimate.",
  classifications_missing: "Your posted transactions need tax classification before deductions can be estimated.",
  classifications_required: "Your Tax Profile is complete. Prepare your posted QuickBooks transactions for tax treatment.",
  ready_to_classify: "Your Tax Profile is complete. Prepare your posted QuickBooks transactions for tax treatment.",
  classification_queued: "Your transactions are waiting to be classified.",
  classifying: "Bizzi is classifying your posted QuickBooks transactions.",
  classification_review_required: "Bizzi classified most transactions automatically. Review the items that need more context.",
  state_rules_missing: "Federal estimate is available. State tax is not yet supported for this setup.",
  reserve_setup_incomplete: "Your tax estimate is available. Connect or select a reserve account to track what you have set aside.",
  no_posted_transactions: "Bizzi does not have posted transactions for this tax year yet.",
};

export function buildTaxDashboardViewModel(taxOverview) {
  const dto = taxOverview || {};
  const meta = dto.meta || {};
  const readiness = dto.readiness || {};
  const summary = dto.summary || {};
  const confidence = dto.confidence || {};
  const safeHarbor = dto.safeHarbor || {};
  const reserve = dto.reserve || {};
  const classificationSummary = normalizeClassificationSummary(dto.classificationSummary || dto.classification_summary || {});
  const surfaceReadiness = normalizeSurfaceReadiness(dto.surfaceReadiness || dto.surface_readiness || {});
  const warnings = normalizeList(dto.warnings);
  const setupState = normalizeSetupState(readiness.setupState, warnings, confidence);
  const actions = collectActions({ readiness, confidence, setupState });
  const entityType = profileValue(dto.profile, "entityType", "entity_type");
  const taxElection = profileValue(dto.profile, "taxElection", "tax_election");
  const isSCorp = entityType === "s_corp" || taxElection === "s_corp";
  const isUnknownEntity = !entityType || entityType === "unknown" || taxElection === "unknown";

  return {
    status: {
      calculationStatus: meta.status || "unknown",
      setupState,
      estimateReady: readiness.estimateReady === true || confidence.estimateReady === true,
      reserveReady: readiness.reserveReady === true || confidence.reserveReady === true,
      isPartial: meta.status === "partial" || readiness.status === "partial",
      isUnavailable: readiness.status === "unavailable",
      confidenceLevel: confidence.level || "unavailable",
    },
    header: {
      taxYear: meta.taxYear ?? meta.year ?? null,
      asOfDate: meta.asOfDate ?? null,
      generatedAt: meta.generatedAt ?? meta.completedAt ?? meta.updatedAt ?? null,
      sourceFreshnessLabel: sourceFreshnessLabel(dto),
      liveStatus: meta.source === "demo" ? "demo" : "live",
      runId: meta.runId ?? meta.id ?? null,
    },
    primaryMetrics: {
      projectedTotalTax: summary.projectedTotalTax ?? null,
      taxGeneratedYtd: summary.taxGeneratedYtd ?? currentTrendValue(dto.projection?.taxTrend) ?? dto.liability?.ytdTaxGeneratedEstimate ?? null,
      paidAndWithheldYtd: summary.taxPaidAndWithheldYtd ?? dto.payments?.totals?.totalPaidAndWithheld ?? null,
      remainingLiability: summary.remainingProjectedLiability ?? null,
      recommendedReserve: summary.recommendedReserve ?? reserve.reserve?.recommendedReserve ?? reserve.recommendedReserve ?? reserve.recommendedTransfer ?? null,
      reserveGap: summary.reserveGap ?? reserve.reserve?.reserveGap ?? reserve.reserveGap ?? null,
      currentReserve: summary.currentReserve ?? reserve.reserve?.currentReserve ?? reserve.currentReserve ?? null,
      projectedOverpayment: summary.projectedOverpayment ?? dto.liability?.projectedOverpayment ?? null,
      nextPaymentAmount: nextSafeHarborSchedule(safeHarbor)?.remaining ?? nextSafeHarborSchedule(safeHarbor)?.amount ?? reserve?.liability?.nextPaymentAmount ?? null,
      nextPaymentDate: nextDeadline(dto.deadlines)?.dueDate ?? nextSafeHarborSchedule(safeHarbor)?.dueDate ?? reserve?.liability?.nextPaymentDate ?? null,
      nextDeadline: normalizeDeadline(nextDeadline(dto.deadlines), dto),
    },
    taxBreakdown: {
      federalIncomeTax: summary.projectedFederalTax ?? dto.federal?.tax ?? dto.federal?.projectedTax ?? null,
      selfEmploymentTax: isSCorp || isUnknownEntity ? null : summary.projectedSelfEmploymentTax ?? dto.selfEmployment?.tax ?? null,
      stateTax: summary.projectedStateTax ?? dto.state?.tax ?? dto.state?.projectedTax ?? null,
      otherTax: summary.otherTax ?? null,
      entityType,
      taxElection,
      isSCorp,
      isUnknownEntity,
      sCorpContext: isSCorp
        ? "S-Corp pass-through income is not included in self-employment tax. Owner wages remain subject to payroll taxes."
        : null,
      qbiDeferred: hasDeferred(dto, "qbi"),
    },
    safeHarbor: {
      status: safeHarbor.status || safeHarbor.combined?.status || "unavailable",
      method: safeHarbor.combined?.method ?? safeHarbor.federal?.method ?? null,
      requiredAnnual: safeHarbor.combined?.requiredAnnual ?? safeHarbor.federal?.requiredAnnual ?? null,
      coveredAmount: safeHarbor.combined?.coveredAmount ?? safeHarbor.federal?.coveredAmount ?? null,
      remainingAmount: safeHarbor.combined?.remainingAmount ?? safeHarbor.federal?.remainingAmount ?? null,
      nextDueDate: nextDeadline(dto.deadlines)?.dueDate ?? nextSafeHarborSchedule(safeHarbor)?.dueDate ?? null,
      nextPaymentAmount: nextSafeHarborSchedule(safeHarbor)?.remaining ?? nextSafeHarborSchedule(safeHarbor)?.amount ?? null,
      warning: normalizeList(safeHarbor.warnings)[0] || safeHarbor.combined?.warning || null,
    },
    confidence: {
      score: confidence.score ?? null,
      level: confidence.level || "unavailable",
      estimateReady: readiness.estimateReady === true || confidence.estimateReady === true,
      reserveReady: readiness.reserveReady === true || confidence.reserveReady === true,
      topBlocker: normalizeList(confidence.blockers)[0] || normalizeList(readiness.blockers)[0] || warnings[0] || null,
      topImprovementAction: normalizeList(confidence.improvementActions)[0] || actions[0] || null,
    },
    health: buildHealth({ dto, readiness, confidence, warnings, actions }),
    classificationSummary,
    surfaceReadiness,
    profileSummary: buildProfileSummary(dto.profile),
    nextActions: buildNextActions({ actions, confidence, setupState, dto }),
    trend: buildTrend(dto),
    warnings,
    actions,
    narrative: buildNarrative({ dto, summary, readiness, confidence, surfaceReadiness }),
  };
}

function buildHealth({ dto, readiness, confidence, warnings, actions }) {
  const score = nullableNumber(confidence.score);
  const profile = profileCompletion(dto.profile?.completeness || dto.profileCompleteness || {});
  const classificationCoverage = nullableNumber(
    dto.deductions?.coverage?.classificationCoveragePercent
    ?? dto.classificationSummary?.classificationCoveragePercent
    ?? dto.classificationSummary?.classification_coverage_percent
    ?? dto.classification_summary?.classificationCoveragePercent
    ?? dto.classification_summary?.classification_coverage_percent
  );
  const level = score == null
    ? readiness.estimateReady ? "Partial" : "Unavailable"
    : score >= 90 ? "Excellent"
      : score >= 75 ? "Good"
        : score >= 50 ? "Partial"
          : "Needs setup";
  const ready = [];
  const needsAttention = [];
  if (readiness.estimateReady) ready.push("Tax estimate has the required inputs");
  if (readiness.reserveReady || confidence.reserveReady) ready.push("Reserve planning is available");
  if (profile.percent != null) {
    const label = `${Math.round(profile.percent)}% profile complete`;
    if (profile.missingRequired.length === 0 && profile.missingRecommended.length === 0 && profile.percent >= 90) ready.push(label);
    else needsAttention.push(label);
  }
  if (profile.missingRequired.length) {
    needsAttention.push(`${profile.missingRequired.length} required profile input${profile.missingRequired.length === 1 ? "" : "s"} missing`);
  } else if (profile.percent != null || profile.isCompleteForEstimate) {
    ready.push("Required profile inputs complete");
  }
  if (profile.missingRecommended.length) {
    ready.push("Optional: Set a reserve preference");
  }
  if (classificationCoverage != null) {
    const label = `${Math.round(classificationCoverage)}% of transactions classified`;
    if (classificationCoverage >= 90) ready.push(label);
    else needsAttention.push(label);
  }
  normalizeList(confidence.blockers).slice(0, 3).forEach((item) => needsAttention.push(item.message || item.code));
  warnings.slice(0, 2).forEach((item) => needsAttention.push(item.message || item.code));
  return {
    score,
    level,
    ready,
    needsAttention,
    factors: normalizeList(confidence.factors),
    penalties: normalizeList(confidence.penalties),
    methodologyVersion: confidence.methodologyVersion || null,
    explanation: confidence.explanation || null,
    actions: actions.slice(0, 3),
  };
}

function profileCompletion(completeness = {}) {
  const missingRequired = normalizeList(completeness.missingRequired);
  const missingRecommended = normalizeList(completeness.missingRecommended);
  const completedCount = nullableNumber(completeness.completedCount);
  const totalCount = nullableNumber(completeness.totalCount);
  let percent = nullableNumber(completeness.percent ?? completeness.score);
  if (completedCount != null && totalCount > 0) percent = Math.round((completedCount / totalCount) * 100);
  if (percent != null && percent >= 100 && (missingRequired.length || missingRecommended.length)) {
    const knownTotal = totalCount || completedCount + missingRequired.length + missingRecommended.length;
    percent = knownTotal > 0
      ? Math.round(((knownTotal - missingRequired.length - missingRecommended.length) / knownTotal) * 100)
      : Math.max(0, 100 - missingRequired.length * 12 - missingRecommended.length * 5);
  }
  return {
    percent,
    completedCount,
    totalCount,
    isCompleteForEstimate: completeness.isCompleteForEstimate === true,
    missingRequired,
    missingRecommended,
  };
}

function buildProfileSummary(profile = {}) {
  const source = profile && typeof profile === "object" ? profile : {};
  const completeness = source?.completeness || {};
  const fields = [
    { label: "State", value: source.primaryState || source.state || source.stateCode },
    { label: "Entity", value: source.entityType },
    { label: "Tax election", value: electionValue(source) },
    { label: "Filing", value: source.filingStatus },
    { label: "Books", value: source.accountingMethod },
    { label: "Prior year", value: source.priorYearTotalTax == null ? null : "Entered" },
  ].filter((field) => field.value != null && field.value !== "");
  return {
    complete: completeness.isCompleteForEstimate === true || completeness.percent === 100,
    completedCount: completeness.completedCount ?? null,
    totalCount: completeness.totalCount ?? null,
    percent: nullableNumber(completeness.percent),
    missingRequired: normalizeList(completeness.missingRequired),
    lastReviewedAt: source.lastReviewedAt || source.reviewedAt || null,
    fields,
  };
}

function electionValue(profile) {
  const entityType = profile?.entityType || profile?.entity_type;
  const election = profile?.taxElection || profile?.tax_election;
  if (!election || election === "none") return entityType === "s_corp" ? "S-Corp" : null;
  return election;
}

function buildNextActions({ actions, confidence, setupState, dto }) {
  const collected = [
    ...normalizeList(actions),
    ...normalizeList(confidence.improvementActions),
    ...normalizeList(setupState.actions),
  ];
  if (dto.summary?.reserveGap > 0) {
    collected.push({ code: "reserve_gap", label: "Add to tax reserve", description: "Closes the gap between your current reserve and Bizzi's reserve target." });
  }
  if (dto.safeHarbor?.combined?.remainingAmount > 0) {
    collected.push({ code: "safe_harbor_remaining", label: "Plan next estimated payment", description: "Keeps safe-harbor coverage on schedule." });
  }
  const seen = new Set();
  return collected.filter((action) => {
    const key = action?.code || action?.label;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

function buildNarrative({ dto, summary, readiness, confidence, surfaceReadiness }) {
  if (dto.meta?.source === "demo") {
    return dto.explanationSummary?.summary || "Demo scenario showing how Bizzi will present your tax position.";
  }
  if (dto.meta?.status === "failed") return "The latest tax calculation failed. Bizzi will keep any previous calculation separate from the failed refresh state.";
  if (surfaceReadiness?.liability?.message) return surfaceReadiness.liability.message;
  if (readiness.estimateReady !== true) return readiness.setupState?.message || "Complete your tax profile to generate a reliable estimate.";
  const projected = formatMoney(summary.projectedTotalTax);
  const paid = formatMoney(summary.taxPaidAndWithheldYtd);
  const remaining = formatMoney(summary.remainingProjectedLiability);
  const confidenceText = confidence.level ? ` Estimate confidence is ${String(confidence.level).replaceAll("_", " ")}.` : "";
  return `Based on your books, projected tax is ${projected}. Payments and withholding currently cover ${paid}, leaving ${remaining} as projected remaining liability.${confidenceText}`;
}

function normalizeClassificationSummary(summary = {}) {
  const postedTransactionCount = nullableNumber(summary.postedTransactionCount ?? summary.posted_transaction_count ?? summary.eligiblePostedCount ?? summary.eligible_posted_count);
  const classifiedTransactionCount = nullableNumber(summary.classifiedTransactionCount ?? summary.classified_transaction_count ?? summary.classifiedCount ?? summary.classified_count);
  const unclassifiedTransactionCount = nullableNumber(summary.unclassifiedTransactionCount ?? summary.unclassified_transaction_count ?? summary.unclassifiedCount ?? summary.unclassified_count);
  const reviewRequiredTransactionCount = nullableNumber(summary.reviewRequiredTransactionCount ?? summary.review_required_transaction_count ?? summary.needsReviewCount ?? summary.needs_review_count);
  return {
    postedTransactionCount,
    classifiedTransactionCount,
    unclassifiedTransactionCount,
    reviewRequiredTransactionCount,
    autoClassifiedTransactionCount: nullableNumber(summary.autoClassifiedTransactionCount ?? summary.auto_classified_transaction_count ?? summary.autoClassifiedCount ?? summary.auto_classified_count),
    excludedTransactionCount: nullableNumber(summary.excludedTransactionCount ?? summary.excluded_transaction_count ?? summary.excludedCount ?? summary.excluded_count),
    processingTransactionCount: nullableNumber(summary.processingTransactionCount ?? summary.processing_transaction_count ?? summary.processingCount ?? summary.processing_count),
    failedTransactionCount: nullableNumber(summary.failedTransactionCount ?? summary.failed_transaction_count ?? summary.failedCount ?? summary.failed_count),
    classificationCoveragePercent: nullableNumber(summary.classificationCoveragePercent ?? summary.classification_coverage_percent),
    classificationStatus: summary.classificationStatus || summary.classification_status || null,
    lastRunAt: summary.lastRunAt || summary.last_run_at || null,
    rulesVersion: summary.rulesVersion || summary.rules_version || null,
    activeRun: summary.activeRun || summary.active_run || null,
    latestRun: summary.latestRun || summary.latest_run || null,
  };
}

function normalizeSurfaceReadiness(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    chart: normalizeSurface(source.chart || source.taxTrajectory || source.tax_trajectory),
    liability: normalizeSurface(source.liability || source.estimatedTaxLiability || source.estimated_tax_liability),
    deductions: normalizeSurface(source.deductions || source.deductionsPreview || source.deductions_preview),
    deadline: normalizeSurface(source.deadline || source.deadlines),
  };
}

function normalizeSurface(surface = {}) {
  const source = surface && typeof surface === "object" ? surface : {};
  return {
    status: source.status || source.reason || "unavailable",
    ready: source.ready === true,
    reason: source.reason || source.status || null,
    message: source.message || null,
    amountStatus: source.amountStatus || source.amount_status || null,
  };
}

function normalizeSetupState(setupState, warnings, confidence) {
  const raw = setupState && typeof setupState === "object" ? setupState : {};
  const code = raw.code || raw.reason || raw.status || normalizeList(confidence?.blockers)[0]?.code || warnings[0]?.code || null;
  const message = raw.message || SETUP_MESSAGES[code] || normalizeList(raw.blockers)[0]?.message || null;
  return {
    ...raw,
    code,
    status: raw.status || (code ? "action_needed" : "ready"),
    message,
    actions: normalizeList(raw.actions),
    blockers: normalizeList(raw.blockers),
  };
}

function collectActions({ readiness, confidence, setupState }) {
  const actions = [
    ...normalizeList(setupState?.actions),
    ...normalizeList(readiness.actions),
    ...normalizeList(confidence.improvementActions),
  ];
  const seen = new Set();
  return actions.filter((action) => {
    const key = action?.code || action?.route || action?.label;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildTrend(dto) {
  if (Array.isArray(dto.projection?.taxTrend)) return dto.projection.taxTrend;
  if (Array.isArray(dto.projection?.legacyTrend)) return dto.projection.legacyTrend;
  return [];
}

function currentTrendValue(trend) {
  const current = normalizeList(trend).find((point) => point?.isCurrent === true);
  const value = current?.cumulativeActualTax ?? current?.actualTax ?? current?.estTax;
  return value == null || Number.isNaN(Number(value)) ? null : round2(Number(value));
}

function sourceFreshnessLabel(dto) {
  const freshness = dto.confidence?.sourceFreshness || {};
  const statuses = Object.values(freshness).map((item) => item?.status || item).filter(Boolean);
  if (statuses.includes("missing_critical")) return "Missing source data";
  if (statuses.includes("stale")) return "Some sources stale";
  if (statuses.length) return "Sources current";
  return null;
}

function nextDeadline(deadlines = []) {
  const now = new Date();
  return normalizeList(deadlines)
    .map((deadline) => ({ ...deadline, dueDate: deadline.dueDate || deadline.date || deadline.deadlineDate }))
    .filter((deadline) => deadline.dueDate && new Date(deadline.dueDate) >= now)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0] || null;
}

function normalizeDeadline(deadline, dto = {}) {
  if (!deadline) return null;
  const state = dto.profile?.primaryTaxState || dto.profile?.primary_tax_state || dto.state?.stateCode;
  return {
    date: deadline.dueDate || deadline.date || null,
    label: deadline.label || deadline.name || deadline.description || "Tax deadline",
    jurisdictions: normalizeList(deadline.jurisdictions).length
      ? normalizeList(deadline.jurisdictions)
      : ["Federal", ...(state ? [state] : [])],
    type: deadline.type || deadline.deadlineType || "Estimated payment deadline",
    status: deadline.status || "upcoming",
    explanation: deadline.explanation || "Next applicable deadline from the canonical tax deadline rules.",
  };
}

function nextSafeHarborSchedule(safeHarbor) {
  const schedule = safeHarbor?.combined?.quarterSchedule || safeHarbor?.federal?.quarterSchedule || [];
  const now = new Date();
  return normalizeList(schedule)
    .map((row) => ({ ...row, dueDate: row.dueDate || row.due || row.date }))
    .filter((row) => row.dueDate && new Date(row.dueDate) >= now)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0] || null;
}

function profileValue(profile, camel, snake) {
  return profile?.[camel] ?? profile?.[snake] ?? null;
}

function hasDeferred(dto, needle) {
  const lower = String(needle).toLowerCase();
  return normalizeList(dto.supportedButDeferred).some((item) =>
    `${item?.code || ""} ${item?.label || ""} ${item?.message || ""}`.toLowerCase().includes(lower)
  );
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function round2(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function nullableNumber(value) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return null;
  return Number(value);
}

function formatMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return "not available";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

export default buildTaxDashboardViewModel;
