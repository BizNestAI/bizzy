const TAX_YEAR = 2026;

export function buildMockTaxFixture({ year = TAX_YEAR } = {}) {
  const taxYear = Number(year) || TAX_YEAR;
  const asOfDate = currentLocalIsoDate();
  const generatedAt = new Date().toISOString();
  const projectedTotalTax = 24800;
  const taxGeneratedYtd = mockTaxGeneratedThroughDate({ taxYear, asOfDate, projectedTotalTax });
  const asOfLabel = formatFixtureDate(asOfDate);
  const paidAndWithheld = 12400;
  const expectedCredits = 0;
  const remainingLiability = 12400;
  const recommendedReserve = 12400;
  const currentReserve = 12000;
  const reserveGap = 400;

  const payments = buildMockPayments({ taxYear, paidAndWithheld });
  const reserve = buildMockReserve({ taxYear, recommendedReserve, currentReserve, reserveGap });
  const safeHarbor = buildMockSafeHarbor({ taxYear, paidAndWithheld });

  return {
    overview: {
      meta: {
        source: "demo",
        status: "completed",
        taxYear,
        asOfDate,
        generatedAt,
        completedAt: generatedAt,
        runId: `demo-tax-run-${taxYear}`,
      },
      readiness: {
        status: "ready",
        estimateReady: true,
        reserveReady: true,
        setupState: { status: "ready", code: null, message: null, actions: [], blockers: [] },
        blockers: [],
        actions: [],
      },
      summary: {
        projectedTotalTax,
        taxGeneratedYtd,
        taxPaidAndWithheldYtd: paidAndWithheld,
        expectedAdditionalPaymentsAndCredits: expectedCredits,
        remainingProjectedLiability: remainingLiability,
        projectedOverpayment: 0,
        taxableIncomeYtd: 146900,
        projectedFederalTax: 13900,
        projectedSelfEmploymentTax: null,
        projectedStateTax: 3900,
        otherTax: 7000,
        recommendedReserve,
        currentReserve,
        reserveGap,
      },
      profile: {
        entityType: "s_corp",
        taxElection: "s_corp",
        filingStatus: "single",
        primaryState: "NC",
        state: "NC",
        accountingMethod: "cash",
        residencyState: "NC",
        dependents: 0,
        ptetElection: "not_elected",
        priorYearTotalTax: 22000,
        lastReviewedAt: `${asOfDate}T16:30:00.000Z`,
        completeness: {
          completedCount: 8,
          totalCount: 13,
          percent: 62,
          isCompleteForEstimate: false,
          isCompleteForReserve: true,
          missingRequired: ["owner_reasonable_salary", "owner_w2_wages_ytd", "federal_withholding_ytd", "state_withholding_ytd"],
          missingRecommended: ["reserve_buffer_percent"],
        },
      },
      actuals: {
        revenueYtd: 312000,
        deductibleExpensesYtd: 64200,
        ownerWagesYtd: 72000,
      },
      projection: { taxTrend: buildMockTrend({ taxYear, asOfDate, projectedTotalTax, paidAndWithheld, recommendedReserve }) },
      federal: { tax: 13900, status: "supported", confidenceLevel: "high" },
      selfEmployment: { tax: null, status: "not_applicable", explanation: "S-Corp owner wages are handled through payroll." },
      state: { tax: 3900, stateCode: "NC", status: "supported", confidenceLevel: "high" },
      payments,
      safeHarbor,
      reserve,
      deadlines: [
        { type: "estimated_payment", label: "Q3 estimated payment", dueDate: `${taxYear}-09-15`, status: "upcoming" },
        { type: "estimated_payment", label: "Q4 estimated payment", dueDate: `${taxYear + 1}-01-15`, status: "upcoming" },
      ],
      confidence: {
        score: 84,
        level: "good",
        estimateReady: true,
        reserveReady: true,
        explanation: "Demo confidence reflects current books, classified transactions, recorded payments, and reserve planning, with profile fields still needing review.",
        methodologyVersion: "tax-confidence-v1",
        factors: [
          { code: "profile_entity", label: "Profile and entity setup", score: 72, weight: 0.15 },
          { code: "taxable_income_source", label: "Taxable income source quality", score: 88, weight: 0.25 },
          { code: "classification_deductions", label: "Classification and deduction coverage", score: 92, weight: 0.15 },
          { code: "projection", label: "Annual projection", score: 86, weight: 0.15 },
          { code: "payments_safe_harbor", label: "Payments, safe harbor, and reserve", score: 82, weight: 0.05 },
        ],
        penalties: [
          { code: "s_corp_salary_uncertainty", category: "s_corp", points: 6, message: "S-Corp wage and withholding inputs need review." },
        ],
        sourceFreshness: {
          books: { status: "current", label: "Books synced yesterday" },
          transactions: { status: "current", label: "96% classified" },
          reserve_balance: { status: "current", label: `Reserve verified ${formatFixtureShortDate(asOfDate)}` },
        },
        blockers: [],
        improvementActions: [
          { code: "review_transactions", label: "Review 5 transactions", route: "/dashboard/tax" },
          { code: "record_next_payment", label: "Plan Q3 payment", route: "/dashboard/tax" },
        ],
      },
      warnings: [],
      assumptions: [
        { code: "demo_s_corp", message: "Demo assumes a North Carolina S-Corp with owner wages already recorded through payroll." },
      ],
      unsupportedItems: [],
      supportedButDeferred: [],
      explanationSummary: {
        summary: `Based on demo books through ${asOfLabel}, projected ${taxYear} tax is about $24,800. Confirmed payments and withholding apply $12,400, leaving $12,400 as projected remaining liability.`,
        primarySummary: "Demo scenario showing how Bizzi presents a complete tax position with projection, coverage, reserve, safe harbor, deductions, and next actions in sync.",
        nextRecommendedAction: { code: "review_transactions", label: "Review 5 transactions", route: "/dashboard/tax" },
      },
      workpaper: buildMockWorkpaper({ taxYear, asOfDate, generatedAt, projectedTotalTax, taxGeneratedYtd, paidAndWithheld, remainingLiability, recommendedReserve }),
      links: {},
    },
    payments,
    reserve,
    reserveAccounts: [reserve.account],
    deductions: buildMockDeductions({ taxYear, asOfDate, generatedAt }),
    deductionTransactions: buildMockDeductionTransactions(),
  };
}

