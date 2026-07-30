// /src/api/tax/deductions.routes.js
import { Router } from "express";
import deductionsSummaryHandler from "./deductionsSummary.js";
import deductionsExportHandler from "./deductionsExport.js";
import deductionsUpsertHandler from "./deductionsUpsert.js";
import { supabase } from "../../services/supabaseAdmin.js";
import {
  getDeductionsOverview,
  getDeductionCategoryDetail,
  getDeductionTransactionDetail,
  listDeductionTransactions,
  normalizeDeductionPagination,
  validateDeductionTransactionFilters,
} from "../../services/tax/taxDeductionsApi.service.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.post("/summary", deductionsSummaryHandler);
router.get("/overview", overviewHandler);
router.get("/transactions", transactionsHandler);
router.get("/transactions/:transactionId", transactionDetailHandler);
router.get("/categories/:taxCategory", categoryDetailHandler);
router.get("/export", deductionsExportHandler);
router.post("/upsert", deductionsUpsertHandler); // internal/admin bookkeeping rollup sync only

export default router;

async function overviewHandler(req, res) {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    const taxYear = optionalTaxYear(req.query?.year, new Date().getFullYear());
    const asOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const data = await getDeductionsOverview({ supabase, businessId, taxYear, asOfDate });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_deductions_overview_failed");
  }
}

async function transactionsHandler(req, res) {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    const taxYear = optionalTaxYear(req.query?.year, new Date().getFullYear());
    const asOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const data = await listDeductionTransactions({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      filters: validateDeductionTransactionFilters(req.query || {}),
      pagination: normalizeDeductionPagination(req.query || {}),
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_deduction_transactions_failed");
  }
}

async function transactionDetailHandler(req, res) {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    const taxYear = optionalTaxYear(req.query?.year, new Date().getFullYear());
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const data = await getDeductionTransactionDetail({
      supabase,
      businessId,
      taxYear,
      transactionId: req.params.transactionId,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_deduction_transaction_failed");
  }
}

async function categoryDetailHandler(req, res) {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    const taxYear = optionalTaxYear(req.query?.year, new Date().getFullYear());
    const asOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const data = await getDeductionCategoryDetail({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      taxCategory: req.params.taxCategory,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_deduction_category_failed");
  }
}
