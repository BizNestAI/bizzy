import { Router } from "express";
import crypto from "crypto";
import { supabase } from "../../services/supabaseAdmin.js";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { fetchChartOfAccounts, fetchQboAccountByIdForBusiness } from "../../services/bookkeeping/qboAccounts.js";
import { getManualQboAccountCatalog } from "../../services/bookkeeping/qboAccountTypes.js";
import {
  createManualQboAccountForBusiness,
  qboManualAccountCreationErrorResponse,
} from "../../services/bookkeeping/qboManualAccountCreationService.js";
import { postSingleBookkeepingTransactionNow } from "../../jobs/booksPost.cron.js";
import { runQboSync } from "../accounting/qbo-sync.js";
import { ensurePnLPdf } from "../accounting/pnlPdfService.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "../../services/bookkeeping/bookkeepingScope.js";
import { enqueueUnresolvedBookkeepingBacklog } from "../../services/bookkeeping/backgroundBookkeepingProcessingService.js";
import { reconsiderNeedsReviewTransactions } from "../../services/bookkeeping/routineExpenseReconsiderationService.js";
import {
  countBookkeepingTransactions,
  fetchBookkeepingTransactions,
  matchesTransactionStatusFilter,
} from "../../services/bookkeeping/bookkeepingTransactionFeedService.js";
import { getAvailableMonthlyReviewPeriods } from "../../services/bookkeeping/monthlyReviewAvailablePeriodsService.js";
import { deriveQboPostingLifecycle } from "../../services/bookkeeping/qboPostingLifecycle.js";
import {
  deriveTraceReconciliationStatus,
  formatPlaidAccountDisplayLabel,
} from "../../services/bookkeeping/postingTraceDisplay.js";
import { derivePipelineStatus } from "../../services/bookkeeping/reconciliationPipelineStatus.js";
import {
  buildMonthlyPipelineRow,
  loadAuthoritativeMonthlyPlaidTransactions as loadSharedAuthoritativeMonthlyPlaidTransactions,
  loadMonthlyReconciliationPipeline,
  normalizeMonthInput,
  removeSupersededPendingPlaidRows as removeSharedSupersededPendingPlaidRows,
} from "../../services/bookkeeping/monthlyReconciliationPipelineService.js";
import {
  approveExistingQboAccountForCanonical,
  createPreferredQboAccountForCanonical,
  fetchCanonicalAccountMappingsForBusiness,
} from "../../services/bookkeeping/canonicalQboAccountResolver.js";
import {
  createQboVendorForCanonicalReview,
  fetchCanonicalVendorActivityForBusiness,
  useExistingQboVendorForCanonical,
} from "../../services/bookkeeping/canonicalVendorService.js";
import {
  approveBookkeepingTransactions,
  BookkeepingApprovalError,
} from "../../services/bookkeeping/bookkeepingApprovalService.js";
import {
  confirmCreditCardPaymentMatchForTransaction,
  markTransactionAsCreditCardPayment,
  rejectCreditCardPaymentSuggestion,
} from "../../services/bookkeeping/creditCardPaymentPairService.js";
import {
  BookkeepingReclassificationError,
  reclassifyBookkeepingTransaction,
  updatePostedQboTransactionAccount,
} from "../../services/bookkeeping/bookkeepingReclassificationService.js";
import { refreshOperatorRequestSummaryBestEffort } from "../../services/bookkeeping/operatorRequestSummaryService.js";
import {
  fetchMonthlyQboPnlAccountTransactions,
  getMonthlyQboPnlSnapshot,
  refreshMonthlyQboPnlSnapshot,
} from "../../services/bookkeeping/qboMonthlyPnlIngestionService.js";
import { refreshMonthlyQboFinancialSnapshot } from "../../services/accounting/healthMonthlySnapshotService.js";
import { ensureForecastV1Run } from "../../services/accounting/forecastV1Service.js";
import { getConnectedFinancialAccountsForBusiness } from "../../services/plaid/plaidIntegrationService.js";
import { MONTHLY_REVIEW_STAFF_ROLES, requireInternalRole } from "../_shared/internalStaffAuth.js";
import {
  buildAccountingCloseFinalizationGuard,
  buildFinalizationGuard,
  buildReconciliationKpis,
  canonicalKeyFromCategorization,
  findTrueReconciliationExceptionItems,
  selectedMonthTransactionStillRequiresCanonicalMapping,
} from "./monthlyReviewCloseGuard.js";

const router = Router();

const SECTION_DEFS = [
  { key: "forecasting", label: "Forecasting", route: "/dashboard/accounting/forecasts", required: true },
  { key: "tax_liability", label: "Tax Liability", route: "/dashboard/tax", required: true },
  { key: "job_costing", label: "Job Costing", route: "/dashboard/leads-jobs/job-costing", required: true },
  { key: "reconciliations", label: "Reconciliations", route: "/dashboard/accounting/reconciliations", required: true },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTHLY_REVIEW_BOOKKEEPING_FEED_STATUSES = new Set(["needs_review", "handled", "pending"]);
const MONTHLY_REVIEW_BOOKKEEPING_PAGE_SIZE_DEFAULT = 25;
const MONTHLY_REVIEW_BOOKKEEPING_PAGE_SIZE_MAX = 100;
const MONTHLY_REVIEW_QBO_PNL_DETAIL_PAGE_SIZE_DEFAULT = 100;
const MONTHLY_REVIEW_QBO_PNL_DETAIL_PAGE_SIZE_MAX = 250;

router.use(requireAuth);
router.use(requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES));

function sendMonthlyReviewError(res, fallbackError, fallbackMessage, e) {
  return res.status(e?.status || 500).json({
    ok: false,
    error: e?.error || fallbackError,
    message: e?.message || fallbackMessage,
  });
}

async function assertRunTransactionInSelectedMonth(run, transactionId) {
  const [start, end] = monthBounds(run.review_month);
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, run.business_id);
  const { data: bankTxn, error: bankErr } = await supabase
    .from("bank_transactions")
    .select("id,business_id,date,pending,is_archived,accounting_review_required")
    .eq("business_id", run.business_id)
    .eq("id", transactionId)
    .eq("is_archived", false)
    .gte("date", start)
    .lt("date", end)
    .maybeSingle();
  if (bankErr) throw bankErr;
  if (!bankTxn || !isTransactionInActiveBookkeepingScope(bankTxn, bookkeepingStartDate)) {
    const err = new Error("transaction_not_in_selected_month");
    err.status = 409;
    err.code = "transaction_not_in_selected_month";
    throw err;
  }
  return bankTxn;
}

router.get("/me", async (req, res) => {
  res.json({
    ok: true,
    user: { id: req.user.id, email: req.user.email, internal: true },
    staff: { user_id: req.internalStaff.userId, role: req.internalStaff.role, active: true },
    safeguards: {
      route: "/api/admin/monthly-review",
      auth: "Supabase auth required",
      authorization: "Active Bizzi internal staff only",
      customer_access: false,
    },
  });
});

router.get("/businesses", async (req, res) => {
  try {
    const month = normalizeMonth(req.query.month);
    const statusFilter = String(req.query.status || "all").trim();
    const { data: businesses, error } = await supabase
      .from("business_profiles")
      .select("id,business_name,industry")
      .order("business_name", { ascending: true });

    if (error) throw error;

    const ids = (businesses || []).map((row) => row.id);
    const runMap = ids.length ? await fetchRunMap(ids, month) : new Map();
    const stampMap = ids.length ? await fetchStampMap(ids, month) : new Map();

    const rows = (businesses || []).map((business) => {
      const run = runMap.get(business.id) || null;
      const stamp = stampMap.get(business.id) || null;
      return {
        ...business,
        review_month: month,
        review_status: stamp ? "finalized" : run?.status || "not_started",
        reviewed_sections: Number(run?.reviewed_sections || 0),
        blocked_sections: Number(run?.blocked_sections || 0),
        total_sections: SECTION_DEFS.length,
        finalized_at: stamp?.completed_at || run?.finalized_at || null,
        assigned_reviewer_email: run?.assigned_reviewer_email || null,
        readiness_score: Number(run?.readiness_score || 0),
        last_reminder_at: run?.last_reminder_at || null,
      };
    }).filter((business) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "blocked") return Number(business.blocked_sections || 0) > 0;
      return business.review_status === statusFilter;
    });

    res.json({ ok: true, month, businesses: rows });
  } catch (e) {
    console.error("[monthly-review] businesses failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_businesses_failed", "Could not load businesses.", e);
  }
});

router.get("/businesses/:businessId/available-periods", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    await assertMonthlyReviewBusinessExists(businessId);
    const periods = await getAvailableMonthlyReviewPeriods({ businessId, db: supabase });
    res.json({
      ok: true,
      business_id: businessId,
      periods,
      books_start_date: periods.find((period) => period.booksStartDate)?.booksStartDate || null,
    });
  } catch (e) {
    console.error("[monthly-review] available periods failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_available_periods_failed", "Could not load available review periods.", e);
  }
});

router.get("/businesses/:businessId", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const month = normalizeMonth(req.query.month);

    const { data: business, error: bizErr } = await supabase
      .from("business_profiles")
      .select("id,business_name,industry")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return res.status(404).json({ ok: false, error: "business_not_found" });

    await assertMonthlyReviewPeriodAvailable(businessId, month);
    const run = await ensureRun(businessId, month, req.user.id);
    const sections = await ensureSections(run.id);
    const summaries = await buildSummaries(businessId, month);
    const stamp = await fetchStamp(businessId, month);
    const auditEvents = await fetchAuditEvents(run.id);
    const reminders = await fetchReminders(run.id);
    const sourceLedger = await buildMonthlySourceLedger(businessId, month);
    const operatorResponses = await fetchOperatorResponsesAwaitingReview(businessId, month);
    const canonicalCoa = await buildCanonicalCoaEvidence(businessId, month);
    const canonicalVendors = await buildCanonicalVendorEvidence(businessId, month);
    const pnlReport = await fetchMonthlyPnlReport(businessId, month);
    const finalizationGuard = buildAccountingCloseFinalizationGuard({
      sourceLedger,
      operatorResponses,
      canonicalCoa,
      reconciliationEvidence: summaries.reconciliations,
    });
    const currentEvidence = buildCurrentReviewEvidence(summaries, sourceLedger);
    const currentEvidenceHash = hashEvidence(currentEvidence);
    const changedSinceFinalized = run.evidence_hash && run.status === "finalized" && run.evidence_hash !== currentEvidenceHash
      ? buildEvidenceChanges(run.evidence_snapshot || {}, currentEvidence)
      : [];
    const readiness = computeReadiness(sections, summaries);
    if (Number(run.readiness_score || 0) !== readiness.score) {
      await supabase
        .from("monthly_review_runs")
        .update({ readiness_score: readiness.score, updated_at: new Date().toISOString() })
        .eq("id", run.id);
    }

    res.json({
      ok: true,
      business,
      month,
      run: { ...run, computed_readiness_score: readiness.score },
      stamp,
      audit_events: auditEvents,
      reminders,
      pnl_report: pnlReport,
      changed_since_finalized: changedSinceFinalized,
      readiness,
      finalization_guard: finalizationGuard,
      canonical_chart_of_accounts: canonicalCoa,
      canonical_vendors: canonicalVendors,
      operator_responses: operatorResponses,
      active_lock: describeActiveLock(run),
      access: {
        internal_admin_only: true,
        writes_server_guarded: true,
        customer_access: false,
      },
      sections: sections.map((section) => ({
        ...section,
        definition: SECTION_DEFS.find((def) => def.key === section.section_key) || null,
        summary: summaries[section.section_key] || null,
        source_review: buildSectionSourceReview(section.section_key, summaries[section.section_key], sourceLedger),
        changed_since_snapshot: Boolean(section.evidence_hash && summaries[section.section_key] && section.evidence_hash !== hashEvidence(summaries[section.section_key])),
      })),
      section_defs: SECTION_DEFS,
    });
  } catch (e) {
    console.error("[monthly-review] detail failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_detail_failed", "Could not load review.", e);
  }
});

router.get("/businesses/:businessId/connected-accounts", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });

    const { data: business, error: bizErr } = await supabase
      .from("business_profiles")
      .select("id")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return res.status(404).json({ ok: false, error: "business_not_found" });

    const connected = await getConnectedFinancialAccountsForBusiness({ businessId });
    return res.json({
      ok: true,
      business_id: businessId,
      ...connected,
    });
  } catch (e) {
    console.error("[monthly-review] connected accounts failed", e?.message || e);
    res.status(500).json({
      ok: false,
      error: "monthly_review_connected_accounts_failed",
      message: e?.message || "Could not load connected financial accounts.",
    });
  }
});

router.get("/businesses/:businessId/qbo/account-types", async (_req, res) => {
  return res.json({ ok: true, account_types: getManualQboAccountCatalog() });
});

router.post("/businesses/:businessId/qbo/accounts", async (req, res) => {
  try {
    const business = await assertMonthlyReviewBusinessExists(req.params.businessId);
    const result = await createManualQboAccountForBusiness({
      businessId: business.id,
      name: req.body?.name,
      accountType: req.body?.accountType || req.body?.account_type,
      accountSubType: req.body?.accountSubType || req.body?.account_subtype || req.body?.detailType,
      description: req.body?.description,
      actor: req.user?.id || req.user?.email || "internal_admin",
    });
    try {
      await enqueueUnresolvedBookkeepingBacklog({
        businessId: business.id,
        supabase,
        limit: 100,
        now: new Date(),
      });
    } catch (enqueueErr) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[monthly-review] post-account-create reconsideration enqueue skipped", enqueueErr?.message || enqueueErr);
      }
    }
    return res.status(201).json(result);
  } catch (err) {
    const response = qboManualAccountCreationErrorResponse(err);
    return res.status(response.status).json(response.body);
  }
});

router.post("/businesses/:businessId/qbo-pnl/refresh", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const { year, month } = parseReviewYearMonth(req.body?.year || req.query?.year, req.body?.month || req.query?.month);
    const business = await assertMonthlyReviewBusinessExists(businessId);
    const result = await refreshMonthlyQboPnlSnapshot({
      businessId,
      year,
      month,
    });
    const snapshot = await getMonthlyQboPnlSnapshot({
      businessId,
      year,
      month,
      includeAccounts: true,
      includeTransactions: false,
    });
    return res.json({
      ok: true,
      business_id: business.id,
      year,
      month,
      snapshot: snapshot || result.snapshot,
      previous_snapshot: result.previousSnapshot,
      new_snapshot: {
        id: (snapshot || result.snapshot)?.id || null,
        snapshot_version: (snapshot || result.snapshot)?.snapshot_version || null,
        pulled_at: (snapshot || result.snapshot)?.pulled_at || null,
        status: (snapshot || result.snapshot)?.status || null,
        is_current: (snapshot || result.snapshot)?.is_current === true,
      },
      refresh_proof: {
        ...(result.refreshProof || {}),
        new_snapshot: {
          ...(result.refreshProof?.new_snapshot || {}),
          id: (snapshot || result.snapshot)?.id || result.refreshProof?.new_snapshot?.id || null,
          snapshot_version: (snapshot || result.snapshot)?.snapshot_version || result.refreshProof?.new_snapshot?.snapshot_version || null,
          pulled_at: (snapshot || result.snapshot)?.pulled_at || result.refreshProof?.new_snapshot?.pulled_at || null,
          status: (snapshot || result.snapshot)?.status || result.refreshProof?.new_snapshot?.status || null,
          is_current: (snapshot || result.snapshot)?.is_current === true || result.refreshProof?.new_snapshot?.is_current === true,
        },
      },
      association_version: result.refreshProof?.association_version || null,
      detail_transaction_count: result.refreshProof?.detail_transaction_count ?? result.transactions.length,
      rows_by_pnl_qbo_account_id: result.refreshProof?.rows_by_pnl_qbo_account_id || {},
      backend_build: result.refreshProof?.backend_build || null,
      account_count: Array.isArray(snapshot?.accounts) ? snapshot.accounts.length : result.accounts.length,
      transaction_count: result.transactions.length,
      linkage: result.linkage,
      source: result.source,
      provider_calls: {
        qbo_reads: true,
        qbo_writes: false,
        plaid_calls: false,
        ai_calls: false,
      },
    });
  } catch (e) {
    console.error("[monthly-review] QBO P&L refresh failed", e?.message || e);
    return res.status(e?.status || 500).json({
      ok: false,
      error: e?.error || "monthly_review_qbo_pnl_refresh_failed",
      message: e?.message || "Could not refresh the QuickBooks P&L snapshot.",
      details: e?.details || undefined,
    });
  }
});

router.get("/businesses/:businessId/qbo-pnl", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const { year, month } = parseReviewYearMonth(req.query?.year, req.query?.month);
    const business = await assertMonthlyReviewBusinessExists(businessId);
    const snapshot = await getMonthlyQboPnlSnapshot({
      businessId,
      year,
      month,
      includeAccounts: true,
      includeTransactions: false,
    });
    return res.json({
      ok: true,
      business_id: business.id,
      year,
      month,
      snapshot,
      provider_calls: {
        qbo_reads: false,
        qbo_writes: false,
      },
    });
  } catch (e) {
    console.error("[monthly-review] QBO P&L snapshot load failed", e?.message || e);
    return res.status(e?.status || 500).json({
      ok: false,
      error: e?.error || "monthly_review_qbo_pnl_load_failed",
      message: e?.message || "Could not load the QuickBooks P&L snapshot.",
    });
  }
});