function buildMockWorkpaper({ taxYear, asOfDate, generatedAt, projectedTotalTax, taxGeneratedYtd, paidAndWithheld, remainingLiability, recommendedReserve }) {
  const runId = `demo-tax-run-${taxYear}`;
  const asOfLabel = formatFixtureDate(asOfDate);
  const line = (code, label, section, amount, extra = {}) => ({
    id: `demo:${code}`,
    code,
    label,
    section,
    parentCode: extra.parentCode || null,
    sortOrder: extra.sortOrder || 0,
    amount,
    quantity: null,
    percentage: extra.percentage ?? null,
    displaySign: extra.displaySign || null,
    status: extra.status || "calculated",
    supportLevel: extra.supportLevel || "supported",
    confidence: extra.confidence ?? 0.84,
    formula: { code: extra.formulaCode || null, description: extra.formulaDescription || null },
    explanation: extra.explanation || `${label} comes from the persisted demo workpaper ledger.`,
    source: extra.source || { type: null, count: null, endpoint: null, referencesAvailable: false, historicalSnapshotWarning: null },
    rules: extra.rules || { refs: [], versions: {} },
    isProjection: extra.isProjection === true,
    isActual: extra.isActual === true,
    materiality: extra.materiality || null,
    drillDown: extra.drillDown || null,
    metadata: extra.metadata || {},
  });
  const sections = [
    {
      code: "source_period_income",
      label: "Income",
      status: "available",
      subtotal: 182000,
      lines: [
        line("source_period_income:actual_business_revenue_ytd", `Business revenue through ${asOfLabel}`, "source_period_income", 182000, { isActual: true, status: "confirmed", source: { type: "transaction_tax_classifications", count: 38, endpoint: "/api/tax/deductions/transactions", referencesAvailable: true } }),
      ],
    },
    {
      code: "projected_remaining_year_income",
      label: "Projected remaining-year income",
      status: "available",
      subtotal: 130000,
      lines: [
        line("projected_remaining_year_income:projected_remaining_business_revenue", "Projected remaining revenue", "projected_remaining_year_income", 130000, { isProjection: true, status: "projected" }),
      ],
    },
    {
      code: "annual_income_bridge",
      label: "Annual income bridge",
      status: "available",
      subtotal: 312000,
      lines: [
        line("annual_income_bridge:actual_ytd_income", "Actual YTD income", "annual_income_bridge", 182000, { isActual: true, status: "confirmed" }),
        line("annual_income_bridge:projected_remaining_income", "Projected remaining income", "annual_income_bridge", 130000, { isProjection: true, status: "projected" }),
        line("annual_income_bridge:projected_annual_income", "Projected annual revenue", "annual_income_bridge", 312000),
      ],
    },
    {
      code: "deductions",
      label: "Deductions",
      status: "available",
      subtotal: 64200,
      lines: [
        line("deductions:confirmed_deductible_expenses", "Confirmed deductible expenses", "deductions", 51200, { status: "confirmed", displaySign: "subtract", source: { type: "transaction_tax_classifications", count: 24, endpoint: "/api/tax/deductions/transactions", referencesAvailable: true } }),
        line("deductions:estimated_deductible_expenses", "Estimated deductible expenses", "deductions", 13000, { status: "estimated", displaySign: "subtract" }),
      ],
    },
    {
      code: "business_taxable_income_bridge",
      label: "Business taxable profit",
      status: "available",
      subtotal: 247800,
      lines: [
        line("business_taxable_income_bridge:projected_annual_revenue", "Projected annual revenue", "business_taxable_income_bridge", 312000),
        line("business_taxable_income_bridge:deductible_expenses", "Deductible expenses", "business_taxable_income_bridge", 64200, { displaySign: "subtract" }),
        line("business_taxable_income_bridge:projected_business_taxable_profit", "Projected business taxable profit", "business_taxable_income_bridge", 247800),
      ],
    },
    {
      code: "entity_treatment",
      label: "Entity treatment",
      status: "available",
      subtotal: 175800,
      lines: [
        line("entity_treatment:owner_wages", "Owner wages", "entity_treatment", 72000),
        line("entity_treatment:pass_through_income", "Pass-through income", "entity_treatment", 175800),
      ],
    },
    {
      code: "total_tax_components",
      label: "Tax liability",
      status: "available",
      subtotal: projectedTotalTax,
      lines: [
        line("total_tax_components:federal_income_tax", "Federal income tax", "total_tax_components", 13900),
        line("total_tax_components:state_individual_income_tax", "North Carolina state tax", "total_tax_components", 3900),
        line("total_tax_components:entity_level_tax", "Entity and payroll tax effect", "total_tax_components", 7000),
        line("total_tax_components:projected_annual_tax", "Projected annual tax", "total_tax_components", projectedTotalTax),
      ],
    },
    {
      code: "payment_application_snapshot",
      label: "Payments and credits",
      status: "available",
      subtotal: paidAndWithheld,
      lines: [
        line("payment_application_snapshot:confirmed_payments", "Confirmed payments and withholding", "payment_application_snapshot", paidAndWithheld, { status: "confirmed", displaySign: "subtract" }),
      ],
    },
    {
      code: "remaining_liability",
      label: "Remaining liability",
      status: "available",
      subtotal: remainingLiability,
      lines: [
        line("remaining_liability:projected_annual_tax", "Projected annual tax", "remaining_liability", projectedTotalTax),
        line("remaining_liability:confirmed_applicable_payments", "Confirmed applicable payments", "remaining_liability", paidAndWithheld, { displaySign: "subtract", status: "confirmed" }),
        line("remaining_liability:remaining_projected_liability", "Remaining projected liability", "remaining_liability", remainingLiability),
      ],
    },
    {
      code: "reserve_bridge",
      label: "Reserve recommendation",
      status: "available",
      subtotal: recommendedReserve,
      lines: [
        line("reserve_bridge:remaining_projected_liability", "Remaining projected liability", "reserve_bridge", remainingLiability),
        line("reserve_bridge:recommended_reserve", "Recommended reserve", "reserve_bridge", recommendedReserve),
      ],
    },
    {
      code: "through_date_tax",
      label: "Tax attributable through today",
      status: "available",
      subtotal: taxGeneratedYtd,
      lines: [
        line("through_date_tax:tax_attributable_through_date", "Tax attributable through today", "through_date_tax", taxGeneratedYtd, { status: "projected", isProjection: true, formulaCode: "annualized_actual_ytd_tax_calculation", metadata: { calculationMethod: "annualized_actual_ytd_tax_calculation", methodVersion: "through-date-tax-v1" } }),
      ],
    },
  ];
  const calculationGraph = buildMockCalculationGraph({ sections, generatedAt, runId });
  return {
    run: { id: runId, taxYear, throughDate: asOfDate, calculatedAt: generatedAt, status: "completed", workpaperStatus: "complete", calculationVersion: "demo-tax-v1", mode: "demo" },
    basis: { entityType: "s_corp", entityPath: "s_corporation", taxElection: "s_corp", filingStatus: "single", state: "NC", accountingMethod: "cash", projectionMethod: "demo_run_rate", throughTodayMethod: "annualized_actual_ytd_tax_calculation", profileReviewedAt: `${asOfDate}T16:30:00.000Z` },
    summary: { projectedAnnualTax: projectedTotalTax, taxAttributableThroughToday: taxGeneratedYtd, confirmedPayments: paidAndWithheld, confirmedWithholding: null, confirmedPaymentsAndWithholding: paidAndWithheld, remainingProjectedLiability: remainingLiability, projectedOverpayment: 0, recommendedReserve, confidence: { score: 84, level: "good", status: "demo" } },
    narrative: `Based on your books through ${asOfLabel}, Bizzi projects $24,800 in total ${taxYear} tax. The estimate includes $182,000 of actual revenue, $130,000 of projected remaining revenue, and $64,200 of deductible expenses.`,
    sections,
    calculationGraph,
    assumptions: ["Demo assumes a North Carolina S-Corp with owner wages already recorded through payroll."],
    exclusions: ["QBI deduction is not included in the demo calculation."],
    missingInputs: [],
    reviewItems: [],
    ruleVersions: [],
    sourceFreshness: [{ source: "books", status: "current", label: "Demo books current" }],
    sourceLineage: { historicalSnapshotWarning: "Demo workpaper uses canonical fixture ledger lines." },
    paymentApplication: { appliedPaymentIds: ["demo-pay-q1-fed", "demo-pay-q2-fed", "demo-pay-q1-nc", "demo-withholding"], totalApplied: paidAndWithheld },
    reconciliation: { status: "reconciled", ready: true, incomeBridgeBalanced: true, deductionBridgeBalanced: true, businessProfitBalanced: true, federalBridgeBalanced: true, stateBridgeBalanced: true, taxComponentsBalanced: true, paymentBridgeBalanced: true, reserveBridgeBalanced: true, checks: [] },
    history: { immutable: true },
    warnings: [],
  };
}

