import { Router } from "express";
import crypto from "crypto";
import { supabase } from "../../services/supabaseAdmin.js";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { fetchChartOfAccounts } from "../../services/bookkeeping/qboAccounts.js";
import { getQBOClient } from "../../utils/qboClient.js";
import { runBooksPostOnce } from "../../jobs/booksPost.cron.js";
import { runQboSync } from "../accounting/qbo-sync.js";
import { ensurePnLPdf } from "../accounting/pnlPdfService.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "../../services/bookkeeping/bookkeepingScope.js";

const router = Router();

const SECTION_DEFS = [
  { key: "forecasting", label: "Forecasting", route: "/dashboard/accounting/forecasts", required: true },
  { key: "tax_liability", label: "Tax Liability", route: "/dashboard/tax", required: true },
  { key: "job_costing", label: "Job Costing", route: "/dashboard/leads-jobs/job-costing", required: true },
  { key: "reconciliations", label: "Reconciliations", route: "/dashboard/accounting/reconciliations", required: true },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAuth);
router.use(requireInternalAdmin);

router.get("/me", async (req, res) => {
  res.json({
    ok: true,
    user: { id: req.user.id, email: req.user.email, internal: true },
    safeguards: {
      route: "/api/admin/monthly-review",
      auth: "Supabase auth required",
      authorization: "Bizzi internal admin only",
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
    res.status(500).json({ ok: false, error: "monthly_review_businesses_failed", message: e?.message || "Could not load businesses." });
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

    const run = await ensureRun(businessId, month, req.user.id);
    const sections = await ensureSections(run.id);
    const summaries = await buildSummaries(businessId, month);
    const stamp = await fetchStamp(businessId, month);
    const auditEvents = await fetchAuditEvents(run.id);
    const reminders = await fetchReminders(run.id);
    const sourceLedger = await buildMonthlySourceLedger(businessId, month);
    const pnlReport = await fetchMonthlyPnlReport(businessId, month);
    const finalizationGuard = buildFinalizationGuard(sourceLedger);
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
    res.status(500).json({ ok: false, error: "monthly_review_detail_failed", message: e?.message || "Could not load review." });
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
    res.status(500).json({ ok: false, error: "monthly_review_source_ledger_failed", message: e?.message || "Could not load source ledger." });
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
    const missing = SECTION_DEFS
      .filter((def) => def.required)
      .filter((def) => {
        const section = sections.find((item) => item.section_key === def.key);
        return !section || !["reviewed", "not_applicable"].includes(section.status);
      });

    if (missing.length) {
      return res.status(409).json({
        ok: false,
        error: "required_sections_not_reviewed",
        missing_sections: missing,
        message: "All required sections must be reviewed before finalizing.",
      });
    }

    const now = new Date().toISOString();
    const summaries = await buildSummaries(run.business_id, run.review_month);
    const sourceLedger = await buildMonthlySourceLedger(run.business_id, run.review_month);
    const finalizationGuard = buildFinalizationGuard(sourceLedger);
    if (!finalizationGuard.can_finalize) {
      return res.status(409).json({
        ok: false,
        error: "source_ledger_not_ready_for_finalization",
        message: "Resolve QBO sync failures, queued transactions, missing GL accounts, and unsynced transactions before finalizing.",
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

    const { data: updatedRun, error: updateErr } = await supabase
      .from("monthly_review_runs")
      .update({
        status: "finalized",
        finalized_by: req.user.id,
        finalized_at: now,
        notes: req.body?.notes ?? run.notes ?? null,
        evidence_snapshot: currentEvidence,
        evidence_hash: evidenceHash,
        readiness_score: readiness.score,
        updated_at: now,
      })
      .eq("id", runId)
      .select("*")
      .single();
    if (updateErr) throw updateErr;

    const { data: stamp, error: stampErr } = await supabase
      .from("financial_monthly_review_stamps")
      .upsert({
        business_id: run.business_id,
        review_month: run.review_month,
        status: "finalized",
        reviewed_by: req.user.email || req.user.id,
        reviewer_user_id: req.user.id,
        completed_at: now,
        notes: req.body?.notes ?? null,
        updated_at: now,
      }, { onConflict: "business_id,review_month" })
      .select("*")
      .single();
    if (stampErr) throw stampErr;

    await logAuditEvent({
      run: updatedRun,
      actor: req.user,
      eventType: "finalized",
      previousValue: { status: run.status, finalized_at: run.finalized_at },
      nextValue: { status: "finalized", finalized_at: now, readiness_score: readiness.score },
      notes: req.body?.notes ?? null,
    });

    res.json({ ok: true, run: updatedRun, stamp });
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
    const accountId = String(req.body?.final_qbo_account_id || req.body?.account_id || "").trim() || null;
    const accountName = String(req.body?.final_qbo_account_name || req.body?.account_name || "").trim() || null;
    if (!accountId || !accountName) {
      return res.status(400).json({
        ok: false,
        error: "missing_account",
        message: "Choose a GL account before saving this adjustment.",
      });
    }

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

    const { data: previous } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,final_qbo_account_id,final_qbo_account_name,suggested_qbo_account_id,suggested_qbo_account_name,qbo_txn_id,qbo_txn_type,post_after,meta")
      .eq("business_id", run.business_id)
      .eq("transaction_id", transactionId)
      .maybeSingle();

    if (String(previous?.status || "").toLowerCase() === "posted" && !previous?.qbo_txn_id) {
      return res.status(409).json({
        ok: false,
        error: "posted_transaction_missing_qbo_reference",
        message: "This transaction is marked posted but is missing its QBO transaction reference. Bizzi will not create a second QBO transaction from monthly review.",
      });
    }

    const wasPosted = Boolean(previous?.qbo_txn_id);
    let qboUpdate = null;
    if (previous?.qbo_txn_id) {
      qboUpdate = await updatePostedQboTransactionAccount({
        businessId: run.business_id,
        qboTxnId: previous.qbo_txn_id,
        qboTxnType: previous.qbo_txn_type,
        accountId,
        accountName,
      });
    }

    const now = new Date().toISOString();
    const updatePayload = {
      status: wasPosted ? "posted" : "auto_approved",
      final_qbo_account_id: accountId,
      final_qbo_account_name: accountName,
      reason: req.body?.reason || "Adjusted during monthly human review.",
      updated_at: now,
      post_after: wasPosted ? previous?.post_after || null : now,
      post_error: null,
      meta: {
        ...(previous?.meta || {}),
        monthly_review_adjusted: true,
        monthly_review_run_id: runId,
        monthly_review_adjusted_at: now,
        monthly_review_approved_for_posting: !wasPosted,
        monthly_review_qbo_update: qboUpdate,
      },
    };

    let updated = null;
    if (previous) {
      const { data, error } = await supabase
        .from("transaction_categorizations")
        .update(updatePayload)
        .eq("business_id", run.business_id)
        .eq("transaction_id", transactionId)
        .select("*")
        .single();
      if (error) throw error;
      updated = data;
    } else {
      const { data, error } = await supabase
        .from("transaction_categorizations")
        .insert({
          business_id: run.business_id,
          transaction_id: transactionId,
          ...updatePayload,
          created_at: now,
        })
        .select("*")
        .single();
      if (error) throw error;
      updated = data;
    }

    await logAuditEvent({
      run,
      actor: req.user,
      eventType: "source_transaction_account_adjusted",
      sectionKey: "books",
      previousValue: {
        transaction_id: transactionId,
        final_qbo_account_id: previous?.final_qbo_account_id || null,
        final_qbo_account_name: previous?.final_qbo_account_name || null,
      },
      nextValue: {
        transaction_id: transactionId,
        final_qbo_account_id: accountId,
        final_qbo_account_name: accountName,
        amount: bankTxn.amount,
        date: bankTxn.date,
        qbo_update: qboUpdate,
      },
      notes: req.body?.reason || `Moved transaction to ${accountName}.`,
    });

    let postingSummary = null;
    if (!wasPosted) {
      postingSummary = await runBooksPostOnce({ businessId: run.business_id, force: true });
      if (postingSummary?.ok === false) {
        throw new Error(postingSummary?.error || "qbo_posting_failed_after_monthly_review_adjustment");
      }
      await logAuditEvent({
        run,
        actor: req.user,
        eventType: "source_transaction_queued_for_qbo_posting",
        sectionKey: "books",
        nextValue: {
          transaction_id: transactionId,
          posting_summary: postingSummary,
        },
        notes: "Monthly review adjustment approved and sent through QBO posting.",
      });
    }

    const summaries = await buildSummaries(run.business_id, run.review_month);
    await syncRunStatus(runId, summaries);
    res.json({ ok: true, transaction_id: transactionId, categorization: updated, qbo_update: qboUpdate, posting_summary: postingSummary });
  } catch (e) {
    console.error("[monthly-review] account adjustment failed", e?.message || e);
    res.status(500).json({ ok: false, error: "monthly_review_account_adjustment_failed", message: e?.message || "Could not update transaction account." });
  }
});

router.post("/runs/:runId/transactions/:transactionId/retry-qbo-sync", async (req, res) => {
  try {
    const { runId, transactionId } = req.params;
    if (!UUID_RE.test(String(runId))) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

    const run = await fetchRun(runId);
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
      const { error } = await supabase
        .from("transaction_categorizations")
        .update({
          status: "auto_approved",
          final_qbo_account_id: accountId,
          final_qbo_account_name: accountName,
          post_after: now,
          post_error: null,
          meta: {
            ...(current.meta || {}),
            monthly_review_retry_at: now,
            monthly_review_approved_for_posting: true,
          },
          updated_at: now,
        })
        .eq("business_id", run.business_id)
        .eq("transaction_id", transactionId);
      if (error) throw error;
      postingSummary = await runBooksPostOnce({ businessId: run.business_id, force: true });
      if (postingSummary?.ok === false) throw new Error(postingSummary?.error || "qbo_retry_posting_failed");
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
    res.status(500).json({ ok: false, error: "monthly_review_retry_qbo_sync_failed", message: e?.message || "Could not retry QBO sync." });
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

async function requireInternalAdmin(req, res, next) {
  try {
    const email = String(req.user?.email || "").toLowerCase();
    const allowedEmails = new Set(
      String(process.env.BIZZY_INTERNAL_ADMIN_EMAILS || process.env.BIZZY_ADMIN_EMAILS || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    );

    if (allowedEmails.has(email)) return next();

    const { data, error } = await supabase
      .from("user_profiles")
      .select("email")
      .eq("id", req.user.id)
      .maybeSingle();
    if (error) throw error;

    const profileEmail = String(data?.email || email).toLowerCase();
    if (allowedEmails.has(profileEmail)) {
      return next();
    }

    return res.status(403).json({ ok: false, error: "forbidden_internal_admin_only" });
  } catch (e) {
    console.error("[monthly-review] admin check failed", e?.message || e);
    return res.status(403).json({ ok: false, error: "forbidden_internal_admin_only" });
  }
}

function normalizeMonth(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (match) return `${match[1]}-${match[2]}-01`;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
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

  const allowedEmails = new Set(
    String(process.env.BIZZY_INTERNAL_ADMIN_EMAILS || process.env.BIZZY_ADMIN_EMAILS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );

  const { data, error } = await supabase
    .from("user_profiles")
    .select("id,email")
    .ilike("email", normalizedEmail)
    .maybeSingle();
  if (error) throw error;

  const profileEmail = String(data?.email || normalizedEmail).toLowerCase();
  if (allowedEmails.has(profileEmail)) {
    return { id: data?.id || null, email: profileEmail, role: "internal_admin" };
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
  const txnIds = bankRows.map((row) => row.id).filter(Boolean);
  const catRows = txnIds.length
    ? await safeRows(() =>
        supabase
          .from("transaction_categorizations")
          .select("transaction_id,status,suggested_qbo_account_id,suggested_qbo_account_name,final_qbo_account_id,final_qbo_account_name,qbo_txn_id,qbo_txn_type,posted_at,post_after,confidence,reason,post_error,meta")
          .eq("business_id", businessId)
          .in("transaction_id", txnIds),
        "Monthly source ledger categorizations"
      )
    : [];
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
      bank_account: row.plaid_account_id || null,
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
      books_review_tab: deriveBooksReviewTab(cat),
      final_qbo_account_id: cat.final_qbo_account_id || null,
      final_qbo_account_name: cat.final_qbo_account_name || null,
      suggested_qbo_account_id: cat.suggested_qbo_account_id || null,
      suggested_qbo_account_name: cat.suggested_qbo_account_name || null,
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
      acc.qbo_sync_counts[txn.qbo_sync_status?.key || "not_posted"] = (acc.qbo_sync_counts[txn.qbo_sync_status?.key || "not_posted"] || 0) + 1;
      if (Array.isArray(txn.materiality_flags) && txn.materiality_flags.length) acc.materiality_count += 1;
    });
    return acc;
  }, { transaction_count: 0, total_amount: 0, needs_review_count: 0, post_error_count: 0, posted_count: 0, uncategorized_count: 0, materiality_count: 0, qbo_sync_counts: {} });

  const reconciliationTrace = accountGroups
    .flatMap((group) => group.transactions || [])
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .map((txn) => ({
      id: `recon-${txn.id}`,
      transaction_id: txn.id,
      plaid_transaction_id: txn.plaid_transaction_id || null,
      plaid_date: txn.date,
      payee: txn.payee || txn.description || "",
      description: txn.description || "",
      amount: txn.amount || 0,
      bank_account: txn.bank_account || txn.plaid_account_id || "Plaid account",
      bizzi_gl_account: txn.effective_account_name || "Uncategorized",
      qbo_txn_id: txn.qbo_txn_id || null,
      qbo_sync_status: txn.qbo_sync_status,
      match_confidence: txn.qbo_sync_status?.key === "updated_in_qbo"
        ? "high"
        : txn.qbo_sync_status?.key === "queued"
          ? "medium"
          : txn.qbo_sync_status?.key === "failed"
            ? "low"
            : "pending",
    }));
  const reconciliationTotals = reconciliationTrace.reduce((acc, row) => {
    acc.plaid_count += 1;
    if (row.qbo_sync_status?.key === "updated_in_qbo") acc.matched_qbo_count += 1;
    if (["queued", "not_posted"].includes(row.qbo_sync_status?.key)) acc.pending_count += 1;
    if (row.qbo_sync_status?.key === "failed" || row.match_confidence === "low") acc.exception_count += 1;
    return acc;
  }, { plaid_count: 0, matched_qbo_count: 0, pending_count: 0, exception_count: 0 });

  return {
    totals,
    warnings,
    source_contract: {
      source_tables: ["bank_transactions", "transaction_categorizations"],
      date_basis: "bank_transactions.date",
      status_basis: "Books Review needs_review/handled/posted semantics",
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

async function updatePostedQboTransactionAccount({
  businessId,
  qboTxnId,
  qboTxnType,
  accountId,
  accountName,
}) {
  const txnType = normalizeQboTxnType(qboTxnType);
  if (!txnType) throw new Error("missing_qbo_txn_type");
  if (txnType === "CreditCardPayment") {
    throw new Error("qbo_credit_card_payment_account_change_not_supported");
  }
  if (!["Purchase", "Deposit", "CreditCardCharge"].includes(txnType)) {
    throw new Error(`unsupported_qbo_txn_type_${txnType}`);
  }

  const qbo = await getQBOClient(businessId);
  if (!qbo) throw new Error("qbo_client_unavailable");

  const baseTxn = await fetchQboTransaction(qbo, txnType, qboTxnId);
  if (!baseTxn?.Id && !baseTxn?.id) throw new Error("qbo_transaction_not_found");

  const updatedTxn = rewriteQboTransactionAccount(baseTxn, txnType, accountId, accountName);
  await updateQboTransaction(qbo, txnType, updatedTxn);

  return {
    ok: true,
    qbo_txn_id: qboTxnId,
    qbo_txn_type: txnType,
    final_qbo_account_id: accountId,
    final_qbo_account_name: accountName,
    updated_at: new Date().toISOString(),
  };
}

function normalizeQboTxnType(value = "") {
  const normalized = String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized === "purchase") return "Purchase";
  if (normalized === "deposit") return "Deposit";
  if (normalized === "creditcardcharge" || normalized === "creditcardexpense") return "CreditCardCharge";
  if (normalized === "creditcardpayment") return "CreditCardPayment";
  return value ? String(value) : "";
}

async function fetchQboTransaction(qbo, txnType, txnId) {
  const directMethod = `get${txnType}`;
  const candidates = [
    typeof qbo?.[directMethod] === "function" ? qbo[directMethod].bind(qbo) : null,
    nestedQboMethod(qbo, txnType, "get"),
    nestedQboMethod(qbo, txnType, "findById"),
  ].filter(Boolean);
  if (!candidates.length) throw new Error(`qbo_get_not_supported_${txnType}`);
  let lastError = null;
  for (const fn of candidates) {
    try {
      return await new Promise((resolve, reject) => {
        fn(txnId, (err, resp) => {
          if (err) return reject(err);
          resolve(unwrapQboTransactionResponse(resp, txnType));
        });
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error(`qbo_get_failed_${txnType}`);
}

async function updateQboTransaction(qbo, txnType, payload) {
  const directMethod = `update${txnType}`;
  const candidates = [
    typeof qbo?.[directMethod] === "function" ? qbo[directMethod].bind(qbo) : null,
    nestedQboMethod(qbo, txnType, "update"),
  ].filter(Boolean);
  if (!candidates.length) throw new Error(`qbo_update_not_supported_${txnType}`);
  let lastError = null;
  for (const fn of candidates) {
    try {
      return await new Promise((resolve, reject) => {
        fn(payload, (err, resp) => {
          if (err) return reject(err);
          resolve(resp);
        });
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error(`qbo_update_failed_${txnType}`);
}

function nestedQboMethod(qbo, txnType, method) {
  const keys = {
    Purchase: ["purchase"],
    Deposit: ["deposit"],
    CreditCardCharge: ["creditcardcharge", "creditCardCharge"],
    CreditCardPayment: ["creditcardpayment", "creditCardPayment"],
  }[txnType] || [];
  for (const key of keys) {
    if (typeof qbo?.[key]?.[method] === "function") return qbo[key][method].bind(qbo[key]);
  }
  return null;
}

function unwrapQboTransactionResponse(resp, txnType) {
  if (!resp || typeof resp !== "object") return resp;
  return resp[txnType] || resp[txnType.charAt(0).toLowerCase() + txnType.slice(1)] || resp;
}

function rewriteQboTransactionAccount(baseTxn, txnType, accountId, accountName) {
  const accountRef = { value: String(accountId), ...(accountName ? { name: accountName } : {}) };
  let changed = false;
  const payload = {
    ...baseTxn,
    Sparse: true,
    Id: baseTxn.Id || baseTxn.id,
    SyncToken: baseTxn.SyncToken,
  };

  if (Array.isArray(payload.Line)) {
    payload.Line = payload.Line.map((line) => {
      if (txnType === "Deposit" && line.DepositLineDetail) {
        changed = true;
        return {
          ...line,
          DepositLineDetail: {
            ...line.DepositLineDetail,
            AccountRef: accountRef,
          },
        };
      }
      if (line.AccountBasedExpenseLineDetail) {
        changed = true;
        return {
          ...line,
          AccountBasedExpenseLineDetail: {
            ...line.AccountBasedExpenseLineDetail,
            AccountRef: accountRef,
          },
        };
      }
      return line;
    });
  }

  if (!changed) throw new Error(`qbo_transaction_has_no_editable_account_line_${txnType}`);
  return payload;
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
          .select("id,status,issue_type,reason,plaid_account_id")
          .eq("business_id", businessId)
          .eq("run_id", run.id),
        "Reconciliation items"
      )
    : [];

  const kpis = buildReconciliationKpis(run, items);
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
    raw: { run, runStatus, exceptionCount, missingInQbo, failedPost, ...kpis },
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

function buildReconciliationKpis(run, items = []) {
  const count = (value) => Number(value || 0);
  const countItemsByStatus = (statuses) => {
    const statusSet = new Set(Array.isArray(statuses) ? statuses : [statuses]);
    return items.filter((item) => statusSet.has(String(item.status || item.issue_type || "").toLowerCase())).length;
  };

  const plaidTotal = run ? count(run.total_seen) || items.length : 0;
  const fullyReconciled = run ? count(run.matched_count) : countItemsByStatus("matched");
  const needsGlCategory = run ? count(run.needs_review_count) : countItemsByStatus("needs_review");
  const duplicateInQbo = run ? count(run.duplicate_in_qbo_count) : countItemsByStatus("duplicate_in_qbo");
  const failedPosting = run ? count(run.failed_post_count) : countItemsByStatus("failed_post");
  const missingInQbo = run ? count(run.missing_in_qbo_count) : countItemsByStatus("missing_in_qbo");
  const postedToQbo = fullyReconciled + duplicateInQbo;
  const issueStatuses = ["missing_in_qbo", "failed_post", "needs_review", "mismatch", "duplicate", "duplicate_in_qbo", "unmatched", "warning"];
  const exceptionCount = run
    ? needsGlCategory + missingInQbo + failedPosting + duplicateInQbo
    : countItemsByStatus(issueStatuses);

  return {
    plaidTotal,
    categorized: Math.max(0, plaidTotal - needsGlCategory),
    needsGlCategory,
    postedToQbo,
    fullyReconciled,
    failedPosting,
    missingInQbo,
    duplicateInQbo,
    exceptionCount,
  };
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
  const status = String(cat.status || "").toLowerCase();
  if (cat.post_error || ["failed", "failed_post", "post_failed", "blocked"].includes(status)) {
    return {
      key: "failed",
      label: "Failed",
      tone: "danger",
      detail: cat.post_error || "QBO posting failed.",
    };
  }
  if (cat.qbo_txn_id) {
    const adjusted = cat.meta?.monthly_review_qbo_update?.ok === true || cat.meta?.monthly_review_adjusted === true;
    return {
      key: "updated_in_qbo",
      label: adjusted ? "Updated in QBO" : "Posted in QBO",
      tone: "good",
      detail: `${cat.qbo_txn_type || "QBO transaction"} ${cat.qbo_txn_id}`,
    };
  }
  if (["approved", "auto_approved"].includes(status) || cat.post_after) {
    return {
      key: "queued",
      label: "Queued",
      tone: "warning",
      detail: cat.post_after ? `Queued for ${formatDateTime(cat.post_after)}` : "Queued for QBO posting.",
    };
  }
  return {
    key: "not_posted",
    label: "Not posted",
    tone: "neutral",
    detail: "No QBO transaction has been created yet.",
  };
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
        qbo_sync_key: txn.qbo_sync_status?.key || "not_posted",
        qbo_txn_id: txn.qbo_txn_id || null,
      })),
    })),
  };
}

function buildFinalizationGuard(sourceLedger = {}) {
  const groups = Array.isArray(sourceLedger.account_groups) ? sourceLedger.account_groups : [];
  const blockers = [];
  for (const group of groups) {
    for (const txn of group.transactions || []) {
      const syncKey = txn.qbo_sync_status?.key || "not_posted";
      const label = `${txn.payee || txn.description || txn.id} ${txn.date ? `(${txn.date})` : ""}`.trim();
      if (!txn.effective_account_id && !txn.effective_account_name) {
        blockers.push({ type: "missing_gl_account", transaction_id: txn.id, label, message: "Missing GL account." });
      }
      if (syncKey === "failed") {
        blockers.push({ type: "qbo_failed", transaction_id: txn.id, label, message: txn.post_error || "QBO sync failed." });
      }
      if (syncKey === "queued") {
        blockers.push({ type: "qbo_queued", transaction_id: txn.id, label, message: "QBO sync is still queued." });
      }
      if (syncKey === "not_posted") {
        blockers.push({ type: "qbo_not_posted", transaction_id: txn.id, label, message: "Transaction has not been posted or updated in QBO." });
      }
    }
  }

  return {
    can_finalize: blockers.length === 0,
    blocker_count: blockers.length,
    blockers: blockers.slice(0, 80),
    counts: blockers.reduce((acc, blocker) => {
      acc[blocker.type] = (acc[blocker.type] || 0) + 1;
      return acc;
    }, {}),
  };
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
      ? ((syncCounts.failed || syncCounts.queued || syncCounts.not_posted) ? "attention" : "synced")
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
