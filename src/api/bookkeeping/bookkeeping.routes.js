import { Router } from "express";
import accountsRoutes from "./routes/bookkeeping.accounts.routes.js";
import transactionsRoutes from "./routes/bookkeeping.transactions.routes.js";
import suggestRoutes from "./routes/bookkeeping.suggest.routes.js";
import approvalsRoutes from "./routes/bookkeeping.approvals.routes.js";
import vendorRulesRoutes from "./routes/bookkeeping.vendorRules.routes.js";
import accountMappingsRoutes from "./routes/bookkeeping.accountMappings.routes.js";
import mappingStatusRoutes from "./routes/bookkeeping.mappingStatus.routes.js";
import reconciliationRoutes from "./routes/bookkeeping.reconciliation.routes.js";
import reconciledTransactionsRoutes from "./routes/bookkeeping.reconciledTransactions.routes.js";
import reconciliationsRoutes from "./routes/bookkeeping.reconciliations.routes.js";
import qboCoaCreateRoutes from "./routes/bookkeeping.qboCoaCreate.routes.js";
import qboPaymentAccountsRoutes from "./routes/bookkeeping.qboPaymentAccounts.routes.js";
import qboVendorsRoutes from "./routes/bookkeeping.qboVendors.routes.js";
import clarificationsRoutes from "./routes/bookkeeping.clarifications.routes.js";

const router = Router();

router.use(accountsRoutes);
router.use(transactionsRoutes);
router.use(suggestRoutes);
router.use(approvalsRoutes);
router.use(vendorRulesRoutes);
router.use(accountMappingsRoutes);
router.use(mappingStatusRoutes);
router.use(reconciliationRoutes);
router.use(reconciledTransactionsRoutes);
router.use(reconciliationsRoutes);
router.use(qboCoaCreateRoutes);
router.use(qboPaymentAccountsRoutes);
router.use(qboVendorsRoutes);
router.use(clarificationsRoutes);

export default router;