function buildMockCalculationGraph({ sections, generatedAt, runId }) {
  const rawNodes = sections.flatMap((section, sectionIndex) =>
    section.lines.map((line, lineIndex) => ({
      ...line,
      sectionSortOrder: sectionIndex * 1000,
      lineSortOrder: lineIndex * 10,
    }))
  );
  const byCode = new Map(rawNodes.map((line) => [line.code, line]));
  const childMap = {
    "annual_income_bridge:projected_annual_income": [
      "annual_income_bridge:actual_ytd_income",
      "annual_income_bridge:projected_remaining_income",
    ],
    "business_taxable_income_bridge:projected_business_taxable_profit": [
      "business_taxable_income_bridge:projected_annual_revenue",
      "business_taxable_income_bridge:deductible_expenses",
    ],
    "total_tax_components:projected_annual_tax": [
      "total_tax_components:federal_income_tax",
      "total_tax_components:state_individual_income_tax",
      "total_tax_components:entity_level_tax",
    ],
    "remaining_liability:remaining_projected_liability": [
      "remaining_liability:projected_annual_tax",
      "remaining_liability:confirmed_applicable_payments",
    ],
    "reserve_bridge:recommended_reserve": [
      "reserve_bridge:remaining_projected_liability",
    ],
  };
  const parentMap = Object.entries(childMap).reduce((acc, [parent, children]) => {
    children.forEach((child) => { acc[child] = parent; });
    return acc;
  }, {});
  const nodes = rawNodes.map((line, index) => {
    const childNodeCodes = (childMap[line.code] || []).filter((code) => byCode.has(code));
    const inputs = childNodeCodes.map((code) => {
      const child = byCode.get(code);
      return {
        code,
        nodeCode: code,
        label: child.label,
        amount: child.amount,
        unit: "money",
      };
    });
    const amount = line.amount == null ? null : Number(line.amount);
    return {
      id: `demo-node-${index + 1}`,
      calculationRunId: runId,
      nodeCode: line.code,
      nodeType: childNodeCodes.length ? "subtotal" : line.source?.referencesAvailable ? "source_value" : line.formula?.code ? "formula" : "engine_output",
      sectionCode: line.section,
      parentNodeCode: parentMap[line.code] || line.parentCode || null,
      sortOrder: line.sectionSortOrder + line.lineSortOrder,
      label: line.label,
      description: line.explanation,
      amount,
      unit: "money",
      displaySign: line.displaySign,
      currency: "USD",
      status: line.status,
      actualOrProjected: line.isActual ? "actual" : line.isProjection ? "projected" : line.status === "estimated" ? "estimated" : null,
      supportLevel: line.supportLevel,
      confidence: line.confidence,
      formulaCode: line.formula?.code || formulaCodeForMockLine(line.code, childNodeCodes),
      formulaOperator: childNodeCodes.length ? "sum" : "engine_output",
      formulaExpression: mockFormulaExpression(line, inputs),
      formulaDescription: line.formula?.description || line.explanation,
      inputValues: inputs,
      childNodeCodes,
      sourceRefs: mockGraphSourceRefs(line, amount),
      ruleRefs: mockGraphRuleRefs(line),
      assumptionRefs: line.isProjection ? [{ code: "demo_projection_assumption", version: "demo-v1" }] : [],
      drilldownType: line.drillDown?.type || (line.source?.referencesAvailable ? "source_transactions" : null),
      drilldownParams: line.drillDown?.params || (line.source?.referencesAvailable ? { workspacePath: "/dashboard/tax?view=deductions" } : {}),
      reconciliationExpectedAmount: amount,
      reconciliationActualAmount: amount,
      reconciliationDifference: 0,
      reconciliationStatus: amount == null ? null : "reconciled",
      calculationEngine: mockEngineForSection(line.section),
      calculationEnginePath: `demo.${line.section}.${line.code.split(":").pop()}`,
      calculationVersion: "demo-tax-graph-v1",
      traceabilityStatus: amount == null ? "unavailable" : "fully_traceable",
      traceabilityReasons: [],
      reproducibilityStatus: amount == null ? "unavailable" : "fully_traceable",
      metadata: line.metadata || {},
      createdAt: generatedAt,
    };
  });
  return {
    version: "tax-calculation-graph-v1",
    status: "fully_traceable",
    nodeCount: nodes.length,
    nodes,
    inputSnapshot: {
      version: "tax-calculation-input-snapshot-v1",
      source: "demo",
      runId,
      capturedAt: generatedAt,
    },
    validation: {
      version: "tax-calculation-graph-v1",
      status: "fully_traceable",
      ok: true,
      fullyTraceable: true,
      materialFailureCount: 0,
      limitationCount: 0,
      nodeResults: Object.fromEntries(nodes.map((node) => [node.nodeCode, { status: node.traceabilityStatus, reasons: [] }])),
      failures: [],
    },
    generatedAt,
  };
}

