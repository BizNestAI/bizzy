// /src/api/tax/taxClassification.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import {
  classifyAllUnclassifiedPostedTransactions,
  classifyPostedTransactionsBatch,
  previewTaxClassification,
} from "../../services/tax/taxClassificationEngine.js";
import {
  getClassificationCoverage,
  getTaxClassification,
  listTaxClassifications,
} from "../../services/tax/taxClassification.repository.js";
import { countPostedTransactionsForTax } from "../../services/tax/taxPostedTransaction.repository.js";
import { validationError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, validateBusinessIdInput, validatePagination } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();
const MAX_RUN_LIMIT = 100;

router.post("/classifications/preview", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.body?.year ?? req.body?.taxYear, new Date().getFullYear());
    const transactionId = requireTransactionId(req.body?.transactionId ?? req.body?.transaction_id);
    const data = await previewTaxClassification({ supabase, businessId, taxYear, transactionId });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_preview_failed");
  }
});

router.post("/classifications/run", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.body?.year ?? req.body?.taxYear, new Date().getFullYear());
    const force = req.body?.force === true;
    const limit = Math.min(Math.max(Number(req.body?.limit || MAX_RUN_LIMIT), 1), MAX_RUN_LIMIT);
    const transactionIds = Array.isArray(req.body?.transactionIds)
      ? req.body.transactionIds
      : Array.isArray(req.body?.transaction_ids)
        ? req.body.transaction_ids
        : null;

    const data = transactionIds
      ? await classifyPostedTransactionsBatch({
          supabase,
          businessId,
          taxYear,
          transactionIds: transactionIds.slice(0, MAX_RUN_LIMIT).map(String),
          force,
          actorUserId: req.user?.id || null,
        })
      : await classifyAllUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit, cursor: req.body?.cursor || null });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_run_failed");
  }
});

router.get("/classifications/coverage", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const eligiblePostedCount = await countPostedTransactionsForTax({ supabase, businessId, taxYear });
    const data = await getClassificationCoverage({ supabase, businessId, taxYear, eligiblePostedCount });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_coverage_failed");
  }
});

router.get("/classifications/:transactionId", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const row = await getTaxClassification({ supabase, businessId, taxYear, transactionId: req.params.transactionId });
    return sendTaxSuccess(res, row);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_fetch_failed");
  }
});

router.get("/classifications", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const { limit, offset } = validatePagination(req.query);
    const data = await listTaxClassifications({
      supabase,
      businessId,
      taxYear,
      status: req.query.status || null,
      deductibilityStatus: req.query.deductibilityStatus || req.query.deductibility_status || null,
      taxCategory: req.query.taxCategory || req.query.tax_category || null,
      requiresReview: req.query.requiresReview ?? req.query.requires_review,
      search: req.query.search || null,
      limit,
      offset,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classifications_fetch_failed");
  }
});

function requireTransactionId(value) {
  if (!value || typeof value !== "string") {
    throw validationError("missing_transaction_id", "transactionId is required.", { field: "transactionId" });
  }
  return value;
}

export default router;