router.get("/businesses/:businessId/qbo-pnl/accounts/:accountId/transactions", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const { year, month } = parseReviewYearMonth(req.query?.year, req.query?.month);
    const accountId = String(req.params.accountId || "").trim();
    if (!accountId) return res.status(400).json({ ok: false, error: "missing_account_id" });
    await assertMonthlyReviewBusinessExists(businessId);
    const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query?.page_size, 10) || MONTHLY_REVIEW_QBO_PNL_DETAIL_PAGE_SIZE_DEFAULT, 1),
      MONTHLY_REVIEW_QBO_PNL_DETAIL_PAGE_SIZE_MAX
    );
    const result = await fetchMonthlyQboPnlAccountTransactions({
      businessId,
      year,
      month,
      accountId,
      page,
      pageSize,
    });
    return res.json({
      ok: true,
      business_id: businessId,
      year,
      month,
      account_id: accountId,
      snapshot_id: result.snapshot?.id || null,
      rows: result.rows,
      total_count: result.totalCount,
      meta: {
        page: result.page,
        page_size: result.pageSize,
        total_count: result.totalCount,
        page_count: Math.max(1, Math.ceil(Number(result.totalCount || 0) / result.pageSize)),
      },
      provider_calls: {
        qbo_reads: false,
        qbo_writes: false,
      },
    });
  } catch (e) {
    console.error("[monthly-review] QBO P&L account transactions load failed", e?.message || e);
    return res.status(e?.status || 500).json({
      ok: false,
      error: e?.error || "monthly_review_qbo_pnl_transactions_load_failed",
      message: e?.message || "Could not load QuickBooks P&L transactions.",
    });
  }
});

router.get("/businesses/:businessId/bookkeeping/transactions/counts", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const month = normalizeMonth(req.query.month);
    const accountId = req.query?.account_id || req.query?.plaid_account_id || null;

    const { data: business, error: bizErr } = await supabase
      .from("business_profiles")
      .select("id")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return res.status(404).json({ ok: false, error: "business_not_found" });

    const [rangeStart, rangeEnd] = monthBounds(month);
    const [needsReview, handled, pending] = await Promise.all([
      countBookkeepingTransactions({
        businessId,
        statusFilter: "needs_review",
        accountId,
        rangeStart,
        rangeEnd,
      }),
      countBookkeepingTransactions({
        businessId,
        statusFilter: "handled",
        accountId,
        rangeStart,
        rangeEnd,
      }),
      countBookkeepingTransactions({
        businessId,
        statusFilter: "pending",
        accountId,
        rangeStart,
        rangeEnd,
      }),
    ]);

    return res.json({
      ok: true,
      business_id: businessId,
      month,
      range_start: rangeStart,
      range_end: rangeEnd,
      counts: {
        needs_review: needsReview,
        handled,
        pending,
      },
      source_contract: {
        service: "bookkeepingTransactionFeedService",
        selected_month_bounds: "server-side [range_start, range_end)",
        customer_books_review_semantics: true,
      },
    });
  } catch (e) {
    console.error("[monthly-review] bookkeeping feed counts failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_bookkeeping_feed_counts_failed", "Could not load bookkeeping feed counts.", e);
  }
});

router.get("/businesses/:businessId/bookkeeping/transactions", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const statusFilter = String(req.query?.status || "needs_review").toLowerCase();
    if (!MONTHLY_REVIEW_BOOKKEEPING_FEED_STATUSES.has(statusFilter)) {
      return res.status(400).json({ ok: false, error: "invalid_bookkeeping_feed_status" });
    }
    const month = normalizeMonth(req.query.month);
    const accountId = req.query?.account_id || req.query?.plaid_account_id || null;
    const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query?.page_size, 10) || MONTHLY_REVIEW_BOOKKEEPING_PAGE_SIZE_DEFAULT, 1),
      MONTHLY_REVIEW_BOOKKEEPING_PAGE_SIZE_MAX
    );

    const { data: business, error: bizErr } = await supabase
      .from("business_profiles")
      .select("id")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return res.status(404).json({ ok: false, error: "business_not_found" });

    const [rangeStart, rangeEnd] = monthBounds(month);
    const { rows, totalCount } = await fetchBookkeepingTransactions({
      businessId,
      statusFilter,
      accountId,
      rangeStart,
      rangeEnd,
      page,
      pageSize,
    });

    return res.json({
      ok: true,
      business_id: businessId,
      month,
      status: statusFilter,
      rows,
      totalCount,
      total_count: totalCount,
      meta: {
        page,
        page_size: pageSize,
        total_count: totalCount,
        page_count: Math.max(1, Math.ceil(totalCount / pageSize)),
        range_start: rangeStart,
        range_end: rangeEnd,
      },
      source_contract: {
        service: "bookkeepingTransactionFeedService",
        selected_month_bounds: "server-side [range_start, range_end)",
        customer_books_review_semantics: true,
        provider_calls: false,
      },
    });
  } catch (e) {
    console.error("[monthly-review] bookkeeping feed failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_bookkeeping_feed_failed", "Could not load bookkeeping transactions.", e);
  }
});

router.post("/businesses/:businessId/bookkeeping/transactions/:transactionId/credit-card-payment/confirm-match", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    const transactionId = req.params.transactionId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    if (!UUID_RE.test(String(transactionId))) return res.status(400).json({ ok: false, error: "invalid_transaction_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    await assertRunTransactionInSelectedMonth({ business_id: businessId, review_month: month }, transactionId);
    const targetQboAccountId = req.body?.target_qbo_account_id || req.body?.targetQboAccountId || null;
    if (!targetQboAccountId) return res.status(400).json({ ok: false, error: "missing_target_qbo_account_id" });

    const result = await confirmCreditCardPaymentMatchForTransaction({
      businessId,
      transactionId,
      targetQboAccountId,
    });
    if (result?.matched !== true) {
      return res.status(result?.code === "cc_payment_pair_ambiguous" ? 409 : 404).json({
        ok: false,
        error: result?.code || "cc_payment_no_matching_counterpart",
        message: result?.message || "No matching opposite-side payment was found yet.",
        candidates: result?.candidates || [],
      });
    }
    return res.json({
      ...result,
      business_id: businessId,
      month,
      qbo_provider_writes: false,
      qbo_transaction_writes: false,
    });
  } catch (e) {
    console.error("[monthly-review] credit-card payment match failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_cc_payment_match_failed", "Could not match credit-card payment.", e);
  }
});

router.post("/businesses/:businessId/bookkeeping/transactions/:transactionId/credit-card-payment/mark", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    const transactionId = req.params.transactionId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    if (!UUID_RE.test(String(transactionId))) return res.status(400).json({ ok: false, error: "invalid_transaction_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    await assertRunTransactionInSelectedMonth({ business_id: businessId, review_month: month }, transactionId);

    const result = await markTransactionAsCreditCardPayment({
      businessId,
      transactionId,
    });
    return res.json({
      ...result,
      business_id: businessId,
      month,
      qbo_provider_writes: false,
      qbo_transaction_writes: false,
    });
  } catch (e) {
    console.error("[monthly-review] credit-card payment mark failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_cc_payment_mark_failed", "Could not mark transaction as credit-card payment.", e);
  }
});

router.post("/businesses/:businessId/bookkeeping/transactions/:transactionId/credit-card-payment/reject", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    const transactionId = req.params.transactionId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    if (!UUID_RE.test(String(transactionId))) return res.status(400).json({ ok: false, error: "invalid_transaction_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    await assertRunTransactionInSelectedMonth({ business_id: businessId, review_month: month }, transactionId);

    const result = await rejectCreditCardPaymentSuggestion({
      businessId,
      transactionId,
    });
    return res.json({
      ...result,
      business_id: businessId,
      month,
      qbo_provider_writes: false,
      qbo_transaction_writes: false,
    });
  } catch (e) {
    console.error("[monthly-review] credit-card payment reject failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_cc_payment_reject_failed", "Could not switch transaction back to regular COA review.", e);
  }
});

router.post("/businesses/:businessId/bookkeeping/transactions/reconsider", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    const { data: business, error: bizErr } = await supabase
      .from("business_profiles")
      .select("id")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return res.status(404).json({ ok: false, error: "business_not_found" });

    const [rangeStart, rangeEnd] = monthBounds(month);
    const inclusiveRangeEnd = previousDate(rangeEnd);
    const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 200, 1), 500);
    const maxPages = Math.min(Math.max(parseInt(req.body?.max_pages, 10) || 10, 1), 25);
    const source = req.body?.source || "monthly_review_reconsideration";
    let cursor = req.body?.cursor ? String(req.body.cursor) : null;
    let pageCount = 0;
    const rows = [];
    const totals = { processed: 0, promoted: 0, skipped: 0 };
    const bucketCounts = {
      reviewed: 0,
      moved_to_handled: 0,
      still_needs_review: 0,
      pending: 0,
      protected_workflow: 0,
      suspense_no_specific_gl: 0,
      valid_gl_policy_blocked: 0,
      other: 0,
    };

    while (pageCount < maxPages) {
      const result = await reconsiderNeedsReviewTransactions(businessId, {
        dateFrom: rangeStart,
        dateTo: inclusiveRangeEnd,
        cursor,
        limit,
        source,
      });
      totals.processed += Number(result?.processed || 0);
      totals.promoted += Number(result?.promoted || 0);
      totals.skipped += Number(result?.skipped || 0);
      Object.keys(bucketCounts).forEach((key) => {
        bucketCounts[key] += Number(result?.bucket_counts?.[key] || 0);
      });
      if (Array.isArray(result?.rows)) rows.push(...result.rows);
      cursor = result?.next_cursor || null;
      pageCount += 1;
      if (!cursor) break;
    }
    const [remainingNeedsReviewThisMonth, remainingNeedsReviewAllMonths] = await Promise.all([
      countBookkeepingTransactions({
        businessId,
        statusFilter: "needs_review",
        rangeStart,
        rangeEnd,
      }),
      countBookkeepingTransactions({
        businessId,
        statusFilter: "needs_review",
      }),
    ]);

    return res.json({
      ok: true,
      business_id: businessId,
      month,
      range_start: rangeStart,
      range_end: rangeEnd,
      processed: totals.processed,
      promoted: totals.promoted,
      skipped: totals.skipped,
      reviewed_this_month: totals.processed,
      moved_to_handled_this_month: totals.promoted,
      remaining_needs_review_this_month: remainingNeedsReviewThisMonth,
      remaining_needs_review_all_months: remainingNeedsReviewAllMonths,
      bucket_counts: {
        ...bucketCounts,
        reviewed: totals.processed,
        moved_to_handled: totals.promoted,
        still_needs_review: remainingNeedsReviewThisMonth,
      },
      rows,
      next_cursor: cursor,
      partial: Boolean(cursor),
      batches: pageCount,
      source_contract: {
        service: "routineExpenseReconsiderationService",
        selected_month_bounds: "server-side [range_start, range_end)",
        qbo_provider_writes: false,
        qbo_transaction_writes: false,
      },
    });
  } catch (e) {
    console.error("[monthly-review] bookkeeping reconsideration failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_bookkeeping_reconsideration_failed", "Could not re-evaluate Needs Review transactions.", e);
  }
});

router.post("/businesses/:businessId/canonical-vendors/:canonicalVendorId/use-existing", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    const run = await ensureRun(businessId, month, req.user.id);
    const result = await useExistingQboVendorForCanonical({
      businessId,
      canonicalVendorId: req.params.canonicalVendorId,
      qboVendorId: req.body?.qbo_vendor_id,
      actor: req.user?.id || "admin",
      source: "monthly_review",
    });
    await logAuditEvent({
      run,
      eventType: "canonical_vendor_use_existing",
      actor: req.user,
      nextValue: {
        canonical_vendor_id: req.params.canonicalVendorId,
        qbo_vendor_id: req.body?.qbo_vendor_id || null,
        reconsideration: result.reconsideration || null,
      },
    }).catch(() => null);
    return res.json(result);
  } catch (e) {
    console.error("[monthly-review] canonical vendor use-existing failed", e?.message || e);
    return res.status(400).json({ ok: false, error: "monthly_review_canonical_vendor_use_existing_failed", message: e?.message || "Could not resolve vendor mapping." });
  }
});

router.post("/businesses/:businessId/canonical-vendors/:canonicalVendorId/create-bizzi-vendor", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    const run = await ensureRun(businessId, month, req.user.id);
    const result = await createQboVendorForCanonicalReview({
      businessId,
      canonicalVendorId: req.params.canonicalVendorId,
      transactionId: req.body?.transaction_id || null,
      actor: req.user?.id || "admin",
      source: "monthly_review",
    });
    await logAuditEvent({
      run,
      eventType: "canonical_vendor_create_bizzi",
      actor: req.user,
      nextValue: {
        canonical_vendor_id: req.params.canonicalVendorId,
        transaction_id: req.body?.transaction_id || null,
        result_status: result.status || result.reason || null,
        reconsideration: result.reconsideration || null,
      },
    }).catch(() => null);
    return res.status(result?.ok ? 200 : 409).json(result);
  } catch (e) {
    console.error("[monthly-review] canonical vendor create failed", e?.message || e);
    return res.status(400).json({ ok: false, error: "monthly_review_canonical_vendor_create_failed", message: e?.message || "Could not create vendor." });
  }
});

router.post("/businesses/:businessId/canonical-coa/:canonicalKey/use-existing", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    const run = await ensureRun(businessId, month, req.user.id);
    const result = await approveExistingQboAccountForCanonical({
      businessId,
      canonicalAccountKey: req.params.canonicalKey,
      qboAccountId: req.body?.qbo_account_id,
      actor: req.user?.id || "admin",
      source: "monthly_review",
    });
    await logAuditEvent({
      run,
      eventType: "canonical_coa_use_existing",
      actor: req.user,
      nextValue: {
        canonical_account_key: req.params.canonicalKey,
        qbo_account_id: req.body?.qbo_account_id || null,
        evidence: result.evidence || null,
        reconsideration: result.reconsideration || null,
      },
    }).catch(() => null);
    return res.json(result);
  } catch (e) {
    console.error("[monthly-review] canonical coa use-existing failed", e?.message || e);
    return res.status(400).json({ ok: false, error: "monthly_review_canonical_coa_use_existing_failed", message: e?.message || "Could not resolve account mapping." });
  }
});

router.post("/businesses/:businessId/canonical-coa/:canonicalKey/create-preferred", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    const run = await ensureRun(businessId, month, req.user.id);
    const result = await createPreferredQboAccountForCanonical({
      businessId,
      canonicalAccountKey: req.params.canonicalKey,
      reviewedCandidateQboAccountId: req.body?.reviewed_candidate_qbo_account_id || null,
      actor: req.user?.id || "admin",
      source: "monthly_review",
    });
    await logAuditEvent({
      run,
      eventType: "canonical_coa_create_preferred",
      actor: req.user,
      nextValue: {
        canonical_account_key: req.params.canonicalKey,
        reviewed_candidate_qbo_account_id: req.body?.reviewed_candidate_qbo_account_id || null,
        result_status: result.status || null,
        reconsideration: result.reconsideration || null,
      },
    }).catch(() => null);
    const statusCode = result?.ok ? 200 : 409;
    return res.status(statusCode).json(result);
  } catch (e) {
    console.error("[monthly-review] canonical coa create-preferred failed", e?.message || e);
    return res.status(400).json({ ok: false, error: "monthly_review_canonical_coa_create_preferred_failed", message: e?.message || "Could not create preferred account." });
  }
});

router.get("/businesses/:businessId/source-ledger", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    const month = normalizeMonth(req.query.month);
    const ledger = await buildMonthlySourceLedger(businessId, month);
    res.json({ ok: true, business_id: businessId, month, ...ledger });
  } catch (e) {
    console.error("[monthly-review] source ledger failed", e?.message || e);
    sendMonthlyReviewError(res, "monthly_review_source_ledger_failed", "Could not load source ledger.", e);
  }
});