function formulaCodeForMockLine(code, childNodeCodes = []) {
  if (childNodeCodes.length) return "sum_child_nodes";
  if (code.includes("projected_business_taxable_profit")) return "annual_revenue_minus_deductions";
  if (code.includes("remaining_projected_liability")) return "annual_tax_minus_payments";
  if (code.includes("tax_attributable_through_date")) return "annualized_actual_ytd_tax_calculation";
  return "canonical_engine_output";
}

function mockFormulaExpression(line, inputs = []) {
  if (line.code === "annual_income_bridge:projected_annual_income") return "182000 + 130000 = 312000";
  if (line.code === "business_taxable_income_bridge:projected_business_taxable_profit") return "312000 - 64200 = 247800";
  if (line.code === "total_tax_components:projected_annual_tax") return "13900 + 3900 + 7000 = 24800";
  if (line.code === "remaining_liability:remaining_projected_liability") return "24800 - 12400 = 12400";
  if (inputs.length) return `${inputs.map((input) => Number(input.amount || 0)).join(" + ")} = ${Number(line.amount || 0)}`;
  return `${Number(line.amount || 0)} = ${Number(line.amount || 0)}`;
}

function mockGraphSourceRefs(line, amount) {
  if (line.source?.referencesAvailable) {
    return [{
      sourceType: line.source.type || "source_snapshot",
      sourceLabel: line.source.type === "transaction_tax_classifications" ? "classified book transactions" : line.source.type,
      count: line.source.count || 1,
      amountUsed: amount,
      relevantField: "amount",
      snapshotValue: amount,
      inclusionTreatment: line.displaySign === "subtract" ? "deducted" : "included",
    }];
  }
  return [{
    sourceType: "calculation_run_snapshot",
    sourceLabel: "demo calculation snapshot",
    count: 1,
    amountUsed: amount,
    relevantField: line.code,
    snapshotValue: amount,
    inclusionTreatment: line.displaySign === "subtract" ? "subtracted" : "included",
  }];
}

