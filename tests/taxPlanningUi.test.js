import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { formatMoney, safeAccountLabel } from "../src/components/Tax/Planning/taxPlanningDisplay.js";

test("active Tax frontend does not directly write tax payments or reserve accounts", () => {
  const files = [
    "src/pages/Tax/TaxDashboard.jsx",
    "src/components/Tax/TaxLiabilityPanel.jsx",
    "src/components/Tax/Planning/TaxPlanningPanel.jsx",
    "src/components/Tax/Planning/RecordTaxPaymentModal.jsx",
    "src/components/Tax/Planning/TaxReserveAccountPicker.jsx",
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\.from\(["']tax_payments["']\)\.insert/, file);
    assert.doesNotMatch(source, /\.from\(["']tax_reserve_accounts["']\)/, file);
    assert.doesNotMatch(source, /getAccessToken|sb-\.\*-auth-token/, file);
  }
});

test("tax API client exposes authenticated payment and reserve account mutations", () => {
  const client = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const route = fs.readFileSync("src/api/tax/taxPayment.routes.js", "utf8");
  assert.match(client, /getTaxPayments/);
  assert.match(client, /createTaxPayment/);
  assert.match(client, /updateTaxPayment/);
  assert.match(client, /voidTaxPayment/);
  assert.match(client, /deactivateTaxReserveAccount/);
  assert.match(client, /\/api\/tax\/payments/);
  assert.match(client, /\/api\/tax\/reserve\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/deactivate/);
  assert.match(client, /Idempotency-Key/);
  assert.match(route, /if \(result\.created\)/);
  assert.match(route, /if \(result\.changed\)/);
  assert.match(route, /TAX_CHANGE_TYPES\.PAYMENT_CREATED/);
  assert.match(route, /TAX_CHANGE_TYPES\.PAYMENT_UPDATED/);
  assert.match(route, /TAX_CHANGE_TYPES\.PAYMENT_VOIDED/);
  assert.match(route, /emitTaxDataChanged/);
});

test("planning panel keeps payments and safe harbor without rendering a separate reserve card", () => {
  const panel = fs.readFileSync("src/components/Tax/Planning/TaxPlanningPanel.jsx", "utf8");
  const paymentsCard = fs.readFileSync("src/components/Tax/Planning/TaxPaymentsCard.jsx", "utf8");
  assert.match(panel, /TaxPaymentsCard/);
  assert.match(panel, /TaxSafeHarborSummary/);
  assert.doesNotMatch(panel, /TaxReserveCard/);
  assert.doesNotMatch(panel, /useTaxReserve/);
  assert.match(paymentsCard, /estimatedPayments/);
  assert.match(paymentsCard, /withholding/);
  assert.match(paymentsCard, /extensionPayments/);
  assert.match(paymentsCard, /priorYearCredits/);
  assert.match(paymentsCard, /balanceDuePayments/);
});

test("record payment modal validates jurisdiction, state payments, positive amount, and explicit tax year", () => {
  const modal = fs.readFileSync("src/components/Tax/Planning/RecordTaxPaymentModal.jsx", "utf8");
  const display = fs.readFileSync("src/components/Tax/Planning/taxPlanningDisplay.js", "utf8");
  assert.match(modal, /State is required for state payments/);
  assert.match(modal, /Amount must be greater than zero/);
  assert.match(modal, /Enter a valid tax year/);
  assert.match(modal, /Choose the estimate period/);
  assert.match(modal, /Status: Confirmed from manual entry/);
  assert.match(modal, /Local\/county/);
  assert.match(modal, /Entity\/PTE/);
  assert.match(modal, /taxType/);
  assert.match(modal, /similar tax payment already exists/);
  assert.match(modal, /larger than the current projected remaining liability/);
  assert.match(display, /extension_payment/);
  assert.match(display, /estimated_payment/);
  assert.match(display, /ptet_payment/);
  assert.match(display, /entity_tax_payment/);
  assert.match(display, /Matched to bank transaction/);
  assert.match(modal, /paymentType/);
  assert.match(modal, /submitIdempotencyKey/);
  assert.match(modal, /crypto\.randomUUID/);
  assert.match(modal, /idempotencyKey: submitIdempotencyKey\.current/);
});

test("reserve account picker masks accounts and requires explicit primary selection", () => {
  const picker = fs.readFileSync("src/components/Tax/Planning/TaxReserveAccountPicker.jsx", "utf8");
  assert.match(picker, /Set primary/);
  assert.match(picker, /Manual tracker/);
  assert.match(picker, /No reserve account selected/);
  assert.doesNotMatch(picker, /account_number|routing_number|fullAccount/i);
  assert.equal(safeAccountLabel({ displayName: "Tax Savings", mask: "1234" }), "Tax Savings •••• 1234");
});

test("null reserve and unavailable safe harbor are not formatted as zero", () => {
  const harbor = fs.readFileSync("src/components/Tax/Planning/TaxSafeHarborSummary.jsx", "utf8");
  assert.match(harbor, /Unavailable/);
  assert.doesNotMatch(harbor, /\$0/);
  assert.equal(formatMoney(null), "Not available");
  assert.equal(formatMoney(0), "$0");
});

test("Tax Dashboard keeps payment logging in the trajectory modal without a standalone planning panel", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const trendCard = fs.readFileSync("src/components/Tax/TaxTrendCard.jsx", "utf8");
  const modal = fs.readFileSync("src/components/Tax/Planning/RecordTaxPaymentModal.jsx", "utf8");
  assert.doesNotMatch(dashboard, /TaxPlanningPanel/);
  assert.match(dashboard, /TaxSummaryGrid/);
  assert.match(dashboard, /TaxTrendCard/);
  assert.match(dashboard, /TaxDashboardDeductions/);
  assert.match(trendCard, /Record payment/);
  assert.match(trendCard, /Estimated tax liability/);
  assert.match(modal, /Manually logged payments/);
  assert.match(dashboard, /refreshTaxPaymentState/);
  assert.match(dashboard, /payments\.createPayment\(payment\)/);
  assert.match(dashboard, /tax\.refetch/);
  assert.match(dashboard, /payments\.refetch/);
});

test("tax profile editor is a centered compact modal without a page-blur overlay", () => {
  const modal = fs.readFileSync("src/components/Tax/TaxProfileModal.jsx", "utf8");
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const fields = fs.readFileSync("src/components/Tax/Setup/taxProfileFields.js", "utf8");
  assert.match(dashboard, /Edit Tax Profile/);
  assert.doesNotMatch(dashboard, /TaxDataFreshnessBadge/);
  assert.doesNotMatch(dashboard, /tax-year-select/);
  assert.doesNotMatch(dashboard, /Refresh calculation/);
  assert.match(dashboard, /SetupAttentionTooltip/);
  assert.match(dashboard, /Tax setup needs attention/);
  assert.doesNotMatch(dashboard, /TaxSetupBanner/);
  assert.doesNotMatch(dashboard, /Demo data is active/);
  assert.doesNotMatch(dashboard, /Sources current/);
  assert.match(modal, /grid place-items-center/);
  assert.match(modal, /left-\[var\(--nav-w,0px\)\]/);
  assert.match(modal, /max-w-\[720px\]/);
  assert.match(modal, /font-sans/);
  assert.match(modal, /createPortal\(modal, document\.body\)/);
  assert.match(modal, /setRendered/);
  assert.match(modal, /transition-all duration-200/);
  assert.match(modal, /dark-dropdown/);
  assert.doesNotMatch(modal, /<select/);
  assert.match(modal, /role="combobox"/);
  assert.match(modal, /role="listbox"/);
  assert.match(modal, /open && menuStyle \? createPortal\(/);
  assert.match(modal, /document\.body/);
  assert.match(modal, /z-\[120\]/);
  assert.match(modal, /maxHeight/);
  assert.match(modal, /overflow-y-auto/);
  assert.match(modal, /event\.stopPropagation\(\)/);
  assert.match(fields, /value: "current_year_90"/);
  assert.match(fields, /"NY", "NC", "ND"/);
  assert.match(fields, /\{ value: code, label: code \}/);
  assert.doesNotMatch(modal, /backdrop-blur/);
  assert.doesNotMatch(modal, /fixed right-4 top-24/);
});

test("Tax Dashboard omits the separate Bizzi tax readout card", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.doesNotMatch(dashboard, /TaxNarrativeCard/);
  assert.doesNotMatch(dashboard, /Bizzi tax readout/);
});

test("tax trajectory top KPIs are limited to supportable high-priority metrics", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const trendCard = fs.readFileSync("src/components/Tax/TaxTrendCard.jsx", "utf8");
  assert.match(trendCard, /Projected annual tax/);
  assert.match(trendCard, /Through today/);
  assert.match(trendCard, /Remaining projected liability/);
  assert.match(trendCard, /Recommended reserve/);
  assert.doesNotMatch(trendCard, /Next deadline/);
  assert.match(dashboard, /NextDeadlineText/);
  assert.match(dashboard, /Next Deadline:/);
  assert.match(trendCard, /TaxMetricInfoPopover/);
  assert.match(trendCard, /metric\.definition/);
  assert.match(trendCard, /InfoRow label="Status"/);
  assert.match(trendCard, /InfoRow label="Last calculated"/);
  assert.match(trendCard, /InfoRow label="Limitation"/);
  assert.match(trendCard, /Last calculated/);
  assert.match(trendCard, /workpaperSection: "payment_application_snapshot"/);
  assert.match(trendCard, /workpaperSection: "through_date_tax"/);
  assert.match(trendCard, /workpaperSection: "reserve_bridge"/);
  assert.match(trendCard, /width=\{310\}/);
  assert.match(trendCard, /Estimated total \$\{taxYear/);
  assert.match(trendCard, /This is a planning estimate, not necessarily the amount currently due/);
  assert.match(trendCard, /payments, withholding, and credits/);
  assert.match(trendCard, /This is not your bank balance/);
  assert.equal((trendCard.match(/View calculation/g) || []).length, 1);
  assert.doesNotMatch(trendCard, /How Bizzi calculated it|Inputs included|Inputs excluded|Data sources/);
  assert.doesNotMatch(trendCard, /confirmedRows\.reduce/);
  assert.doesNotMatch(trendCard, /in confirmed payments and credits is reflected in remaining liability and reserve planning/);
  assert.doesNotMatch(trendCard, /label="Paid and withheld"/);
  assert.doesNotMatch(trendCard, /label="Tax reserve"/);
  assert.doesNotMatch(trendCard, /label="Next payment"/);
});

test("Tax Dashboard shows a compact reconciled workpaper preview without frontend tax arithmetic", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /CalculationPreview/);
  assert.match(dashboard, /How we calculated this/);
  assert.match(dashboard, /workpaper\?\.reconciliation\?\.ready/);
  assert.match(dashboard, /Projected business profit/);
  assert.match(dashboard, /Projected annual tax/);
  assert.match(dashboard, /View full calculation/);
  assert.doesNotMatch(dashboard, /projectedAnnualTax.*-|remainingProjectedLiability.*-/);
});

test("Tax Dashboard deductions preview renders a QuickBooks account by month matrix", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /buildDeductionAccountMatrix/);
  assert.match(dashboard, /QuickBooks account/);
  assert.match(dashboard, /Deductible totals by tax category from posted QuickBooks expense transactions/);
  assert.match(dashboard, /Plaid transaction/);
  assert.match(dashboard, /Expense total/);
  assert.match(dashboard, /Deductible amount/);
  assert.match(dashboard, /Sourced from posted QuickBooks GL accounts and Plaid transaction detail/);
  assert.match(dashboard, /Cells show deductible amount, not gross spend/);
  assert.match(dashboard, /fixed bottom-0 left-0 right-0 top-0 z-\[90\]/);
  assert.match(dashboard, /accountKey/);
  assert.match(dashboard, /qboAccountId/);
  assert.match(dashboard, /Unmapped QuickBooks account/);
  assert.match(dashboard, /account\.expenseTotal > 0/);
  assert.match(dashboard, /limit: 100/);
  assert.match(dashboard, /buildDeductionClassificationSummary/);
  assert.match(dashboard, /classificationsRequired/);
  assert.match(dashboard, /posted QuickBooks transactions are awaiting tax classification/);
  assert.match(dashboard, /No deduction total is shown until classification authority exists/);
  assert.doesNotMatch(dashboard, /Confirmed deductible/);
  assert.doesNotMatch(dashboard, /Estimated deductible/);
  assert.doesNotMatch(dashboard, /Top categories/);
  assert.doesNotMatch(dashboard, /Recent tax treatments/);
});

test("Tax trajectory surfaces render unavailable states without fabricating live chart values", () => {
  const trendCard = fs.readFileSync("src/components/Tax/TaxTrendCard.jsx", "utf8");
  const viewModel = fs.readFileSync("src/components/Tax/taxDashboardViewModel.js", "utf8");
  assert.match(trendCard, /surfaceReadiness/);
  assert.match(trendCard, /UnavailablePanel/);
  assert.match(trendCard, /chartUnavailable/);
  assert.match(trendCard, /The tax trajectory will appear after the first completed tax calculation/);
  assert.match(viewModel, /normalizeSurfaceReadiness/);
  assert.match(viewModel, /classificationSummary/);
});