router.post("/businesses/:businessId/operator-responses/:requestId/approve", async (req, res) => {
  try {
    const businessId = req.params.businessId;
    const requestId = req.params.requestId;
    if (!UUID_RE.test(String(businessId))) return res.status(400).json({ ok: false, error: "invalid_business_id" });
    if (!UUID_RE.test(String(requestId))) return res.status(400).json({ ok: false, error: "invalid_request_id" });
    const month = normalizeMonth(req.body?.month || req.query?.month);
    const accountId = String(req.body?.final_qbo_account_id || req.body?.account_id || "").trim();
    if (!accountId) return res.status(400).json({ ok: false, error: "missing_account" });
    const targetAccount = await resolveOperatorResponseTargetAccount(businessId, accountId);

    const { data: requestRow, error: requestErr } = await supabase
      .from("clarification_requests")
      .select("*")
      .eq("business_id", businessId)
      .eq("id", requestId)
      .eq("status", "answered")
      .is("resolved_at", null)
      .maybeSingle();
    if (requestErr) throw requestErr;
    if (!requestRow) return res.status(404).json({ ok: false, error: "operator_response_not_found" });

    const [start, end] = monthBounds(month);
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    const { data: bankTxn, error: bankErr } = await supabase
      .from("bank_transactions")
      .select("id,business_id,date,pending,is_archived,accounting_review_required")
      .eq("business_id", businessId)
      .eq("id", requestRow.transaction_id)
      .eq("is_archived", false)
      .gte("date", start)
      .lt("date", end)
      .maybeSingle();
    if (bankErr) throw bankErr;
    if (!bankTxn || !isTransactionInActiveBookkeepingScope(bankTxn, bookkeepingStartDate)) {
      return res.status(409).json({
        ok: false,
        error: "operator_response_transaction_not_in_selected_month",
        message: "This Operator Response is no longer tied to an active Needs Review transaction in the selected month.",
      });
    }
    const { data: currentCat, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,post_after,qbo_txn_id,qbo_txn_type,posted_at,post_error,last_post_attempt_at,meta")
      .eq("business_id", businessId)
      .eq("transaction_id", requestRow.transaction_id)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!matchesTransactionStatusFilter("needs_review", currentCat || {})) {
      return res.status(409).json({
        ok: false,
        error: "operator_response_transaction_not_needs_review",
        message: "This Operator Response has already been handled or is no longer awaiting accounting review.",
      });
    }

    const run = await ensureRun(businessId, month, req.user.id);
    const now = new Date().toISOString();
    const approval = await approveBookkeepingTransactions({
      businessId,
      items: [{
        transaction_id: requestRow.transaction_id,
        final_qbo_account_id: targetAccount.id,
        final_qbo_account_name: targetAccount.name,
        reason: req.body?.reason || "Approved from monthly Operator Response review.",
      }],
      actor: "monthly_review_operator_response",
      reason: req.body?.reason || "Approved from monthly Operator Response review.",
      requireNeedsReview: true,
      allowCcPaymentRejection: false,
      extraMetaByTransactionId: {
        [requestRow.transaction_id]: {
          operator_response_request_id: requestId,
          operator_response_answered_at: requestRow.answered_at || null,
          operator_response_approved_at: now,
          operator_response_approved_by: req.user?.id || null,
        },
      },
      db: supabase,
    });
    const updated = approval.rows?.find((row) => String(row.transaction_id) === String(requestRow.transaction_id)) || approval.rows?.[0] || null;

    const { error: resolveErr } = await supabase
      .from("clarification_requests")
      .update({
        resolved_at: now,
        resolved_by_user_id: req.user?.id || null,
        resolved_reason: "monthly_review_approved",
        resolved_transaction_status: "approved",
        resolved_final_qbo_account_id: targetAccount.id,
        resolved_final_qbo_account_name: targetAccount.name,
        updated_at: now,
      })
      .eq("business_id", businessId)
      .eq("id", requestId);
    if (resolveErr) throw resolveErr;

    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "operator_response_resolved",
    });

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "operator_response_approved",
      sectionKey: "operator_responses",
      previousValue: {
        request_id: requestId,
        transaction_id: requestRow.transaction_id,
        answer_text: requestRow.answer_text || null,
      },
      nextValue: {
        transaction_id: requestRow.transaction_id,
        final_qbo_account_id: targetAccount.id,
        final_qbo_account_name: targetAccount.name,
        status: "approved",
      },
      notes: "Approved customer Operator Response during monthly review.",
    }).catch(() => null);

    const qboLifecycleStatus = deriveQboPostingLifecycle(updated || {});
    const pipelineStatus = derivePipelineStatus({
      bank: bankTxn,
      cat: updated || {},
    });

    return res.json({
      ok: true,
      request_id: requestId,
      transaction_id: requestRow.transaction_id,
      categorization: updated,
      target_account: targetAccount,
      bookkeeping_status: updated?.status || "approved",
      qbo_lifecycle_status: qboLifecycleStatus,
      qbo_sync_status: qboLifecycleStatus,
      pipeline_status: pipelineStatus,
      pending: bankTxn.pending === true,
    });
  } catch (e) {
    if (e instanceof BookkeepingApprovalError) {
      return res.status(e.status || 400).json({ ok: false, error: e.error, ...e.details });
    }
    console.error("[monthly-review] operator response approval failed", e?.message || e);
    return res.status(500).json({ ok: false, error: "operator_response_approval_failed", message: e?.message || "Could not approve Operator Response." });
  }
});

router.post("/runs/:runId/lock", async (req, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    const run = await fetchRun(runId);
    const now = Date.now();
    const expiresAt = new Date(now + 5 * 60 * 1000).toISOString();
    const existingExpires = run.active_editor_expires_at ? Date.parse(run.active_editor_expires_at) : 0;
    const lockedByOther = run.active_editor_user_id
      && run.active_editor_user_id !== req.user.id
      && existingExpires > now;

    if (lockedByOther) {
      return res.status(409).json({
        ok: false,
        error: "review_locked_by_other_admin",
        lock: describeActiveLock(run),
        message: `${run.active_editor_email || "Another reviewer"} is currently editing this review.`,
      });
    }

    const { data: updatedRun, error } = await supabase
      .from("monthly_review_runs")
      .update({
        active_editor_user_id: req.user.id,
        active_editor_email: req.user.email || null,
        active_editor_started_at: run.active_editor_user_id === req.user.id ? run.active_editor_started_at || new Date(now).toISOString() : new Date(now).toISOString(),
        active_editor_expires_at: expiresAt,
        updated_at: new Date(now).toISOString(),
      })
      .eq("id", runId)
      .select("*")
      .single();
    if (error) throw error;

    res.json({ ok: true, lock: describeActiveLock(updatedRun) });
  } catch (e) {
    console.error("[monthly-review] lock failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_lock_failed", message: e?.message || "Could not lock review." });
  }
});

router.patch("/runs/:runId/sections/:sectionKey", async (req, res) => {
  try {
    const { runId, sectionKey } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    if (!SECTION_DEFS.some((section) => section.key === sectionKey)) {
      return res.status(400).json({ ok: false, error: "invalid_section_key" });
    }

    const status = String(req.body?.status || "").trim();
    if (!["pending", "in_review", "reviewed", "blocked", "not_applicable"].includes(status)) {
      return res.status(400).json({ ok: false, error: "invalid_status" });
    }
    const notes = req.body?.notes ?? null;
    if (status === "blocked" && !String(notes || "").trim()) {
      return res.status(400).json({
        ok: false,
        error: "blocked_section_notes_required",
        message: "Blocked sections require reviewer notes.",
      });
    }

    const run = await fetchRun(runId);
    const previousSection = await fetchSection(runId, sectionKey);
    const summaries = await buildSummaries(run.business_id, run.review_month);
    const sectionEvidence = summaries[sectionKey] || {};

    const patch = {
      status,
      notes,
      evidence_snapshot: sectionEvidence,
      evidence_hash: hashEvidence(sectionEvidence),
      updated_at: new Date().toISOString(),
    };
    if (status === "reviewed" || status === "not_applicable") {
      patch.reviewed_by = req.user.id;
      patch.reviewed_at = new Date().toISOString();
    } else {
      patch.reviewed_by = null;
      patch.reviewed_at = null;
    }

    const { data, error } = await supabase
      .from("monthly_review_sections")
      .update(patch)
      .eq("run_id", runId)
      .eq("section_key", sectionKey)
      .select("*")
      .single();
    if (error) throw error;

    await syncRunStatus(runId, summaries);
    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "section_updated",
      sectionKey,
      previousValue: pickSectionAudit(previousSection),
      nextValue: pickSectionAudit(data),
      notes,
    });
    res.json({ ok: true, section: data });
  } catch (e) {
    console.error("[monthly-review] update section failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_update_section_failed", message: e?.message || "Could not update section." });
  }
});

router.post("/runs/:runId/pull-pnl", async (req, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });

    const run = await fetchRun(runId);
    const [year, monthNumber] = String(run.review_month).slice(0, 7).split("-").map(Number);
    if (!year || !monthNumber) {
      return res.status(400).json({ ok: false, error: "invalid_review_month" });
    }

    const now = new Date().toISOString();
    const qboSync = await runQboSync({ businessId: run.business_id, year, month: monthNumber });
    const pdf = await ensurePnLPdf({
      business_id: run.business_id,
      year,
      month: monthNumber,
      forceRefresh: true,
    });

    const { data: report, error: reportErr } = await supabase
      .from("report_metadata")
      .update({
        monthly_review_published_at: now,
        monthly_review_published_by: req.user.id,
        monthly_review_run_id: run.id,
        monthly_review_source: "monthly_review_admin_pull",
      })
      .eq("business_id", run.business_id)
      .eq("year", year)
      .eq("month", monthNumber)
      .select("*")
      .maybeSingle();
    if (reportErr) throw reportErr;

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "pnl_report_pulled",
      sectionKey: "pnl_source",
      nextValue: {
        year,
        month: monthNumber,
        qbo_sync: qboSync,
        pdf: {
          storage_path: pdf?.storage_path || null,
          source: pdf?.source || null,
        },
        report_metadata_id: report?.id || null,
        published_at: now,
      },
      notes: "Pulled fresh QuickBooks P&L and published it to the customer Reports archive.",
    });

    const summaries = await buildSummaries(run.business_id, run.review_month);
    await syncRunStatus(run.id, summaries);

    res.json({ ok: true, report, qbo_sync: qboSync, pdf });
  } catch (e) {
    console.error("[monthly-review] pull pnl failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_pull_pnl_failed", message: e?.message || "Could not pull the P&L report." });
  }
});

router.post("/runs/:runId/finalize", async (req, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });

    const { data: run, error: runErr } = await supabase
      .from("monthly_review_runs")
      .select("*")
      .eq("id", runId)
      .single();
    if (runErr) throw runErr;

    const sections = await fetchSections(runId);
    const summaries = await buildSummaries(run.business_id, run.review_month);
    const sourceLedger = await buildMonthlySourceLedger(run.business_id, run.review_month);
    const operatorResponses = await fetchOperatorResponsesAwaitingReview(run.business_id, run.review_month);
    const canonicalCoa = await buildCanonicalCoaEvidence(run.business_id, run.review_month);
    const finalizationGuard = buildAccountingCloseFinalizationGuard({
      sourceLedger,
      operatorResponses,
      canonicalCoa,
      reconciliationEvidence: summaries.reconciliations,
    });
    if (!finalizationGuard.can_finalize) {
      return res.status(409).json({
        ok: false,
        error: "accounting_close_not_ready_for_finalization",
        message: summarizeAccountingCloseBlockers(finalizationGuard),
        finalization_guard: finalizationGuard,
      });
    }
    const [reportYear, reportMonth] = String(run.review_month).slice(0, 7).split("-").map(Number);
    const { data: publishedReport, error: publishedReportErr } = await supabase
      .from("report_metadata")
      .select("id,monthly_review_published_at,storage_path")
      .eq("business_id", run.business_id)
      .eq("year", reportYear)
      .eq("month", reportMonth)
      .not("monthly_review_published_at", "is", null)
      .maybeSingle();
    if (publishedReportErr) throw publishedReportErr;
    if (!publishedReport?.monthly_review_published_at || !publishedReport?.storage_path) {
      return res.status(409).json({
        ok: false,
        error: "pnl_not_published_for_finalization",
        message: "Pull and publish the monthly P&L from QuickBooks before finalizing.",
      });
    }
    const readiness = computeReadiness(sections, summaries);
    const currentEvidence = buildCurrentReviewEvidence(summaries, sourceLedger);
    const evidenceHash = hashEvidence(currentEvidence);
    await persistSectionEvidenceSnapshots(run.id, summaries);

    const finalSnapshot = await refreshMonthlyQboFinancialSnapshot({
      businessId: run.business_id,
      year: reportYear,
      month: reportMonth,
      source: "monthly_admin_review_close",
    });
    const approvedSnapshotId = finalSnapshot?.snapshot?.id || null;
    if (!approvedSnapshotId) {
      return res.status(409).json({
        ok: false,
        error: "monthly_review_final_snapshot_missing",
        message: "Could not verify the final Cash QuickBooks snapshot for this close.",
      });
    }

    const pendingTransactionCount = countSourceLedgerPendingTransactions(sourceLedger);
    const notes = req.body?.notes ?? run.notes ?? null;
    const { data: closeResult, error: closeErr } = await supabase.rpc("finalize_monthly_admin_review_close", {
      p_run_id: run.id,
      p_business_id: run.business_id,
      p_review_month: run.review_month,
      p_actor_user_id: req.user.id,
      p_actor_email: req.user.email || null,
      p_notes: notes,
      p_snapshot_id: approvedSnapshotId,
      p_pending_transaction_count: pendingTransactionCount,
      p_readiness_evidence: {
        guard: finalizationGuard,
        readiness,
        pending_transaction_count_at_close: pendingTransactionCount,
        published_report_id: publishedReport.id,
        source_snapshot_id: approvedSnapshotId,
      },
      p_evidence_snapshot: currentEvidence,
      p_evidence_hash: evidenceHash,
      p_readiness_score: readiness.score,
    });
    if (closeErr) throw closeErr;

    const [updatedRun, stamp, closeAuthority] = await Promise.all([
      fetchRun(run.id),
      fetchStamp(run.business_id, run.review_month),
      fetchActiveCloseAuthority(run.business_id, run.review_month),
    ]);

    ensureForecastV1Run({ businessId: run.business_id, createdBy: req.user.id }).catch((err) => {
      console.warn("[monthly-review] post-close forecast ensure skipped", err?.message || err);
    });

    res.json({ ok: true, run: updatedRun, stamp, accounting_period_close: closeAuthority, close_result: closeResult });
  } catch (e) {
    console.error("[monthly-review] finalize failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_finalize_failed", message: e?.message || "Could not finalize review." });
  }
});

router.post("/runs/:runId/reopen", async (req, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    const run = await fetchRun(runId);
    const now = new Date().toISOString();

    const { data: updatedRun, error } = await supabase
      .from("monthly_review_runs")
      .update({
        status: "reopened",
        finalized_at: null,
        finalized_by: null,
        updated_at: now,
      })
      .eq("id", runId)
      .select("*")
      .single();
    if (error) throw error;

    await supabase
      .from("financial_monthly_review_stamps")
      .delete()
      .eq("business_id", run.business_id)
      .eq("review_month", run.review_month);

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "reopened",
      previousValue: { status: run.status, finalized_at: run.finalized_at },
      nextValue: { status: "reopened" },
      notes: req.body?.notes || "Month reopened for additional review.",
    });

    res.json({ ok: true, run: updatedRun });
  } catch (e) {
    console.error("[monthly-review] reopen failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_reopen_failed", message: e?.message || "Could not reopen review." });
  }
});

router.patch("/runs/:runId/assignment", async (req, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    const run = await fetchRun(runId);
    const assignedEmail = String(req.body?.assigned_reviewer_email || "").trim() || null;
    const assignedReviewer = assignedEmail ? await resolveInternalReviewer(assignedEmail) : null;
    if (assignedEmail && !assignedReviewer) {
      return res.status(400).json({
        ok: false,
        error: "assigned_reviewer_must_be_internal_admin",
        message: "Assigned reviewers must be Bizzi internal admin users.",
      });
    }
    const assignedId = assignedReviewer?.id || (UUID_RE.test(String(req.body?.assigned_reviewer_id || "")) ? req.body.assigned_reviewer_id : null);
    const assignmentNotes = req.body?.assignment_notes ?? null;

    const { data: updatedRun, error } = await supabase
      .from("monthly_review_runs")
      .update({
        assigned_reviewer_id: assignedId,
        assigned_reviewer_email: assignedEmail,
        assignment_notes: assignmentNotes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .select("*")
      .single();
    if (error) throw error;

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "assigned",
      previousValue: { assigned_reviewer_email: run.assigned_reviewer_email, assignment_notes: run.assignment_notes },
      nextValue: { assigned_reviewer_email: assignedEmail, assignment_notes: assignmentNotes },
      notes: assignmentNotes,
    });

    res.json({ ok: true, run: updatedRun });
  } catch (e) {
    console.error("[monthly-review] assignment failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_assignment_failed", message: e?.message || "Could not assign reviewer." });
  }
});

router.patch("/runs/:runId/transactions/:transactionId/account", async (req, res) => {
  try {
    const { runId, transactionId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

    const run = await fetchRun(runId);
    await assertRunTransactionInSelectedMonth(run, transactionId);
    const accountId = String(req.body?.final_qbo_account_id || req.body?.account_id || "").trim() || null;
    if (!accountId) {
      return res.status(400).json({
        ok: false,
        error: "missing_account",
        message: "Choose a GL account before saving this adjustment.",
      });
    }

    const result = await reclassifyBookkeepingTransaction({
      businessId: run.business_id,
      transactionId,
      targetQboAccountId: accountId,
      actor: req.user?.id || req.user?.email || "internal_admin",
      source: "monthly_review",
      reason: req.body?.reason || "Adjusted GL account during monthly human review.",
    });

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "source_transaction_account_adjusted",
      sectionKey: "books",
      previousValue: {
        transaction_id: transactionId,
        final_qbo_account_id: result.previous?.final_qbo_account_id || null,
        final_qbo_account_name: result.previous?.final_qbo_account_name || null,
        status: result.previous?.status || null,
        qbo_txn_id: result.previous?.qbo_txn_id || null,
        qbo_txn_type: result.previous?.qbo_txn_type || null,
      },
      nextValue: {
        transaction_id: transactionId,
        mode: result.mode,
        final_qbo_account_id: result.target_account?.id || null,
        final_qbo_account_name: result.target_account?.name || null,
        qbo_update: result.qbo_update || null,
      },
      notes: req.body?.reason || `Moved transaction to ${result.target_account?.name || "selected account"}.`,
    });

    const summaries = await buildSummaries(run.business_id, run.review_month);
    await syncRunStatus(runId, summaries);
    res.json({
      ok: true,
      transaction_id: transactionId,
      mode: result.mode,
      categorization: result.categorization,
      target_account: result.target_account,
      qbo_update: result.qbo_update,
      posting_summary: result.posting_summary || null,
    });
  } catch (e) {
    console.error("[monthly-review] account adjustment failed", {
      error: e?.message || e,
      diagnostic_code: e?.details?.diagnostic_code || null,
      qbo_provider_error: e?.details?.qbo_provider_error || null,
      qbo_update_diagnostic: e?.details?.qbo_update_diagnostic || null,
    });
    const status = e instanceof BookkeepingReclassificationError ? e.status || 400 : e?.status || 500;
    res.status(status).json({
      ok: false,
      error: e instanceof BookkeepingReclassificationError ? e.error : e?.code || "monthly_review_account_adjustment_failed",
      message: e?.message || "Could not update transaction account.",
      details: e instanceof BookkeepingReclassificationError ? e.details || {} : undefined,
    });
  }
});