function mockGraphRuleRefs(line) {
  const jurisdiction = line.code.includes("state") || line.label.includes("North Carolina") ? "NC" : line.code.includes("federal") ? "US" : null;
  return [{
    ruleCode: line.formula?.code || formulaCodeForMockLine(line.code),
    version: "demo-rule-v1",
    taxYear: TAX_YEAR,
    jurisdiction,
    sourceName: "Bizzi demo rule snapshot",
    supportLevel: line.supportLevel || "supported",
  }];
}

function mockEngineForSection(section) {
  const engines = {
    source_period_income: "taxable_income",
    projected_remaining_year_income: "projection",
    annual_income_bridge: "projection",
    deductions: "deductions",
    business_taxable_income_bridge: "taxable_income",
    entity_treatment: "entity",
    total_tax_components: "orchestrator",
    payment_application_snapshot: "payments",
    remaining_liability: "orchestrator",
    reserve_bridge: "reserve",
    through_date_tax: "through_date",
  };
  return engines[section] || "workpaper";
}

function buildMockTrend({ taxYear, asOfDate, projectedTotalTax, paidAndWithheld, recommendedReserve }) {
  const currentIndex = currentMonthIndex({ taxYear, asOfDate });
  const projected = [1900, 3700, 5700, 7800, 10100, 12100, 13740, 16600, 19000, 21100, 23100, projectedTotalTax];
  const currentTaxGenerated = mockTaxGeneratedThroughDate({ taxYear, asOfDate, projectedTotalTax });
  return projected.map((value, index) => {
    const month = `${taxYear}-${String(index + 1).padStart(2, "0")}`;
    const isCurrent = index === currentIndex;
    const isActual = index <= currentIndex;
    const actualValue = isCurrent ? currentTaxGenerated : value;
    return {
      month,
      periodType: isCurrent ? "current_partial" : isActual ? "actual" : "projected",
      isCurrent,
      cumulativeActualTax: isActual ? actualValue : null,
      projectedCumulativeTax: isActual ? null : value,
      projectedYearEndTax: projectedTotalTax,
      paymentsApplied: Math.min(paidAndWithheld, Math.round((paidAndWithheld / Math.max(currentIndex + 1, 1)) * Math.min(index + 1, currentIndex + 1))),
      reserveTarget: recommendedReserve,
      confidenceLevel: "good",
    };
  });
}

