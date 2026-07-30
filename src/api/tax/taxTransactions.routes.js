// /src/api/tax/taxTransactions.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import {
  getPostedTransactionForTax,
  getPostedTransactionSourceHealth,
  listPostedTransactionsForTax,
  listUnclassifiedPostedTransactions,
} from "../../services/tax/taxPostedTransaction.repository.js";
import { validationError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalTaxYear, validateBusinessIdInput, validatePagination } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/transactions/posted", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const { limit, offset, cursor } = validatePagination(req.query);
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const data = await listPostedTransactionsForTax({
      supabase,
      businessId,
      taxYear,
      dateFrom: optionalDate(req.query.dateFrom ?? req.query.date_from, "dateFrom"),
      dateTo: optionalDate(req.query.dateTo ?? req.query.date_to, "dateTo"),
      accountId: req.query.accountId || req.query.account_id || req.query.plaid_account_id || null,
      qboAccountId: req.query.qboAccountId || req.query.qbo_account_id || null,
      direction: req.query.direction || null,
      search: req.query.search || null,
      limit,
      offset,
      cursor,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_transactions_failed");
  }
});

router.get("/transactions/posted/:transactionId", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const transactionId = req.params.transactionId;
    if (!transactionId) throw validationError("missing_transaction_id", "transactionId is required.");
    const data = await getPostedTransactionForTax({ supabase, businessId, transactionId });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_transaction_failed");
  }
});

router.get("/transactions/unclassified", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const { limit, offset, cursor } = validatePagination(req.query);
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const data = await listUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit, offset, cursor });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_unclassified_transactions_failed");
  }
});

router.get("/transactions/source-health", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const data = await getPostedTransactionSourceHealth({ supabase, businessId, taxYear });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_transaction_source_health_failed");
  }
});

export default router;