router.post("/runs/:runId/transactions/:transactionId/approve", async (req, res) => {
  try {
    const { runId, transactionId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

    const run = await fetchRun(runId);
    await assertRunTransactionInSelectedMonth(run, transactionId);

    const accountId = String(req.body?.final_qbo_account_id || req.body?.account_id || "").trim();
    if (!accountId) {
      return res.status(400).json({
        ok: false,
        error: "missing_account",
        message: "Choose a GL account before approving this transaction.",
      });
    }

    const result = await reclassifyBookkeepingTransaction({
      businessId: run.business_id,
      transactionId,
      targetQboAccountId: accountId,
      actor: req.user?.id || req.user?.email || "internal_admin",
      source: "monthly_review",
      reason: req.body?.reason || "Approved from Monthly Review Needs Review feed.",
    });
    if (result.mode !== "needs_review_approval") {
      return res.status(409).json({
        ok: false,
        error: "transaction_not_needs_review",
        message: "This transaction is no longer in Needs Review.",
        mode: result.mode,
      });
    }

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "bookkeeping_feed_transaction_approved",
      sectionKey: "books_review_mirror",
      previousValue: {
        transaction_id: transactionId,
        final_qbo_account_id: result.previous?.final_qbo_account_id || null,
        final_qbo_account_name: result.previous?.final_qbo_account_name || null,
        status: result.previous?.status || null,
      },
      nextValue: {
        transaction_id: transactionId,
        final_qbo_account_id: result.target_account?.id || null,
        final_qbo_account_name: result.target_account?.name || null,
        status: result.categorization?.status || "approved",
        operator_response_resolution: result.operator_response_resolution || null,
      },
      notes: req.body?.reason || "Approved selected-month Needs Review transaction from Monthly Review.",
    }).catch(() => null);

    const summaries = await buildSummaries(run.business_id, run.review_month);
    await syncRunStatus(runId, summaries);
    res.json({
      ok: true,
      transaction_id: transactionId,
      mode: result.mode,
      categorization: result.categorization,
      target_account: result.target_account,
      operator_response_resolution: result.operator_response_resolution || null,
    });
  } catch (e) {
    console.error("[monthly-review] feed approval failed", e?.message || e);
    const status = e instanceof BookkeepingReclassificationError ? e.status || 400 : e?.status || 500;
    res.status(status).json({
      ok: false,
      error: e instanceof BookkeepingReclassificationError ? e.error : e?.code || "monthly_review_feed_approval_failed",
      message: e?.message || "Could not approve transaction.",
      details: e instanceof BookkeepingReclassificationError ? e.details || {} : undefined,
    });
  }
});

router.post("/runs/:runId/transactions/:transactionId/post-qbo", async (req, res) => {
  try {
    const { runId, transactionId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

    const run = await fetchRun(runId);
    await assertRunTransactionInSelectedMonth(run, transactionId);

    const { data: current, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,qbo_txn_id,post_after,post_error")
      .eq("business_id", run.business_id)
      .eq("transaction_id", transactionId)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!current) return res.status(409).json({ ok: false, error: "transaction_not_categorized" });
    if (current.qbo_txn_id || String(current.status || "").toLowerCase() === "posted") {
      return res.status(409).json({ ok: false, error: "transaction_already_posted", message: "This transaction is already posted in QuickBooks." });
    }
    if (!matchesTransactionStatusFilter("handled", current)) {
      return res.status(409).json({ ok: false, error: "transaction_not_handled", message: "Only handled transactions can be manually posted to QuickBooks." });
    }

    const confirmPostAnyway =
      req.body?.confirm_post_anyway === true ||
      req.body?.post_anyway === true ||
      req.body?.confirmPostAnyway === true;
    const result = await postSingleBookkeepingTransactionNow({
      businessId: run.business_id,
      transactionId,
      confirmPostAnyway,
    });
    if (result?.ok === false) {
      return res.status(result?.status || 409).json({
        ok: false,
        error: result?.error || "monthly_review_manual_post_failed",
        message: result?.message || result?.error || "QuickBooks posting did not complete.",
        result,
      });
    }

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "bookkeeping_feed_transaction_posted",
      sectionKey: "books_review_mirror",
      previousValue: {
        transaction_id: transactionId,
        status: current.status || null,
        post_after: current.post_after || null,
        post_error: current.post_error || null,
      },
      nextValue: {
        transaction_id: transactionId,
        posting_result: result,
      },
      notes: "Manually pushed selected-month handled transaction to QuickBooks from Monthly Review.",
    }).catch(() => null);

    const summaries = await buildSummaries(run.business_id, run.review_month);
    await syncRunStatus(runId, summaries);
    res.json({ ok: true, transaction_id: transactionId, posting_result: result });
  } catch (e) {
    console.error("[monthly-review] manual post failed", e?.message || e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || e?.message || "monthly_review_manual_post_failed",
      message: e?.message || "Could not post transaction to QuickBooks.",
    });
  }
});

router.post("/runs/:runId/transactions/:transactionId/retry-qbo-sync", async (req, res) => {
  try {
    const { runId, transactionId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

    const run = await fetchRun(runId);
    await assertRunTransactionInSelectedMonth(run, transactionId);
    const { data: bankTxn, error: bankErr } = await supabase
      .from("bank_transactions")
      .select("id,date,name,merchant_name,counterparty_name,amount,plaid_transaction_id")
      .eq("business_id", run.business_id)
      .eq("id", transactionId)
      .maybeSingle();
    if (bankErr) throw bankErr;
    if (!bankTxn) return res.status(404).json({ ok: false, error: "transaction_not_found" });
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, run.business_id);
    if (!isTransactionInActiveBookkeepingScope(bankTxn, bookkeepingStartDate)) {
      return res.status(400).json({
        ok: false,
        error: "transaction_before_bookkeeping_start_date",
        bookkeeping_start_date: bookkeepingStartDate,
      });
    }

    const { data: current, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,final_qbo_account_id,final_qbo_account_name,suggested_qbo_account_id,suggested_qbo_account_name,qbo_txn_id,qbo_txn_type,post_after,post_error,meta")
      .eq("business_id", run.business_id)
      .eq("transaction_id", transactionId)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!current) {
      return res.status(409).json({
        ok: false,
        error: "transaction_not_categorized",
        message: "Choose a GL account before retrying QBO sync.",
      });
    }

    const accountId = current.final_qbo_account_id || current.suggested_qbo_account_id || null;
    const accountName = current.final_qbo_account_name || current.suggested_qbo_account_name || null;
    if (!accountId || !accountName) {
      return res.status(409).json({
        ok: false,
        error: "missing_account_for_qbo_retry",
        message: "Choose a GL account before retrying QBO sync.",
      });
    }

    const now = new Date().toISOString();
    let qboUpdate = null;
    let postingSummary = null;

    if (current.qbo_txn_id) {
      qboUpdate = await updatePostedQboTransactionAccount({
        businessId: run.business_id,
        qboTxnId: current.qbo_txn_id,
        qboTxnType: current.qbo_txn_type,
        accountId,
        accountName,
      });
      const { error } = await supabase
        .from("transaction_categorizations")
        .update({
          status: "posted",
          post_error: null,
          meta: {
            ...(current.meta || {}),
            monthly_review_retry_at: now,
            monthly_review_qbo_update: qboUpdate,
          },
          updated_at: now,
        })
        .eq("business_id", run.business_id)
        .eq("transaction_id", transactionId);
      if (error) throw error;
    } else {
      postingSummary = await postSingleBookkeepingTransactionNow({
        businessId: run.business_id,
        transactionId,
      });
      if (postingSummary?.ok === false) {
        const err = new Error(postingSummary?.error || "qbo_retry_posting_failed");
        err.status = postingSummary?.status || 400;
        throw err;
      }
    }

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "source_transaction_qbo_retry",
      sectionKey: "books",
      previousValue: {
        transaction_id: transactionId,
        status: current.status,
        post_error: current.post_error || null,
        qbo_txn_id: current.qbo_txn_id || null,
      },
      nextValue: {
        transaction_id: transactionId,
        qbo_update: qboUpdate,
        posting_summary: postingSummary,
      },
      notes: current.qbo_txn_id ? "Retried QBO update for posted transaction." : "Retried QBO posting for unposted transaction.",
    });

    const summaries = await buildSummaries(run.business_id, run.review_month);
    await syncRunStatus(runId, summaries);
    res.json({ ok: true, transaction_id: transactionId, qbo_update: qboUpdate, posting_summary: postingSummary });
  } catch (e) {
    console.error("[monthly-review] retry qbo sync failed", e?.message || e);
    res.status(e?.status || 500).json({ ok: false, error: e?.code || "monthly_review_retry_qbo_sync_failed", message: e?.message || "Could not retry QBO sync." });
  }
});

router.get("/runs/:runId/transactions/:transactionId/history", async (req, res) => {
  try {
    const { runId, transactionId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    const events = await fetchAuditEvents(runId, 300);
    const rows = events.filter((event) => {
      const prevId = event.previous_value?.transaction_id;
      const nextId = event.next_value?.transaction_id;
      return String(prevId || "") === String(transactionId) || String(nextId || "") === String(transactionId);
    });
    res.json({ ok: true, transaction_id: transactionId, history: rows });
  } catch (e) {
    console.error("[monthly-review] transaction history failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_transaction_history_failed", message: e?.message || "Could not load transaction history." });
  }
});

router.post("/runs/:runId/reminders", async (req, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    const run = await fetchRun(runId);
    const message = String(req.body?.message || "").trim() || "Monthly review reminder.";
    const dueAt = req.body?.due_at || null;

    const { data: reminder, error } = await supabase
      .from("monthly_review_reminders")
      .insert({
        run_id: runId,
        business_id: run.business_id,
        review_month: run.review_month,
        message,
        assigned_reviewer_email: run.assigned_reviewer_email || null,
        due_at: dueAt,
        created_by: req.user.id,
      })
      .select("*")
      .single();
    if (error) throw error;

    await supabase
      .from("monthly_review_runs")
      .update({ last_reminder_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", runId);

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "reminder_created",
      nextValue: reminder,
      notes: message,
    });

    res.json({ ok: true, reminder });
  } catch (e) {
    console.error("[monthly-review] reminder failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_reminder_failed", message: e?.message || "Could not create reminder." });
  }
});

router.post("/bulk/ensure", async (req, res) => {
  try {
    const month = normalizeMonth(req.body?.month || req.query.month);
    const { data: businesses, error } = await supabase
      .from("business_profiles")
      .select("id");
    if (error) throw error;

    let created = 0;
    for (const business of businesses || []) {
      const run = await ensureRun(business.id, month, req.user.id);
      await ensureSections(run.id);
      created += 1;
    }

    await logAuditEvent({
      run: { business_id: null, review_month: month, id: null },
      actor: req.user,
      eventType: "bulk_queue_prepared",
      nextValue: { month, count: created },
      notes: `Prepared ${created} monthly review runs.`,
    });

    res.json({ ok: true, month, count: created });
  } catch (e) {
    console.error("[monthly-review] bulk ensure failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_bulk_ensure_failed", message: e?.message || "Could not prepare queue." });
  }
});

router.get("/runs/:runId/export", async (req, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    const run = await fetchRun(runId);
    const { data: business } = await supabase
      .from("business_profiles")
      .select("id,business_name,industry")
      .eq("id", run.business_id)
      .maybeSingle();
    const sections = await fetchSections(runId);
    const summaries = await buildSummaries(run.business_id, run.review_month);
    const auditEvents = await fetchAuditEvents(runId);
    const reminders = await fetchReminders(runId);
    const readiness = computeReadiness(sections, summaries);
    const sourceLedger = await buildMonthlySourceLedger(run.business_id, run.review_month);
    const packet = {
      exported_at: new Date().toISOString(),
      business,
      run,
      readiness,
      source_ledger: sourceLedger,
      sections: sections.map((section) => ({
        ...section,
        definition: SECTION_DEFS.find((def) => def.key === section.section_key),
        current_evidence: summaries[section.section_key] || null,
      })),
      audit_events: auditEvents,
      reminders,
      changed_since_finalized: run.evidence_hash && run.evidence_hash !== hashEvidence(summaries)
        ? buildEvidenceChanges(run.evidence_snapshot || {}, summaries)
        : [],
    };

    res.json({ ok: true, packet, html: buildReviewPacketHtml(packet) });
  } catch (e) {
    console.error("[monthly-review] export failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_export_failed", message: e?.message || "Could not export review packet." });
  }
});

function normalizeMonth(value) {
  const raw = String(value || "").trim();
  if (raw) {
    const normalized = normalizeMonthInput(raw);
    if (normalized) return normalized.startDate;
    const err = new Error("invalid_month");
    err.status = 400;
    err.error = "invalid_month";
    throw err;
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function parseReviewYearMonth(yearValue, monthValue) {
  const maybeMonthString = String(monthValue || yearValue || "").trim();
  const match = maybeMonthString.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  const year = match ? Number(match[1]) : Number(yearValue);
  const month = match ? Number(match[2]) : Number(monthValue);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    const err = new Error("invalid_review_year");
    err.status = 400;
    err.error = "invalid_review_year";
    throw err;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    const err = new Error("invalid_review_month");
    err.status = 400;
    err.error = "invalid_review_month";
    throw err;
  }
  return { year, month };
}

async function assertMonthlyReviewBusinessExists(businessId) {
  const { data: business, error } = await supabase
    .from("business_profiles")
    .select("id")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw error;
  if (!business) {
    const err = new Error("business_not_found");
    err.status = 404;
    err.error = "business_not_found";
    throw err;
  }
  return business;
}

async function assertMonthlyReviewPeriodAvailable(businessId, month) {
  const monthKey = String(month || "").slice(0, 7);
  const periods = await getAvailableMonthlyReviewPeriods({ businessId, db: supabase });
  if (periods.some((period) => String(period.month || period.value || "").slice(0, 7) === monthKey)) {
    return true;
  }
  const err = new Error("monthly review period is not available for this business");
  err.status = 404;
  err.error = "monthly_review_period_not_available";
  throw err;
}

async function fetchRunMap(businessIds, month) {
  const { data, error } = await supabase
    .from("monthly_review_runs")
    .select("id,business_id,status,finalized_at,assigned_reviewer_email,readiness_score,last_reminder_at,monthly_review_sections(status)")
    .in("business_id", businessIds)
    .eq("review_month", month);
  if (error) throw error;
  return new Map((data || []).map((run) => [
    run.business_id,
    {
      ...run,
      reviewed_sections: (run.monthly_review_sections || []).filter((section) => ["reviewed", "not_applicable"].includes(section.status)).length,
      blocked_sections: (run.monthly_review_sections || []).filter((section) => section.status === "blocked").length,
    },
  ]));
}

async function fetchStampMap(businessIds, month) {
  const { data, error } = await supabase
    .from("financial_monthly_review_stamps")
    .select("business_id,completed_at")
    .in("business_id", businessIds)
    .eq("review_month", month);
  if (error) throw error;
  return new Map((data || []).map((stamp) => [stamp.business_id, stamp]));
}

async function fetchStamp(businessId, month) {
  const { data, error } = await supabase
    .from("financial_monthly_review_stamps")
    .select("*")
    .eq("business_id", businessId)
    .eq("review_month", month)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function fetchActiveCloseAuthority(businessId, month) {
  const { data, error } = await supabase
    .from("accounting_period_closes")
    .select("*")
    .eq("business_id", businessId)
    .eq("period_month", month)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function countSourceLedgerPendingTransactions(sourceLedger = {}) {
  const ids = new Set();
  for (const group of sourceLedger.account_groups || []) {
    for (const txn of group.transactions || []) {
      if (txn?.pending === true) ids.add(String(txn.id || txn.transaction_id || `${txn.date}:${txn.amount}:${txn.description}`));
    }
  }
  for (const txn of sourceLedger.reconciliation_trace || []) {
    if (txn?.pending === true) ids.add(String(txn.transaction_id || txn.id || `${txn.plaid_date}:${txn.amount}:${txn.description}`));
  }
  return ids.size;
}

async function fetchMonthlyPnlReport(businessId, month) {
  const [year, monthNumber] = String(month).slice(0, 7).split("-").map(Number);
  if (!year || !monthNumber) return null;
  const { data, error } = await supabase
    .from("report_metadata")
    .select("id,year,month,storage_path,monthly_review_published_at,monthly_review_published_by,monthly_review_source,generated_at,revenue,net_profit")
    .eq("business_id", businessId)
    .eq("year", year)
    .eq("month", monthNumber)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function ensureRun(businessId, month, userId) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("monthly_review_runs")
    .upsert({
      business_id: businessId,
      review_month: month,
      reviewed_by: userId,
      updated_at: now,
    }, { onConflict: "business_id,review_month", ignoreDuplicates: false })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function ensureSections(runId) {
  const rows = SECTION_DEFS.map((section) => ({
    run_id: runId,
    section_key: section.key,
  }));
  const { error } = await supabase
    .from("monthly_review_sections")
    .upsert(rows, { onConflict: "run_id,section_key", ignoreDuplicates: true });
  if (error) throw error;
  return fetchSections(runId);
}

async function fetchSections(runId) {
  const activeSectionKeys = new Set(SECTION_DEFS.map((section) => section.key));
  const { data, error } = await supabase
    .from("monthly_review_sections")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).filter((section) => activeSectionKeys.has(section.section_key));
}

async function fetchSection(runId, sectionKey) {
  const { data, error } = await supabase
    .from("monthly_review_sections")
    .select("*")
    .eq("run_id", runId)
    .eq("section_key", sectionKey)
    .single();
  if (error) throw error;
  return data;
}

async function fetchRun(runId) {
  const { data, error } = await supabase
    .from("monthly_review_runs")
    .select("*")
    .eq("id", runId)
    .single();
  if (error) throw error;
  return data;
}

async function fetchAuditEvents(runId, limit = 80) {
  return safeRows(() =>
    supabase
      .from("monthly_review_audit_events")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: false })
      .limit(limit)
  );
}

async function fetchReminders(runId) {
  return safeRows(() =>
    supabase
      .from("monthly_review_reminders")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: false })
      .limit(20)
  );
}