function buildMockPayments({ taxYear, paidAndWithheld }) {
  const rows = [
    payment("demo-pay-q1-fed", `${taxYear}-04-15`, "federal", null, "estimated_payment", "Q1", 2500, "manual", "Confirmed manual entry"),
    payment("demo-pay-q2-fed", `${taxYear}-06-15`, "federal", null, "estimated_payment", "Q2", 2500, "bank_match", "Matched to bank transaction"),
    payment("demo-pay-q1-nc", `${taxYear}-04-15`, "state", "NC", "estimated_payment", "Q1", 600, "manual", "Confirmed manual entry"),
    payment("demo-withholding", `${taxYear}-07-15`, "federal", null, "withholding", "YTD", 6800, "payroll", "Imported from payroll"),
  ];
  return {
    status: "available",
    rows,
    totals: {
      federalPaidAndWithheld: 11800,
      statePaidAndWithheld: 600,
      totalPaidAndWithheld: paidAndWithheld,
    },
    federal: { estimatedPayments: 5000, withholding: 6800, extensionPayments: null, priorYearCredits: null, refundApplied: null, balanceDuePayments: null },
    state: { estimatedPayments: 600, withholding: null, extensionPayments: null, priorYearCredits: null, refundApplied: null, balanceDuePayments: null },
    reconciliationWarnings: [],
  };
}

function payment(id, paymentDate, jurisdiction, stateCode, paymentType, quarter, amount, source, note) {
  return {
    id,
    paymentDate,
    jurisdiction,
    stateCode,
    paymentType,
    amount,
    source,
    status: "posted",
    metadata: { quarter, notes: note },
  };
}

function buildMockReserve({ taxYear, recommendedReserve, currentReserve, reserveGap }) {
  const account = {
    id: "demo-reserve-account",
    displayName: "Tax Reserve",
    mask: "4821",
    trackingMethod: "manual",
    isPrimary: true,
    currentBalance: currentReserve,
    lastVerifiedAt: "2026-07-17T15:00:00.000Z",
    updatedAt: "2026-07-17T15:00:00.000Z",
  };
  return {
    status: "on_track",
    account,
    reserve: {
      currentReserve,
      recommendedReserve,
      reserveGap,
      surplusAmount: null,
      immediateTransferRecommended: 750,
      lastVerifiedAt: account.lastVerifiedAt,
    },
    recommendedReserve,
    currentReserve,
    reserveGap,
    liability: { nextPaymentAmount: 3500, nextPaymentDate: `${taxYear}-09-15` },
    cadence: { status: "available", frequency: "monthly", nextContributionDate: "2026-08-01", nextContributionAmount: 750 },
    warnings: [],
  };
}

function buildMockSafeHarbor({ taxYear, paidAndWithheld }) {
  return {
    status: "available",
    combined: {
      status: "available",
      method: "90% of current-year tax",
      requiredAnnual: 18000,
      coveredAmount: paidAndWithheld,
      remainingAmount: 5600,
      quarterSchedule: [
        { quarter: "Q1", dueDate: `${taxYear}-04-15`, amount: 4500, paid: 5200, remaining: 0 },
        { quarter: "Q2", dueDate: `${taxYear}-06-15`, amount: 4500, paid: 6200, remaining: 0 },
        { quarter: "Q3", dueDate: `${taxYear}-09-15`, amount: 4500, paid: 1000, remaining: 3500 },
        { quarter: "Q4", dueDate: `${taxYear + 1}-01-15`, amount: 4500, paid: 0, remaining: 2100 },
      ],
    },
    warnings: [],
  };
}

function buildMockDeductions({ taxYear, asOfDate, generatedAt }) {
  return {
    meta: { source: "demo", taxYear, asOfDate, generatedAt },
    totals: {
      confirmedDeductibleAmount: 64200,
      autoClassifiedDeductibleAmount: 3400,
      estimatedDeductibleAmount: 3400,
      needsReviewAmount: 2100,
      nondeductibleAmount: 5600,
      capitalizableAmount: 4200,
      balanceSheetActivityAmount: 12600,
      excludedAmount: 0,
    },
    coverage: {
      eligiblePostedCount: 248,
      classifiedCount: 238,
      needsReviewCount: 5,
      classificationCoveragePercent: 96,
      confirmedCoveragePercent: 89,
      bookAmountCovered: 221400,
      needsReviewBookAmount: 2100,
    },
    categories: [
      category("materials", "Materials", 24800, 25, "high"),
      category("subcontractors", "Subcontractors", 18400, 18, "high"),
      category("vehicle_fuel", "Vehicle fuel", 7200, 34, "medium"),
      category("insurance", "Insurance", 4900, 6, "high"),
      category("meals", "Meals", 1150, 14, "medium", 2300),
    ],
    setupState: { state: "needs_review", message: "Five demo transactions need review before they can be confirmed." },
    warnings: [],
  };
}