async function logAuditEvent({
  run,
  actor,
  eventType,
  sectionKey = null,
  previousValue = null,
  nextValue = null,
  notes = null,
}) {
  try {
    await supabase.from("monthly_review_audit_events").insert({
      run_id: run?.id || null,
      business_id: run?.business_id || null,
      review_month: run?.review_month || null,
      actor_user_id: actor?.id || null,
      actor_email: actor?.email || null,
      event_type: eventType,
      section_key: sectionKey,
      previous_value: previousValue,
      next_value: nextValue,
      notes,
    });
  } catch (e) {
    console.warn("[monthly-review] audit event skipped", e?.message || e);
  }
}

async function resolveInternalReviewer(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;

  const { data, error } = await supabase
    .from("user_profiles")
    .select("id,email")
    .ilike("email", normalizedEmail)
    .maybeSingle();
  if (error) throw error;

  const profileEmail = String(data?.email || normalizedEmail).toLowerCase();
  if (!data?.id) return null;

  const { data: staff, error: staffErr } = await supabase
    .from("internal_staff_users")
    .select("user_id,role,active")
    .eq("user_id", data.id)
    .maybeSingle();
  if (staffErr) throw staffErr;

  if (staff?.active && MONTHLY_REVIEW_STAFF_ROLES.includes(staff.role)) {
    return { id: data.id, email: profileEmail, role: staff.role };
  }
  return null;
}

function pickSectionAudit(section = {}) {
  return {
    status: section.status || null,
    notes: section.notes || null,
    reviewed_by: section.reviewed_by || null,
    reviewed_at: section.reviewed_at || null,
    evidence_hash: section.evidence_hash || null,
  };
}

async function persistSectionEvidenceSnapshots(runId, summaries) {
  for (const def of SECTION_DEFS) {
    const evidenceForSection = summaries[def.key] || {};
    await supabase
      .from("monthly_review_sections")
      .update({
        evidence_snapshot: evidenceForSection,
        evidence_hash: hashEvidence(evidenceForSection),
        updated_at: new Date().toISOString(),
      })
      .eq("run_id", runId)
      .eq("section_key", def.key);
  }
}

function computeReadiness(sections = [], summaries = {}) {
  const totalRequired = SECTION_DEFS.filter((def) => def.required).length || 1;
  const reviewedRequired = SECTION_DEFS
    .filter((def) => def.required)
    .filter((def) => {
      const section = sections.find((item) => item.section_key === def.key);
      return section && ["reviewed", "not_applicable"].includes(section.status);
    }).length;
  const blocked = sections.filter((section) => section.status === "blocked").length;
  const warningCount = Object.values(summaries || {}).reduce((sum, item) => sum + (Array.isArray(item?.warnings) ? item.warnings.length : 0), 0);
  const sectionScore = (reviewedRequired / totalRequired) * 70;
  const evidencePenalty = Math.min(25, warningCount * 4);
  const blockedPenalty = Math.min(25, blocked * 10);
  const score = Math.max(0, Math.min(100, Math.round(sectionScore + 30 - evidencePenalty - blockedPenalty)));
  return {
    score,
    reviewed_required: reviewedRequired,
    total_required: totalRequired,
    warning_count: warningCount,
    blocked_count: blocked,
    label: score >= 90 ? "Ready" : score >= 65 ? "Needs light review" : score >= 35 ? "In progress" : "Not ready",
  };
}

function buildEvidenceChanges(previous = {}, current = {}) {
  const sectionChanges = SECTION_DEFS
    .map((def) => {
      const prev = previous?.[def.key] || null;
      const next = current?.[def.key] || null;
      if (!prev && !next) return null;
      const prevHash = hashEvidence(prev || {});
      const nextHash = hashEvidence(next || {});
      if (prevHash === nextHash) return null;
      return {
        section_key: def.key,
        label: def.label,
        previous_value: prev?.value || null,
        current_value: next?.value || null,
        previous_warnings: prev?.warnings || [],
        current_warnings: next?.warnings || [],
      };
    })
    .filter(Boolean);
  const prevSource = previous?.source_ledger || null;
  const nextSource = current?.source_ledger || null;
  if (prevSource || nextSource) {
    const prevHash = hashEvidence(prevSource || {});
    const nextHash = hashEvidence(nextSource || {});
    if (prevHash !== nextHash) {
      sectionChanges.push({
        section_key: "source_ledger",
        label: "P&L Source Ledger",
        previous_value: prevSource?.detail || prevSource?.value || null,
        current_value: nextSource?.detail || nextSource?.value || null,
        previous_warnings: [],
        current_warnings: [],
      });
    }
  }
  return sectionChanges;
}