function category(taxCategory, displayName, confirmedDeductibleAmount, transactionCount, confidenceLevel, estimatedDeductibleAmount = null) {
  return { taxCategory, displayName, confirmedDeductibleAmount, estimatedDeductibleAmount, transactionCount, confidenceLevel, reviewCount: 0 };
}

function buildMockDeductionTransactions() {
  return {
    rows: [
      tx("demo-tx-1", "2026-07-15", "Home Depot", "Materials", 742, "materials", "fully_deductible", 100, "user_confirmed"),
      tx("demo-tx-2", "2026-07-14", "Shell", "Vehicle fuel", 86, "vehicle_fuel", "fully_deductible", 100, "auto_classified"),
      tx("demo-tx-3", "2026-07-12", "Amazon Business", "Tool purchase needs review", 420, "tools", "needs_review", null, "needs_review", true),
      tx("demo-tx-4", "2026-07-10", "First Watch", "Client meal", 72, "meals", "partially_deductible", 50, "auto_classified"),
      tx("demo-tx-5", "2026-07-08", "Erie Insurance", "Liability insurance", 910, "insurance", "fully_deductible", 100, "user_confirmed"),
      tx("demo-tx-6", "2026-07-05", "Carolina Subcontracting", "Subcontract labor", 2800, "subcontractors", "fully_deductible", 100, "user_confirmed"),
      tx("demo-tx-7", "2026-07-03", "Equipment Depot", "Compressor purchase", 4200, "equipment", "capitalizable", 0, "needs_review", true),
      tx("demo-tx-8", "2026-07-01", "Owner draw", "Owner distribution", 3600, "owner_draw", "balance_sheet", 0, "auto_classified"),
    ],
    count: 8,
  };
}

function tx(id, date, merchantName, description, amount, taxCategory, deductibilityStatus, deductiblePercent, classificationStatus, requiresReview = false) {
  const qboAccountName = {
    materials: "Materials",
    vehicle_fuel: "Vehicle fuel",
    tools: "Tools",
    meals: "Meals",
    insurance: "Insurance",
    subcontractors: "Subcontractors",
    equipment: "Equipment",
    owner_draw: "Owner distributions",
  }[taxCategory] || "Unmapped QuickBooks account";
  return {
    transactionId: id,
    date,
    merchantName,
    description,
    qboAccountName,
    absoluteAmount: amount,
    signedAmount: -amount,
    taxCategory,
    deductibilityStatus,
    deductiblePercent,
    deductibleAmount: deductiblePercent == null ? null : Math.round(amount * deductiblePercent) / 100,
    confidenceScore: requiresReview ? 48 : 91,
    confidenceLevel: requiresReview ? "low" : "high",
    classificationStatus,
    requiresReview,
    source: "demo",
  };
}

function currentLocalIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentMonthIndex({ taxYear, asOfDate }) {
  const [yearText, monthText] = String(asOfDate || "").split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return 11;
  if (year < taxYear) return 0;
  if (year > taxYear) return 11;
  return Math.max(0, Math.min(11, month - 1));
}

function mockTaxGeneratedThroughDate({ taxYear, asOfDate, projectedTotalTax }) {
  const projected = [1900, 3700, 5700, 7800, 10100, 12100, 13740, 16600, 19000, 21100, 23100, projectedTotalTax];
  const index = currentMonthIndex({ taxYear, asOfDate });
  const day = Number(String(asOfDate || "").slice(8, 10)) || 1;
  const days = daysInMonth(taxYear, index);
  const previous = index > 0 ? projected[index - 1] : 0;
  const current = projected[index] ?? projectedTotalTax;
  const ratio = Math.max(0, Math.min(1, day / days));
  return Math.round(previous + (current - previous) * ratio);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function formatFixtureDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return "today";
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function formatFixtureShortDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return "today";
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default buildMockTaxFixture;