function hashEvidence(value) {
  return crypto.createHash("sha256").update(stableStringify(value || {})).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function syncRunStatus(runId, summaries = null) {
  const sections = await fetchSections(runId);
  const run = await fetchRun(runId);
  const currentSummaries = summaries || (run ? await buildSummaries(run.business_id, run.review_month) : {});
  const readiness = computeReadiness(sections, currentSummaries);
  const allRequiredDone = SECTION_DEFS
    .filter((def) => def.required)
    .every((def) => {
      const section = sections.find((item) => item.section_key === def.key);
      return section && ["reviewed", "not_applicable"].includes(section.status);
    });

  const { error } = await supabase
    .from("monthly_review_runs")
    .update({
      status: allRequiredDone ? "ready_to_finalize" : "in_progress",
      readiness_score: readiness.score,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .neq("status", "finalized");
  if (error) throw error;
}

async function buildSummaries(businessId, month) {
  const [reconciliations, tax, forecasting, jobs] = await Promise.all([
    buildReconciliationEvidence(businessId, month),
    buildTaxEvidence(businessId, month),
    buildForecastEvidence(businessId, month),
    buildJobCostingEvidence(businessId, month),
  ]);

  return {
    forecasting,
    tax_liability: tax,
    job_costing: jobs,
    reconciliations,
  };
}

async function buildCanonicalCoaEvidence(businessId, month) {
  const result = await fetchCanonicalAccountMappingsForBusiness({ businessId, month });
  const monthRequirements = await fetchSelectedMonthCanonicalRequirements(businessId, month);
  const monthActivityKeys = buildCanonicalMonthActivityKeys(result.history || []);
  const rows = result.rows || [];
  const history = result.history || [];
  const decisions = result.decisions || [];
  const rowsWithRequirement = rows.map((row) => {
    const requirement = monthRequirements.get(row.canonical_account_key) || null;
    return {
      ...row,
      selected_month_required: Boolean(requirement),
      selected_month_transaction_count: requirement?.transaction_ids?.length || 0,
      selected_month_transaction_ids: requirement?.transaction_ids || [],
      selected_month_examples: requirement?.examples || [],
      selected_month_requirement_reasons: requirement?.reasons || [],
    };
  });
  const requiredKeys = new Set(Array.from(monthRequirements.keys()));
  const created = rowsWithRequirement.filter((row) => row.status === "created_by_bizzi");
  const mapped = rowsWithRequirement.filter((row) => row.status === "existing_exact" || row.status === "existing_approved_equivalent");
  const review = rowsWithRequirement.filter((row) => row.status === "needs_review" && row.selected_month_required);
  const allReview = rowsWithRequirement.filter((row) => row.status === "needs_review");
  const relevantDecisions = decisions
    .filter((decision) => requiredKeys.has(decision.canonical_account_key))
    .map((decision) => {
      const requirement = monthRequirements.get(decision.canonical_account_key) || null;
      return {
        ...decision,
        selected_month_required: Boolean(requirement),
        selected_month_transaction_count: requirement?.transaction_ids?.length || 0,
        selected_month_transaction_ids: requirement?.transaction_ids || [],
        selected_month_examples: requirement?.examples || [],
      };
    });
  const thisMonthActivity = [...created, ...mapped]
    .filter((row) => monthActivityKeys.has(row.canonical_account_key) || isMonthTimestamp(row.mapped_at || row.created_at, month))
    .sort((a, b) => String(b.mapped_at || b.created_at || "").localeCompare(String(a.mapped_at || a.created_at || "")))
    .slice(0, 12);
  return {
    summary: {
      created_by_bizzi_count: created.length,
      mapped_existing_count: mapped.length,
      needs_review_count: review.length,
      all_needs_review_count: allReview.length,
      selected_month_required_count: review.length,
    },
    created_by_bizzi: created,
    mapped_existing: mapped,
    needs_review: review,
    all_needs_review: allReview,
    decisions: relevantDecisions,
    this_month_activity: thisMonthActivity,
    recent_history: history.slice(0, 25),
    source_contract: {
      source_tables: ["business_canonical_qbo_account_mappings", "bank_transactions", "transaction_categorizations"],
      state_basis: "needs_review canonical mappings only block close when unresolved selected-month active transactions still depend on that canonical key",
    },
  };
}

function buildCanonicalMonthActivityKeys(history = []) {
  const activityEvents = new Set(["existing_exact", "existing_approved_equivalent", "created_by_bizzi", "creation_intent", "mapped_existing"]);
  return new Set((history || [])
    .filter((event) => activityEvents.has(String(event.event_type || "")))
    .map((event) => event.canonical_account_key)
    .filter(Boolean));
}

function isMonthTimestamp(value, month) {
  if (!value || !month) return false;
  return String(value).slice(0, 7) === String(month).slice(0, 7);
}

async function fetchSelectedMonthCanonicalRequirements(businessId, month) {
  const [start, end] = monthBounds(month);
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const bankRows = await safeRows(() =>
    applyActiveBookkeepingScope(
      supabase
        .from("bank_transactions")
        .select("id,date,name,merchant_name,counterparty_name,is_archived")
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .gte("date", start)
        .lt("date", end),
      bookkeepingStartDate
    ),
    "Selected month canonical requirement transactions"
  );
  const txnIds = bankRows.map((row) => row.id).filter(Boolean);
  if (!txnIds.length) return new Map();
  const bankById = new Map(bankRows.map((row) => [String(row.id), row]));
  const catRows = await safeRows(() =>
    supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,final_qbo_account_id,final_qbo_account_name,final_canonical_account_key,qbo_txn_id,meta")
      .eq("business_id", businessId)
      .in("transaction_id", txnIds),
    "Selected month canonical requirement categorizations"
  );
  const requirements = new Map();
  for (const cat of catRows) {
    const bank = bankById.get(String(cat.transaction_id));
    if (!bank) continue;
    if (!selectedMonthTransactionStillRequiresCanonicalMapping(cat)) continue;
    const key = canonicalKeyFromCategorization(cat);
    if (!key) continue;
    if (!requirements.has(key)) {
      requirements.set(key, { canonical_account_key: key, transaction_ids: [], reasons: [], examples: [] });
    }
    const requirement = requirements.get(key);
    requirement.transaction_ids.push(cat.transaction_id);
    if (requirement.examples.length < 3) {
      requirement.examples.push({
        transaction_id: cat.transaction_id,
        date: bank.date || null,
        merchant: bank.counterparty_name || bank.merchant_name || bank.name || "Transaction",
      });
    }
    const reason = cat.meta?.canonical_mapping_review_required === true
      ? "canonical_mapping_review_required"
      : "unresolved_selected_month_canonical_account";
    if (!requirement.reasons.includes(reason)) requirement.reasons.push(reason);
  }
  return requirements;
}

async function buildCanonicalVendorEvidence(businessId, month) {
  const result = await fetchCanonicalVendorActivityForBusiness({ businessId, limit: 50 });
  const rows = result.rows || [];
  const needsAttention = rows
    .filter((row) => row.status === "needs_review")
    .slice(0, 25);
  const createdThisMonth = rows
    .filter((row) => row.status === "created_by_bizzi")
    .filter((row) => isMonthTimestamp(row.activity_at || row.created_at || row.mapped_at || row.updated_at, month))
    .sort((a, b) => String(b.activity_at || b.created_at || "").localeCompare(String(a.activity_at || a.created_at || "")))
    .slice(0, 12);
  const mappedExisting = rows
    .filter((row) => row.status === "mapped_existing")
    .filter((row) => isMonthTimestamp(row.activity_at || row.mapped_at || row.updated_at, month))
    .sort((a, b) => String(b.activity_at || b.mapped_at || "").localeCompare(String(a.activity_at || a.mapped_at || "")))
    .slice(0, 12);
  return {
    summary: {
      ...(result.summary || {}),
      needs_attention_count: needsAttention.length,
      created_this_month_count: createdThisMonth.length,
      mapped_existing_this_month_count: mappedExisting.length,
    },
    rows: rows.slice(0, 25),
    needs_review: needsAttention,
    needs_attention: needsAttention,
    created_this_month: createdThisMonth,
    mapped_existing: mappedExisting,
    recent_history: (result.recent_history || []).slice(0, 25),
    source_contract: {
      source_tables: ["bizzi_vendors", "business_qbo_vendor_mappings", "qbo_vendor_creation_intents", "vendor_aliases", "vendor_mapping_events"],
      state_basis: "routine created/mapped vendors are audit-only; only needs_review vendor rows represent accountant attention",
    },
  };
}

async function buildMonthlySourceLedger(businessId, month) {
  const [start, end] = monthBounds(month);
  const [prevStart, prevEnd] = previousMonthBounds(month);
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  // Monthly Review intentionally uses the same source records as Books Review:
  // active bank_transactions for the transaction date month plus their
  // transaction_categorizations rows. Do not switch this to report/P&L rows.
  const bankRows = await safeRows(() =>
    applyActiveBookkeepingScope(
      supabase
      .from("bank_transactions")
      .select("id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,counterparty_name,amount,signed_amount,direction,pending,is_archived")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .gte("date", start)
      .lt("date", end)
      .order("date", { ascending: true }),
      bookkeepingStartDate
    ),
    "Monthly source ledger transactions"
  );
  const authoritativePlaidRows = await loadSharedAuthoritativeMonthlyPlaidTransactions(businessId, start, end);
  const txnIds = bankRows.map((row) => row.id).filter(Boolean);
  const allTxnIds = Array.from(new Set([...txnIds, ...authoritativePlaidRows.map((row) => row.id).filter(Boolean)]));
  const catRows = allTxnIds.length
    ? await safeRows(() =>
        supabase
          .from("transaction_categorizations")
          .select("transaction_id,status,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,final_qbo_account_id,final_qbo_account_name,final_canonical_account_key,qbo_txn_id,qbo_txn_type,posted_at,post_after,confidence,reason,post_error,meta")
          .eq("business_id", businessId)
          .in("transaction_id", allTxnIds),
        "Monthly source ledger categorizations"
      )
    : [];
  const plaidAccountIds = Array.from(new Set([...bankRows, ...authoritativePlaidRows].map((row) => row.plaid_account_id).filter(Boolean)));
  const plaidAccountLabels = await loadPlaidAccountLabelsForMonthlyReview(businessId, plaidAccountIds);
  const reconciliationItemByTxn = await loadReconciliationItemsForMonthlyTrace(businessId, month, allTxnIds);
  const previousBankRows = await safeRows(() =>
    applyActiveBookkeepingScope(
      supabase
      .from("bank_transactions")
      .select("id,date,name,merchant_name,counterparty_name,amount,signed_amount,is_archived")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .gte("date", prevStart)
      .lt("date", prevEnd),
      bookkeepingStartDate
    ),
    "Previous month source ledger transactions"
  );
  const previousTxnIds = previousBankRows.map((row) => row.id).filter(Boolean);
  const previousCatRows = previousTxnIds.length
    ? await safeRows(() =>
        supabase
          .from("transaction_categorizations")
          .select("transaction_id,final_qbo_account_id,final_qbo_account_name,suggested_qbo_account_id,suggested_qbo_account_name")
          .eq("business_id", businessId)
          .in("transaction_id", previousTxnIds),
        "Previous month source ledger categorizations"
      )
    : [];
  const previousVendorSet = new Set(previousBankRows.map((row) => normalizeAccountName(row.counterparty_name || row.merchant_name || row.name || "")).filter(Boolean));
  const previousCatByTxn = new Map(previousCatRows.map((row) => [row.transaction_id, row]));
  const previousTotalsByGroup = new Map();
  for (const row of previousBankRows) {
    const cat = previousCatByTxn.get(row.id) || {};
    const accountId = cat.final_qbo_account_id || cat.suggested_qbo_account_id || null;
    const accountName = cat.final_qbo_account_name || cat.suggested_qbo_account_name || "Uncategorized";
    const key = accountId || `name:${normalizeAccountName(accountName) || "uncategorized"}`;
    previousTotalsByGroup.set(key, roundCurrency((previousTotalsByGroup.get(key) || 0) + Number(row.signed_amount ?? row.amount ?? 0)));
  }
  const catByTxn = new Map(catRows.map((row) => [row.transaction_id, row]));
  const chartAccounts = await loadChartAccountsForReview(businessId);
  const accountById = new Map(chartAccounts.map((account) => [String(account.id), account]));
  const accountByName = new Map(chartAccounts.map((account) => [normalizeAccountName(account.name), account]));
  const groups = new Map();
  const warnings = [];
  appendEvidenceQueryWarnings(warnings, bankRows, catRows, previousBankRows, previousCatRows);
  const totalAbsAmount = bankRows.reduce((sum, row) => sum + Math.abs(Number(row.signed_amount ?? row.amount ?? 0) || 0), 0);
  const materialityThreshold = Math.max(1000, totalAbsAmount * 0.1);

  for (const row of bankRows) {
    const cat = catByTxn.get(row.id) || {};
    const accountId = cat.final_qbo_account_id || cat.suggested_qbo_account_id || null;
    const accountName = cat.final_qbo_account_name || cat.suggested_qbo_account_name || "Uncategorized";
    const chartAccount = accountId ? accountById.get(String(accountId)) : accountByName.get(normalizeAccountName(accountName));
    const accountType = chartAccount?.accountType || chartAccount?.account_type || chartAccount?.type || inferAccountType(accountName);
    const key = accountId || `name:${normalizeAccountName(accountName) || "uncategorized"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        account_id: accountId,
        account_name: accountName,
        account_type: accountType || "Uncategorized",
        pnl_order: pnlSortRank(accountType, accountName),
        transaction_count: 0,
        total_amount: 0,
        transactions: [],
      });
    }
    const group = groups.get(key);
    const amount = Number(row.signed_amount ?? row.amount ?? 0);
    const normalizedAmount = Number.isFinite(amount) ? amount : 0;
    const status = cat.status || "needs_review";
    const qboSyncStatus = deriveQboSyncStatus(cat);
    const reconciliationStatus = deriveTraceReconciliationStatus({
      lifecycle: qboSyncStatus,
      reconciliationItem: reconciliationItemByTxn.get(String(row.id)) || null,
    });
    const payee = row.counterparty_name || row.merchant_name || "";
    const materialityFlags = buildTransactionMaterialityFlags({
      amount: normalizedAmount,
      accountId,
      accountName,
      payee: payee || row.name || "",
      qboSyncStatus,
      previousVendorSet,
      materialityThreshold,
    });
    group.transaction_count += 1;
    group.total_amount += normalizedAmount;
    group.transactions.push({
      id: row.id,
      plaid_transaction_id: row.plaid_transaction_id || null,
      plaid_account_id: row.plaid_account_id || null,
      bank_account: plaidAccountLabels.get(String(row.plaid_account_id)) || "Financial account",
      date: row.date,
      description: row.name || "",
      payee,
      amount: normalizedAmount,
      direction: row.direction || (normalizedAmount < 0 ? "outflow" : normalizedAmount > 0 ? "inflow" : null),
      status,
      posted: status === "posted" || Boolean(cat.qbo_txn_id),
      qbo_txn_id: cat.qbo_txn_id || null,
      qbo_txn_type: cat.qbo_txn_type || null,
      posted_at: cat.posted_at || null,
      post_after: cat.post_after || null,
      confidence: cat.confidence || null,
      reason: cat.reason || null,
      post_error: cat.post_error || null,
      qbo_sync_status: qboSyncStatus,
      qbo_lifecycle_status: qboSyncStatus,
      reconciliation_status: reconciliationStatus,
      reconciliation_item_status: reconciliationItemByTxn.get(String(row.id))?.status || null,
      books_review_tab: deriveBooksReviewTab(cat),
      final_qbo_account_id: cat.final_qbo_account_id || null,
      final_qbo_account_name: cat.final_qbo_account_name || null,
      final_canonical_account_key: cat.final_canonical_account_key || null,
      suggested_qbo_account_id: cat.suggested_qbo_account_id || null,
      suggested_qbo_account_name: cat.suggested_qbo_account_name || null,
      suggested_canonical_account_key: cat.suggested_canonical_account_key || null,
      effective_account_id: accountId,
      effective_account_name: accountName,
      materiality_flags: materialityFlags,
    });
  }

  const accountGroups = Array.from(groups.values())
    .map((group) => ({
      ...group,
      total_amount: roundCurrency(group.total_amount),
      previous_month_amount: roundCurrency(previousTotalsByGroup.get(group.account_id || `name:${normalizeAccountName(group.account_name) || "uncategorized"}`) || 0),
      materiality_flags: buildAccountMaterialityFlags(group, previousTotalsByGroup),
      transactions: group.transactions.sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
    }))
    .sort((a, b) => a.pnl_order - b.pnl_order || String(a.account_name || "").localeCompare(String(b.account_name || "")));

  const totals = accountGroups.reduce((acc, group) => {
    acc.transaction_count += group.transaction_count;
    acc.total_amount = roundCurrency(acc.total_amount + Number(group.total_amount || 0));
    if (!group.account_id && group.account_name === "Uncategorized") acc.uncategorized_count += group.transaction_count;
    group.transactions.forEach((txn) => {
      if (txn.books_review_tab === "needs_review") acc.needs_review_count += 1;
      if (txn.post_error) acc.post_error_count += 1;
      if (txn.books_review_tab === "posted") acc.posted_count += 1;
      const lifecycleKey = txn.qbo_lifecycle_status?.key || txn.qbo_sync_status?.key || "needs_review";
      acc.qbo_sync_counts[lifecycleKey] = (acc.qbo_sync_counts[lifecycleKey] || 0) + 1;
      if (Array.isArray(txn.materiality_flags) && txn.materiality_flags.length) acc.materiality_count += 1;
    });
    return acc;
  }, { transaction_count: 0, total_amount: 0, needs_review_count: 0, post_error_count: 0, posted_count: 0, uncategorized_count: 0, materiality_count: 0, qbo_sync_counts: {} });

  const monthlyPipeline = await loadMonthlyReconciliationPipeline(businessId, {
    month,
    accountById,
    accountByName,
  });
  const reconciliationTrace = monthlyPipeline.rows;
  const reconciliationTotals = monthlyPipeline.totals;

  return {
    totals,
    warnings,
    source_contract: {
      source_tables: ["bank_transactions", "transaction_categorizations"],
      date_basis: "bank_transactions.date",
      status_basis: "Unified reconciliation pipeline status over Books Review, QBO posting, and reconciliation_items authority",
      plaid_rows_basis: "canonical active Plaid-backed bank_transactions for selected month",
    },
    pnl_preview: buildPnlPreview(accountGroups),
    finalization_guard: buildFinalizationGuard({ account_groups: accountGroups, totals }),
    chart_accounts: chartAccounts.map((account) => ({
      id: account.id,
      name: account.name,
      type: account.accountType || account.account_type || account.type || null,
      active: account.active !== false,
    })),
    account_groups: accountGroups,
    reconciliation_trace: reconciliationTrace,
    reconciliation_totals: reconciliationTotals,
  };
}

async function loadAuthoritativeMonthlyPlaidTransactions(businessId, start, end) {
  return loadSharedAuthoritativeMonthlyPlaidTransactions(businessId, start, end);
}

export function removeSupersededPendingPlaidRows(rows = []) {
  return removeSharedSupersededPendingPlaidRows(rows);
}

export function buildAuthoritativePlaidTraceRow({
  row,
  cat = {},
  plaidAccountLabels = new Map(),
  accountById = new Map(),
  accountByName = new Map(),
  reconciliationItem = null,
} = {}) {
  const traceRow = buildMonthlyPipelineRow({
    row,
    cat,
    plaidAccountLabels,
    accountById,
    accountByName,
    reconciliationItem,
  });
  const reconciliationStatus = deriveTraceReconciliationStatus({
    lifecycle: traceRow.qbo_lifecycle_status,
    reconciliationItem,
  });
  return {
    ...traceRow,
    reconciliation_status: reconciliationStatus,
  };
}

async function loadPlaidAccountLabelsForMonthlyReview(businessId, plaidAccountIds = []) {
  const ids = Array.from(new Set((plaidAccountIds || []).filter(Boolean).map(String)));
  if (!businessId || !ids.length) return new Map();

  const accountRows = await safeRows(() =>
    supabase
      .from("plaid_accounts")
      .select("plaid_account_id,plaid_item_id,name,official_name,mask,type,subtype,is_active")
      .eq("business_id", businessId)
      .in("plaid_account_id", ids),
    "Monthly source ledger Plaid accounts"
  );
  const itemIds = Array.from(new Set((accountRows || []).map((row) => row.plaid_item_id).filter(Boolean)));
  const itemRows = itemIds.length
    ? await safeRows(() =>
        supabase
          .from("plaid_items")
          .select("plaid_item_id,institution_name")
          .eq("business_id", businessId)
          .in("plaid_item_id", itemIds),
        "Monthly source ledger Plaid items"
      )
    : [];
  const institutionByItemId = new Map((itemRows || []).map((row) => [String(row.plaid_item_id), row.institution_name || null]));
  return new Map((accountRows || []).map((row) => [
    String(row.plaid_account_id),
    formatPlaidAccountDisplayLabel({
      ...row,
      institution_name: institutionByItemId.get(String(row.plaid_item_id)) || null,
    }),
  ]));
}

async function loadReconciliationItemsForMonthlyTrace(businessId, month, transactionIds = []) {
  const ids = Array.from(new Set((transactionIds || []).filter(Boolean).map(String)));
  if (!businessId || !ids.length) return new Map();
  const [start, end] = monthBounds(month);
  const runs = await safeRows(() =>
    supabase
      .from("reconciliation_runs")
      .select("id,period_start,last_checked_at,created_at")
      .eq("business_id", businessId)
      .or(`period_start.gte.${start},last_checked_at.gte.${start},created_at.gte.${start}`)
      .order("last_checked_at", { ascending: false, nullsLast: true })
      .limit(5),
    "Monthly source ledger reconciliation runs"
  );
  const run = runs.find((item) => {
    const periodStart = toDateString(item.period_start || item.created_at || item.last_checked_at);
    return !periodStart || periodStart < end;
  }) || runs[0] || null;
  if (!run?.id) return new Map();

  const items = await safeRows(() =>
    supabase
      .from("reconciliation_items")
      .select("id,bank_transaction_id,status,note,details,qbo_txn_id,qbo_txn_type,reconciled_at,posted_at")
      .eq("business_id", businessId)
      .eq("run_id", run.id)
      .in("bank_transaction_id", ids),
    "Monthly source ledger reconciliation items"
  );
  return new Map((items || []).filter((row) => row.bank_transaction_id).map((row) => [String(row.bank_transaction_id), row]));
}

async function fetchOperatorResponsesAwaitingReview(businessId, month) {
  const [start, end] = monthBounds(month);
  const requests = await safeRows(() =>
    supabase
      .from("clarification_requests")
      .select("id,business_id,transaction_id,status,prompt_text,answer_text,selected_intent,answered_at,answered_by_user_id,meta")
      .eq("business_id", businessId)
      .eq("status", "answered")
      .is("resolved_at", null)
      .order("answered_at", { ascending: true }),
    "Operator responses"
  );
  const transactionIds = requests.map((row) => row.transaction_id).filter(Boolean);
  if (!transactionIds.length) {
    return { count: 0, rows: [], source_contract: { source_tables: ["clarification_requests", "bank_transactions", "transaction_categorizations"] } };
  }
  const responderIds = Array.from(new Set(requests.map((row) => row.answered_by_user_id).filter(Boolean)));
  const responderRows = responderIds.length
    ? await safeRows(() =>
        supabase
          .from("user_profiles")
          .select("id,email,first_name,last_name,full_name")
          .in("id", responderIds),
        "Operator response answerers"
      )
    : [];
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const bankRows = await safeRows(() =>
    applyActiveBookkeepingScope(
      supabase
        .from("bank_transactions")
        .select("id,plaid_account_id,date,name,merchant_name,counterparty_name,amount,signed_amount,direction,is_archived,pending")
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .gte("date", start)
        .lt("date", end)
        .in("id", transactionIds),
      bookkeepingStartDate
    ),
    "Operator response transactions"
  );
  const catRows = bankRows.length
    ? await safeRows(() =>
        supabase
          .from("transaction_categorizations")
          .select("transaction_id,status,suggested_qbo_account_id,suggested_qbo_account_name,final_qbo_account_id,final_qbo_account_name,post_after,qbo_txn_id,qbo_txn_type,posted_at,post_error,last_post_attempt_at,meta")
          .eq("business_id", businessId)
          .in("transaction_id", bankRows.map((row) => row.id)),
        "Operator response categorizations"
      )
    : [];
  const acctRows = bankRows.length
    ? await safeRows(() =>
        supabase
          .from("plaid_accounts")
          .select("plaid_account_id,name,official_name")
          .eq("business_id", businessId)
          .in("plaid_account_id", Array.from(new Set(bankRows.map((row) => row.plaid_account_id).filter(Boolean)))),
        "Operator response accounts"
      )
    : [];
  const bankById = new Map(bankRows.map((row) => [String(row.id), row]));
  const catByTxn = new Map(catRows.map((row) => [String(row.transaction_id), row]));
  const acctByPlaidId = new Map(acctRows.map((row) => [String(row.plaid_account_id), row.name || row.official_name || null]));
  const responderById = new Map((responderRows || []).map((row) => [
    String(row.id),
    {
      id: row.id,
      display_name: row.full_name || [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || "Customer",
      email: row.email || null,
    },
  ]));
  const rows = requests
    .map((request) => {
      const bank = bankById.get(String(request.transaction_id));
      const cat = catByTxn.get(String(request.transaction_id)) || {};
      if (!bank || !matchesTransactionStatusFilter("needs_review", cat)) return null;
      const amount = Number(bank.signed_amount ?? bank.amount ?? 0);
      const currentAccountId = cat.final_qbo_account_id || cat.suggested_qbo_account_id || null;
      const currentAccountName = cat.final_qbo_account_name || cat.suggested_qbo_account_name || null;
      const responder = request.answered_by_user_id ? responderById.get(String(request.answered_by_user_id)) || null : null;
      return {
        request_id: request.id,
        transaction_id: request.transaction_id,
        prompt_text: request.prompt_text || "What was this for?",
        answer_text: request.answer_text || "",
        selected_intent: request.selected_intent || request.meta?.selected_intent || null,
        answered_at: request.answered_at || null,
        answered_by_user_id: request.answered_by_user_id || null,
        answered_by_display: responder?.display_name || (request.answered_by_user_id ? "Customer" : null),
        answered_by_email: responder?.email || null,
        date: bank.date,
        amount,
        source_account: acctByPlaidId.get(String(bank.plaid_account_id)) || bank.plaid_account_id || null,
        merchant: bank.counterparty_name || bank.merchant_name || bank.name || "Transaction",
        description: bank.name || "",
        bank_memo: bank.name || "",
        pending: bank.pending === true,
        status: cat.status || "needs_review",
        qbo_sync_status: deriveQboSyncStatus(cat),
        qbo_txn_id: cat.qbo_txn_id || null,
        qbo_txn_type: cat.qbo_txn_type || null,
        posted_at: cat.posted_at || null,
        post_after: cat.post_after || null,
        post_error: cat.post_error || null,
        last_post_attempt_at: cat.last_post_attempt_at || null,
        meta: cat.meta || null,
        final_qbo_account_id: cat.final_qbo_account_id || null,
        final_qbo_account_name: cat.final_qbo_account_name || null,
        current_qbo_account_id: currentAccountId,
        current_qbo_account_name: currentAccountName,
        suggested_qbo_account_id: cat.suggested_qbo_account_id || request.meta?.non_authoritative_account_evidence?.qbo_account_id || null,
        suggested_qbo_account_name: cat.suggested_qbo_account_name || request.meta?.non_authoritative_account_evidence?.qbo_account_name || null,
        taxonomy_type: cat.meta?.taxonomy_type || null,
        special_workflow: cat.meta?.taxonomy_type || null,
      };
    })
    .filter(Boolean);
  return {
    count: rows.length,
    rows,
    source_contract: {
      source_tables: ["clarification_requests", "bank_transactions", "transaction_categorizations"],
      state_basis: "clarification_requests.status=answered and resolved_at is null, transaction still Books Review Needs Review",
    },
  };
}

async function resolveOperatorResponseTargetAccount(businessId, accountId) {
  const resolved = await fetchQboAccountByIdForBusiness(businessId, accountId);
  if (!resolved?.ok || !resolved.account) {
    const err = new BookkeepingApprovalError(resolved?.reason || "invalid_qbo_account", 400, { account_id: accountId });
    throw err;
  }
  const account = {
    id: String(resolved.account.id),
    name: resolved.account.name || resolved.account.fullyQualifiedName || resolved.account.FullyQualifiedName || null,
    type: resolved.account.type || resolved.account.AccountType || null,
    active: resolved.account.active !== false && resolved.account.Active !== false,
  };
  if (!account.active) throw new BookkeepingApprovalError("inactive_qbo_account", 400, { account_id: accountId });
  if (!account.name) throw new BookkeepingApprovalError("qbo_account_missing_name", 400, { account_id: accountId });
  return account;
}

async function buildReconciliationEvidence(businessId, month) {
  const [start, end] = monthBounds(month);
  const runs = await safeRows(() =>
    supabase
      .from("reconciliation_runs")
      .select("*")
      .eq("business_id", businessId)
      .or(`period_start.gte.${start},last_checked_at.gte.${start},created_at.gte.${start}`)
      .order("last_checked_at", { ascending: false, nullsLast: true })
      .limit(5),
    "Reconciliation runs"
  );
  const run = runs.find((item) => {
    const periodStart = toDateString(item.period_start || item.created_at || item.last_checked_at);
    return !periodStart || periodStart < end;
  }) || runs[0] || await safeLatest("reconciliation_runs", businessId, "last_checked_at");

  const items = run?.id
    ? await safeRows(() =>
        supabase
          .from("reconciliation_items")
          .select("*")
          .eq("business_id", businessId)
          .eq("run_id", run.id),
        "Reconciliation items"
      )
    : [];

  const exceptionItems = findTrueReconciliationExceptionItems(items);
  const kpis = buildReconciliationKpis(run, items, exceptionItems);
  const exceptionCount = kpis.exceptionCount;
  const missingInQbo = kpis.missingInQbo;
  const failedPost = kpis.failedPosting;
  const runStatus = String(run?.status || "not_run").toLowerCase();

  const warnings = [];
  appendEvidenceQueryWarnings(warnings, runs, items);
  if (!run) warnings.push("No reconciliation run found for this month.");
  if (exceptionCount > 0) warnings.push(`${exceptionCount} reconciliation exceptions need review.`);
  if (missingInQbo > 0) warnings.push(`${missingInQbo} transactions are missing in QBO.`);
  if (failedPost > 0) warnings.push(`${failedPost} transactions have failed posting evidence.`);

  return evidence({
    label: "Reconciliation KPIs",
    value: run ? `${kpis.fullyReconciled}/${kpis.plaidTotal} fully reconciled` : "No run found",
    detail: run
      ? `${kpis.postedToQbo} posted; ${kpis.needsGlCategory} still need a GL category.`
      : "Run reconciliation before finalizing.",
    tone: warnings.length ? "warning" : "good",
    deepLink: buildDeepLink("/dashboard/accounting/reconciliations", businessId, month, run?.id ? { run_id: run.id } : {}),
    metrics: [
      metric("Fully Reconciled", kpis.fullyReconciled, kpis.fullyReconciled === kpis.plaidTotal && kpis.plaidTotal > 0 ? "good" : "warning"),
      metric("Plaid Total", kpis.plaidTotal, "neutral"),
      metric("Categorized", kpis.categorized, kpis.needsGlCategory ? "warning" : "good"),
      metric("Needs GL", kpis.needsGlCategory, kpis.needsGlCategory ? "warning" : "good"),
      metric("Posted", kpis.postedToQbo, kpis.failedPosting || kpis.missingInQbo ? "warning" : "good"),
      metric("Failed Posting", kpis.failedPosting, kpis.failedPosting ? "danger" : "good"),
    ],
    warnings,
    raw: { run, runStatus, exceptionCount, missingInQbo, failedPost, exceptionItems, ...kpis },
  });
}

async function buildTaxEvidence(businessId, month) {
  const selectedSnapshot = await safeMaybeSingleWithWarning(() =>
    supabase
      .from("tax_snapshots")
      .select("*")
      .eq("business_id", businessId)
      .eq("month", month)
      .maybeSingle(),
    "Tax snapshot"
  );
  const snapshot = selectedSnapshot.row || await safeLatest("tax_snapshots", businessId, "created_at");

  const payload = snapshot?.payload || {};
  const metricsPayload = payload.metrics || payload;
  const estimatedTax = firstFinite(metricsPayload.estimatedTaxDue, metricsPayload.estimated_ytd_tax, metricsPayload.ytdEstimated, payload.estimatedTaxDue);
  const profitYtd = firstFinite(metricsPayload.profitYTD, metricsPayload.profit_ytd, payload.profitYTD);
  const deductions = Array.isArray(metricsPayload.topDeductions) ? metricsPayload.topDeductions : [];
  const hasSelectedMonthSnapshot = snapshot?.month === month;

  const warnings = [];
  if (selectedSnapshot.warning) warnings.push(selectedSnapshot.warning);
  if (!snapshot) warnings.push("No tax snapshot found.");
  if (snapshot && !hasSelectedMonthSnapshot) warnings.push("Latest tax snapshot is not for the selected review month.");
  if (!Number.isFinite(estimatedTax)) warnings.push("Estimated tax due is missing from the snapshot.");
  if (!Number.isFinite(profitYtd)) warnings.push("Profit YTD is missing from the snapshot.");

  return evidence({
    label: "Tax snapshot completeness",
    value: warnings.length ? `${warnings.length} gaps` : "Snapshot complete",
    detail: snapshot ? `Snapshot ${hasSelectedMonthSnapshot ? "for selected month" : `from ${formatMonthValue(snapshot.month)}`}.` : "Generate or verify the tax snapshot.",
    tone: warnings.length ? "warning" : "good",
    deepLink: buildDeepLink("/dashboard/tax", businessId, month),
    metrics: [
      metric("YTD Tax", formatCurrency(estimatedTax), Number.isFinite(estimatedTax) ? "neutral" : "warning"),
      metric("Profit YTD", formatCurrency(profitYtd), Number.isFinite(profitYtd) ? "neutral" : "warning"),
      metric("Top Deductions", deductions.length, deductions.length ? "neutral" : "warning"),
      metric("Month Match", hasSelectedMonthSnapshot ? "Yes" : "No", hasSelectedMonthSnapshot ? "good" : "warning"),
    ],
    warnings,
    raw: { snapshot_id: snapshot?.id || null, month: snapshot?.month || null },
  });
}

async function buildForecastEvidence(businessId, month) {
  const forecastLookup = await safeMaybeSingleWithWarning(() =>
    supabase
      .from("cashflow_forecast")
      .select("*")
      .eq("business_id", businessId)
      .eq("month", month)
      .maybeSingle(),
    "Cash-flow forecast"
  );
  const actualLookup = await safeMaybeSingleWithWarning(() =>
    supabase
      .from("financial_metrics")
      .select("*")
      .eq("business_id", businessId)
      .eq("month", month)
      .maybeSingle(),
    "Actual financial metrics"
  );
  const forecast = forecastLookup.row;
  const actual = actualLookup.row;

  const forecastRevenue = firstFinite(forecast?.revenue, forecast?.projected_revenue, forecast?.total_revenue);
  const forecastExpenses = firstFinite(forecast?.expenses, forecast?.projected_expenses, forecast?.total_expenses);
  const derivedForecastProfit = Number.isFinite(forecastRevenue) && Number.isFinite(forecastExpenses)
    ? forecastRevenue - forecastExpenses
    : null;
  const forecastProfit = firstFinite(forecast?.net_cash, forecast?.net_profit, derivedForecastProfit);
  const actualRevenue = firstFinite(actual?.total_revenue, actual?.revenue);
  const actualExpenses = firstFinite(actual?.total_expenses, actual?.expenses);
  const derivedActualProfit = Number.isFinite(actualRevenue) && Number.isFinite(actualExpenses)
    ? actualRevenue - actualExpenses
    : null;
  const actualProfit = firstFinite(actual?.net_profit, derivedActualProfit);
  const variance = Number.isFinite(forecastProfit) && Number.isFinite(actualProfit) ? actualProfit - forecastProfit : null;
  const variancePct = Number.isFinite(variance) && Math.abs(forecastProfit) > 0 ? (variance / Math.abs(forecastProfit)) * 100 : null;

  const warnings = [];
  if (forecastLookup.warning) warnings.push(forecastLookup.warning);
  if (actualLookup.warning) warnings.push(actualLookup.warning);
  if (!forecast) warnings.push("No cash-flow forecast row exists for the selected month.");
  if (!actual) warnings.push("No actual financial metrics row exists for variance comparison.");
  if (Number.isFinite(variancePct) && Math.abs(variancePct) >= 15) warnings.push(`Forecast vs actual profit variance is ${formatPercent(variancePct)}.`);

  return evidence({
    label: "Forecast vs actual",
    value: Number.isFinite(variancePct) ? `${formatPercent(variancePct)} variance` : "Variance unavailable",
    detail: forecast && actual ? `${formatCurrency(forecastProfit)} forecast profit vs ${formatCurrency(actualProfit)} actual.` : "Confirm forecast and actual metrics before finalizing.",
    tone: warnings.length ? "warning" : "good",
    deepLink: buildDeepLink("/dashboard/accounting/forecasts", businessId, month),
    metrics: [
      metric("Forecast Profit", formatCurrency(forecastProfit), Number.isFinite(forecastProfit) ? "neutral" : "warning"),
      metric("Actual Profit", formatCurrency(actualProfit), Number.isFinite(actualProfit) ? "neutral" : "warning"),
      metric("Variance", formatCurrency(variance), Number.isFinite(variance) ? (Math.abs(variancePct || 0) >= 15 ? "warning" : "good") : "warning"),
      metric("Variance %", formatPercent(variancePct), Number.isFinite(variancePct) ? (Math.abs(variancePct) >= 15 ? "warning" : "good") : "warning"),
    ],
    warnings,
    raw: { forecast_id: forecast?.id || null, actual_id: actual?.id || null, variance, variancePct },
  });
}

async function buildJobCostingEvidence(businessId, month) {
  const [start, end] = monthBounds(month);
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const assignments = await safeRows(() =>
    supabase
      .from("job_transaction_assignments")
      .select("*")
      .eq("business_id", businessId)
      .gte("created_at", start)
      .lt("created_at", end),
    "Job costing assignments"
  );
  const assignmentTxnIds = new Set(assignments.map((row) => row.transaction_id).filter(Boolean));

  const bankRows = await safeRows(() => {
    let query = supabase
      .from("bank_transactions")
      .select("id,date,amount,name,merchant_name,is_archived")
      .eq("business_id", businessId)
      .gte("date", start)
      .lt("date", end);
    query = applyActiveBookkeepingScope(query, bookkeepingStartDate);
    return query;
  }, "Job costing bank transactions");
  const bankIds = bankRows.map((row) => row.id).filter(Boolean);
  const catRows = bankIds.length
    ? await safeRows(() =>
        supabase
          .from("transaction_categorizations")
          .select("transaction_id,status,qbo_txn_id,qbo_txn_type,final_qbo_account_name,suggested_qbo_account_name")
          .eq("business_id", businessId)
          .in("transaction_id", bankIds),
        "Job costing categorizations"
      )
    : [];
  const catByTxn = new Map(catRows.map((row) => [row.transaction_id, row]));
  const postedJobLike = bankRows.filter((row) => {
    if (row.is_archived) return false;
    const cat = catByTxn.get(row.id) || {};
    const account = `${cat.final_qbo_account_name || cat.suggested_qbo_account_name || ""} ${cat.qbo_txn_type || ""}`.toLowerCase();
    const posted = String(cat.status || "").toLowerCase() === "posted" || Boolean(cat.qbo_txn_id);
    const jobLike = /job|material|labor|subcontract|contractor|construction|invoice|cogs|cost/.test(account);
    return posted && jobLike;
  });
  const unassigned = postedJobLike.filter((row) => !assignmentTxnIds.has(row.id)).length;
  const uniqueJobs = new Set(assignments.map((row) => row.job_id).filter(Boolean)).size;

  const warnings = [];
  appendEvidenceQueryWarnings(warnings, assignments, bankRows, catRows);
  if (unassigned > 0) warnings.push(`${unassigned} posted job-like transactions are not assigned to a job.`);
  if (postedJobLike.length && !assignments.length) warnings.push("Job-like transactions exist, but no job costing assignments were found for the month.");

  return evidence({
    label: "Job costing assignments",
    value: unassigned ? `${unassigned} unassigned` : `${assignments.length} assigned`,
    detail: `${assignments.length} assignment rows across ${uniqueJobs} jobs.`,
    tone: warnings.length ? "warning" : "good",
    deepLink: buildDeepLink("/dashboard/leads-jobs/job-costing", businessId, month, { filter: unassigned ? "unassigned" : "assigned" }),
    metrics: [
      metric("Assignments", assignments.length, assignments.length ? "neutral" : "warning"),
      metric("Jobs Touched", uniqueJobs, uniqueJobs ? "neutral" : "warning"),
      metric("Job-like Posted", postedJobLike.length, "neutral"),
      metric("Unassigned", unassigned, unassigned ? "warning" : "good"),
    ],
    warnings,
    raw: { assignments: assignments.length, uniqueJobs, postedJobLike: postedJobLike.length, unassigned },
  });
}

function evidence({ label, value, detail, tone = "neutral", metrics = [], warnings = [], deepLink = "", raw = {} }) {
  return {
    label,
    value,
    detail,
    tone,
    metrics,
    warnings,
    deep_link: deepLink,
    raw,
    exception_count: warnings.length,
    generated_at: new Date().toISOString(),
  };
}

function metric(label, value, tone = "neutral") {
  return { label, value: value ?? "—", tone };
}

async function safeCount(table, filters = [], month, dateColumn) {
  try {
    const [start, end] = monthBounds(month);
    let query = supabase.from(table).select("id", { count: "exact", head: true });
    filters.forEach(([column, value]) => {
      query = query.eq(column, value);
    });
    if (dateColumn) query = query.gte(dateColumn, start).lt(dateColumn, end);
    const { count, error } = await query;
    if (error) throw error;
    return { count: count || 0 };
  } catch {
    return { count: 0 };
  }
}

async function safeLatest(table, businessId, orderColumn = "created_at") {
  try {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .eq("business_id", businessId)
      .order(orderColumn, { ascending: false, nullsLast: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch {
    return null;
  }
}

async function safeRows(factory, label = "Evidence query") {
  try {
    const { data, error } = await factory();
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch (e) {
    const message = `${label} could not be loaded: ${e?.message || e}`;
    console.warn("[monthly-review] evidence query skipped", message);
    const rows = [];
    Object.defineProperty(rows, "__evidence_error", {
      value: message,
      enumerable: false,
    });
    return rows;
  }
}

async function safeMaybeSingle(factory) {
  try {
    const { data, error } = await factory();
    if (error) throw error;
    return data || null;
  } catch (e) {
    console.warn("[monthly-review] evidence lookup skipped", e?.message || e);
    return null;
  }
}

async function safeMaybeSingleWithWarning(factory, label = "Evidence lookup") {
  try {
    const { data, error } = await factory();
    if (error) throw error;
    return { row: data || null, warning: null };
  } catch (e) {
    const warning = `${label} could not be loaded: ${e?.message || e}`;
    console.warn("[monthly-review] evidence lookup skipped", warning);
    return { row: null, warning };
  }
}

function monthBounds(month) {
  const [year, monthNumber] = String(month).split("-").map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  return [start, end];
}

function previousDate(date) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function previousMonthBounds(month) {
  const [year, monthNumber] = String(month).split("-").map(Number);
  const startDate = new Date(Date.UTC(year, monthNumber - 2, 1));
  const endDate = new Date(Date.UTC(year, monthNumber - 1, 1));
  return [startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10)];
}

function buildDeepLink(route, businessId, month, extra = {}) {
  const params = new URLSearchParams({
    business_id: businessId,
    review_month: month.slice(0, 7),
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value != null && value !== "")),
  });
  return `${route}?${params.toString()}`;
}

function appendEvidenceQueryWarnings(warnings, ...values) {
  values
    .map((value) => value?.__evidence_error)
    .filter(Boolean)
    .forEach((message) => warnings.push(message));
}

async function loadChartAccountsForReview(businessId) {
  try {
    const accounts = await fetchChartOfAccounts(businessId, { includeSubaccounts: true });
    return (accounts || []).map((account) => ({
      ...account,
      id: account.id || account.qbo_account_id || account.account_id || account.name,
      name: account.name || account.qbo_account_name || account.account_name || "Unnamed account",
      accountType: account.accountType || account.account_type || account.type || null,
    }));
  } catch (e) {
    console.warn("[monthly-review] chart of accounts unavailable", e?.message || e);
    return [];
  }
}

function normalizeAccountName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function inferAccountType(accountName = "") {
  const normalized = normalizeAccountName(accountName);
  if (/sales|revenue|income/.test(normalized)) return "Income";
  if (/cost of goods|cogs|materials|labor|subcontract/.test(normalized)) return "Cost of Goods Sold";
  if (/expense|fuel|tools|rent|insurance|advertising|meal|travel|repair|supplies/.test(normalized)) return "Expense";
  if (/asset|cash|bank|checking|savings/.test(normalized)) return "Asset";
  if (/liability|loan|payable|tax/.test(normalized)) return "Liability";
  if (/equity|owner/.test(normalized)) return "Equity";
  return "Uncategorized";
}

function pnlSortRank(accountType = "", accountName = "") {
  const type = String(accountType || "").toLowerCase();
  const name = String(accountName || "").toLowerCase();
  if (type.includes("income") || type.includes("revenue") || name.includes("sales") || name.includes("revenue")) return 10;
  if (type.includes("cost of goods") || type.includes("cogs") || name.includes("cost of goods") || name.includes("cogs")) return 20;
  if (type.includes("expense") || name.includes("expense")) return 30;
  if (type.includes("other income")) return 40;
  if (type.includes("other expense")) return 50;
  if (type.includes("asset")) return 70;
  if (type.includes("liability")) return 80;
  if (type.includes("equity")) return 90;
  return 100;
}

function roundCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function deriveQboSyncStatus(cat = {}) {
  return deriveQboPostingLifecycle(cat);
}

function deriveBooksReviewTab(cat = {}) {
  const status = String(cat?.status || "needs_review").toLowerCase();
  const isCheckTxn = cat?.meta?.is_check === true;
  if (status === "posted" || cat?.qbo_txn_id) return "posted";
  if (["approved", "auto_approved"].includes(status) && !isCheckTxn) return "handled";
  if (!status || status === "needs_review" || status === "uncategorized") return "needs_review";
  if (status === "auto_approved" && isCheckTxn) return "needs_review";
  return "needs_review";
}

function buildCurrentReviewEvidence(summaries = {}, sourceLedger = {}) {
  return {
    ...summaries,
    source_ledger: summarizeLedgerForEvidence(sourceLedger),
  };
}

function summarizeLedgerForEvidence(sourceLedger = {}) {
  const groups = Array.isArray(sourceLedger.account_groups) ? sourceLedger.account_groups : [];
  return {
    label: "P&L source ledger",
    value: `${sourceLedger.totals?.transaction_count || 0} transactions`,
    detail: `${sourceLedger.totals?.qbo_sync_counts?.failed || 0} failed, ${sourceLedger.totals?.qbo_sync_counts?.queued || 0} queued, ${sourceLedger.totals?.uncategorized_count || 0} uncategorized.`,
    totals: sourceLedger.totals || {},
    pnl_preview: sourceLedger.pnl_preview || {},
    groups: groups.map((group) => ({
      account_id: group.account_id || null,
      account_name: group.account_name || null,
      account_type: group.account_type || null,
      total_amount: group.total_amount || 0,
      transaction_count: group.transaction_count || 0,
      transactions: (group.transactions || []).map((txn) => ({
        id: txn.id,
        date: txn.date,
        amount: txn.amount,
        effective_account_id: txn.effective_account_id || null,
        effective_account_name: txn.effective_account_name || null,
        qbo_sync_key: txn.qbo_lifecycle_status?.key || txn.qbo_sync_status?.key || "needs_review",
        qbo_txn_id: txn.qbo_txn_id || null,
      })),
    })),
  };
}

function summarizeAccountingCloseBlockers(guard = {}) {
  const counts = guard.counts || {};
  const parts = [
    counts.needs_review_transactions ? `${counts.needs_review_transactions} Needs Review transaction${counts.needs_review_transactions === 1 ? "" : "s"}` : null,
    counts.operator_responses_unresolved ? `${counts.operator_responses_unresolved} Operator Response${counts.operator_responses_unresolved === 1 ? "" : "s"}` : null,
    counts.canonical_coa_needs_review ? `${counts.canonical_coa_needs_review} canonical account approval${counts.canonical_coa_needs_review === 1 ? "" : "s"}` : null,
    counts.qbo_failed ? `${counts.qbo_failed} failed QBO posting${counts.qbo_failed === 1 ? "" : "s"}` : null,
    counts.qbo_queued ? `${counts.qbo_queued} queued QBO posting${counts.qbo_queued === 1 ? "" : "s"}` : null,
    counts.qbo_not_posted ? `${counts.qbo_not_posted} unposted transaction${counts.qbo_not_posted === 1 ? "" : "s"}` : null,
    counts.missing_gl_account ? `${counts.missing_gl_account} missing GL account${counts.missing_gl_account === 1 ? "" : "s"}` : null,
    counts.reconciliation_exception ? `${counts.reconciliation_exception} reconciliation/posting exception${counts.reconciliation_exception === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  if (!parts.length) return "Accounting close blockers must be resolved before finalizing.";
  return `Resolve ${parts.join(", ")} before approving this month.`;
}

function buildSectionSourceReview(sectionKey, summary = {}, sourceLedger = {}) {
  const warnings = Array.isArray(summary?.warnings) ? summary.warnings : [];
  const metrics = Array.isArray(summary?.metrics) ? summary.metrics : [];
  const guard = sourceLedger?.finalization_guard || buildFinalizationGuard(sourceLedger);
  const syncCounts = sourceLedger?.totals?.qbo_sync_counts || {};
  const sectionBlockers = sectionKey === "books"
    ? (guard.blockers || []).length
    : warnings.length;
  return {
    exception_count: warnings.length,
    sync_state: sectionKey === "books"
      ? ((syncCounts.failed || syncCounts.queued || syncCounts.handled_not_posted || syncCounts.not_posted) ? "attention" : "synced")
      : (warnings.length ? "attention" : "clear"),
    last_refreshed_at: summary?.generated_at || new Date().toISOString(),
    pass_fail: sectionBlockers ? "fail" : "pass",
    reviewer_note_required: sectionBlockers > 0,
    metrics,
  };
}

function describeActiveLock(run = {}) {
  const expiresAt = run.active_editor_expires_at || null;
  const isActive = expiresAt ? Date.parse(expiresAt) > Date.now() : false;
  return {
    active: Boolean(isActive && run.active_editor_user_id),
    user_id: isActive ? run.active_editor_user_id || null : null,
    email: isActive ? run.active_editor_email || null : null,
    started_at: isActive ? run.active_editor_started_at || null : null,
    expires_at: isActive ? expiresAt : null,
  };
}

function buildTransactionMaterialityFlags({
  amount,
  accountId,
  accountName,
  payee,
  qboSyncStatus,
  previousVendorSet,
  materialityThreshold,
}) {
  const flags = [];
  const absAmount = Math.abs(Number(amount) || 0);
  if (absAmount >= materialityThreshold && absAmount > 0) {
    flags.push({ key: "large", label: "Large", tone: "warning", detail: `Above ${formatCurrency(materialityThreshold)} materiality threshold.` });
  }
  if (!accountId && normalizeAccountName(accountName) === "uncategorized") {
    flags.push({ key: "uncategorized", label: "Uncategorized", tone: "danger", detail: "No GL account has been assigned." });
  }
  if (qboSyncStatus?.key === "failed") {
    flags.push({ key: "qbo_failed", label: "QBO Failed", tone: "danger", detail: qboSyncStatus.detail || "QBO sync failed." });
  }
  const normalizedPayee = normalizeAccountName(payee);
  if (normalizedPayee && previousVendorSet instanceof Set && !previousVendorSet.has(normalizedPayee)) {
    flags.push({ key: "new_vendor", label: "New Payee", tone: "neutral", detail: "No matching payee found in the prior month." });
  }
  return flags;
}

function buildAccountMaterialityFlags(group = {}, previousTotalsByGroup = new Map()) {
  const key = group.account_id || `name:${normalizeAccountName(group.account_name) || "uncategorized"}`;
  const previousAmount = Number(previousTotalsByGroup.get(key) || 0);
  const currentAmount = Number(group.total_amount || 0);
  const diff = currentAmount - previousAmount;
  const pct = Math.abs(previousAmount) > 0 ? (diff / Math.abs(previousAmount)) * 100 : null;
  if (Number.isFinite(pct) && Math.abs(pct) >= 25 && Math.abs(diff) >= 500) {
    return [{
      key: "month_over_month",
      label: `${formatPercent(pct)} vs prior month`,
      tone: "warning",
      detail: `${formatCurrency(previousAmount)} prior month vs ${formatCurrency(currentAmount)} current month.`,
    }];
  }
  if (!Number.isFinite(pct) && Math.abs(currentAmount) >= 1000 && Math.abs(previousAmount) === 0) {
    return [{
      key: "new_account_activity",
      label: "New activity",
      tone: "neutral",
      detail: "No activity in this account last month.",
    }];
  }
  return [];
}

function buildPnlPreview(accountGroups = []) {
  const buckets = {
    revenue: 0,
    cogs: 0,
    gross_profit: 0,
    expenses: 0,
    other_income: 0,
    other_expense: 0,
    net_profit: 0,
  };
  const lines = accountGroups.map((group) => {
    const bucket = pnlBucket(group.account_type, group.account_name);
    const amount = roundCurrency(group.total_amount || 0);
    if (bucket && buckets[bucket] != null) buckets[bucket] = roundCurrency(buckets[bucket] + amount);
    return {
      account_id: group.account_id || null,
      account_name: group.account_name || "Uncategorized",
      account_type: group.account_type || null,
      bucket,
      amount,
      transaction_count: group.transaction_count || 0,
    };
  });
  buckets.gross_profit = roundCurrency(buckets.revenue + buckets.cogs);
  buckets.net_profit = roundCurrency(
    buckets.gross_profit - Math.abs(buckets.expenses) + buckets.other_income - Math.abs(buckets.other_expense)
  );
  return { buckets, lines };
}

function pnlBucket(accountType = "", accountName = "") {
  const type = String(accountType || "").toLowerCase();
  const name = String(accountName || "").toLowerCase();
  if (type.includes("income") || type.includes("revenue") || name.includes("sales") || name.includes("revenue")) {
    if (type.includes("other") || name.includes("other income")) return "other_income";
    return "revenue";
  }
  if (type.includes("cost of goods") || type.includes("cogs") || name.includes("cogs") || name.includes("cost of goods")) return "cogs";
  if (type.includes("other expense") || name.includes("other expense")) return "other_expense";
  if (type.includes("expense") || name.includes("expense")) return "expenses";
  return null;
}

function buildReviewPacketHtml(packet = {}) {
  const businessName = escapeHtml(packet.business?.business_name || "Business");
  const month = formatMonthValue(packet.run?.review_month);
  const readiness = packet.readiness || {};
  const sections = Array.isArray(packet.sections) ? packet.sections : [];
  const auditEvents = Array.isArray(packet.audit_events) ? packet.audit_events : [];
  const reminders = Array.isArray(packet.reminders) ? packet.reminders : [];
  const changes = Array.isArray(packet.changed_since_finalized) ? packet.changed_since_finalized : [];
  const sourceLedger = packet.source_ledger || {};
  const ledgerGroups = Array.isArray(sourceLedger.account_groups) ? sourceLedger.account_groups : [];

  const sectionHtml = sections.map((section) => {
    const evidenceForSection = section.current_evidence || section.evidence_snapshot || {};
    const metrics = Array.isArray(evidenceForSection.metrics) ? evidenceForSection.metrics : [];
    const warnings = Array.isArray(evidenceForSection.warnings) ? evidenceForSection.warnings : [];
    return `
      <section class="card">
        <div class="row">
          <div>
            <div class="eyebrow">${escapeHtml(section.definition?.label || section.section_key)}</div>
            <h2>${escapeHtml(evidenceForSection.value || "Manual review")}</h2>
          </div>
          <span class="pill">${escapeHtml(section.status || "pending")}</span>
        </div>
        <p>${escapeHtml(evidenceForSection.detail || section.notes || "")}</p>
        ${metrics.length ? `<div class="metrics">${metrics.map((item) => `
          <div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(String(item.value ?? ""))}</strong></div>
        `).join("")}</div>` : ""}
        ${warnings.length ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : "<p class=\"quiet\">No exception evidence detected.</p>"}
        ${section.notes ? `<p class="notes"><strong>Reviewer notes:</strong> ${escapeHtml(section.notes)}</p>` : ""}
      </section>
    `;
  }).join("");

  const auditHtml = auditEvents.map((event) => `
    <tr>
      <td>${escapeHtml(formatDateTime(event.created_at))}</td>
      <td>${escapeHtml(event.actor_email || "System")}</td>
      <td>${escapeHtml(event.event_type || "")}</td>
      <td>${escapeHtml(event.section_key || "")}</td>
      <td>${escapeHtml(event.notes || "")}</td>
    </tr>
  `).join("");
  const ledgerHtml = ledgerGroups.map((group) => `
    <section class="card">
      <div class="row">
        <div>
          <div class="eyebrow">${escapeHtml(group.account_type || "Account")}</div>
          <h2>${escapeHtml(group.account_name || "Uncategorized")}</h2>
        </div>
        <span class="pill">${escapeHtml(formatCurrency(group.total_amount))}</span>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Payee</th><th>Description</th><th>QBO Sync</th><th>Status</th><th>Amount</th></tr></thead>
        <tbody>${(group.transactions || []).map((txn) => `
          <tr>
            <td>${escapeHtml(txn.date || "")}</td>
            <td>${escapeHtml(txn.payee || "")}</td>
            <td>${escapeHtml(txn.description || "")}</td>
            <td>${escapeHtml(txn.qbo_sync_status?.label || "Not posted")}</td>
            <td>${escapeHtml(txn.status || "")}</td>
            <td>${escapeHtml(formatCurrency(txn.amount))}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    </section>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${businessName} Monthly Review Packet</title>
  <style>
    body { margin: 0; padding: 32px; font-family: Inter, Arial, sans-serif; color: #18211d; background: #f7f8f5; }
    main { max-width: 1040px; margin: 0 auto; }
    header { border-bottom: 2px solid #d6ddd2; padding-bottom: 20px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; }
    h2 { margin: 4px 0 0; font-size: 20px; }
    p { color: #536158; line-height: 1.45; }
    .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .eyebrow { color: #627168; font-size: 11px; text-transform: uppercase; letter-spacing: .14em; font-weight: 700; }
    .stamp { display: inline-flex; border: 1px solid #2b8a64; color: #176148; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 700; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0; }
    .summary div, .card { background: white; border: 1px solid #dfe5db; border-radius: 12px; padding: 16px; }
    .summary span, .metrics span { display: block; color: #6a756d; font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    .summary strong, .metrics strong { display: block; margin-top: 4px; font-size: 18px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .pill { border: 1px solid #c7d2c7; border-radius: 999px; padding: 5px 9px; font-size: 12px; color: #35433a; background: #f4f7f2; }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
    .metrics div { border: 1px solid #e2e8df; border-radius: 10px; padding: 10px; }
    ul { color: #715a17; background: #fff7d6; border: 1px solid #f1df9e; border-radius: 10px; padding: 10px 10px 10px 28px; }
    .quiet { color: #53725f; background: #edf7ef; border: 1px solid #cfe5d4; border-radius: 10px; padding: 10px; }
    .notes { color: #344039; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; background: white; border: 1px solid #dfe5db; }
    th, td { text-align: left; border-bottom: 1px solid #e8ede5; padding: 9px; font-size: 12px; vertical-align: top; }
    th { color: #627168; text-transform: uppercase; letter-spacing: .1em; font-size: 10px; }
    @media print { body { background: white; padding: 18px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header class="row">
      <div>
        <div class="eyebrow">Internal Monthly Review Packet</div>
        <h1>${businessName}</h1>
        <p>${escapeHtml(month)} · exported ${escapeHtml(formatDateTime(packet.exported_at))}</p>
      </div>
      <div class="stamp">${escapeHtml(packet.run?.status || "in progress")}</div>
    </header>
    <div class="summary">
      <div><span>Readiness</span><strong>${escapeHtml(String(readiness.score ?? 0))}%</strong></div>
      <div><span>Required</span><strong>${escapeHtml(`${readiness.reviewed_required ?? 0}/${readiness.total_required ?? 0}`)}</strong></div>
      <div><span>Warnings</span><strong>${escapeHtml(String(readiness.warning_count ?? 0))}</strong></div>
      <div><span>Blocked</span><strong>${escapeHtml(String(readiness.blocked_count ?? 0))}</strong></div>
    </div>
    ${changes.length ? `<section class="card"><div class="eyebrow">Changed Since Finalized</div><ul>${changes.map((item) => `<li>${escapeHtml(item.label)}: ${escapeHtml(item.previous_value || "none")} to ${escapeHtml(item.current_value || "none")}</li>`).join("")}</ul></section>` : ""}
    <div class="grid">${sectionHtml}</div>
    <section style="margin-top: 20px;">
      <div class="eyebrow">P&L Source Ledger</div>
      <h2>${escapeHtml(String(sourceLedger.totals?.transaction_count || 0))} source transactions</h2>
      <p>Grouped by GL account in P&L review order.</p>
      <div class="grid">${ledgerHtml || "<section class=\"card\">No source transactions found.</section>"}</div>
    </section>
    <section class="card" style="margin-top: 16px;">
      <div class="row"><div><div class="eyebrow">Audit Log</div><h2>${auditEvents.length} events</h2></div><span class="pill">${reminders.length} reminders</span></div>
      <table>
        <thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Section</th><th>Notes</th></tr></thead>
        <tbody>${auditHtml || "<tr><td colspan=\"5\">No audit events.</td></tr>"}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function formatCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number);
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number > 0 ? "+" : ""}${Math.round(number)}%`;
}

function formatMonthValue(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})/);
  if (!match) return "another month";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function toDateString(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export default router;
