import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { projectMonthlyReportState } from "../src/services/accounting/monthlyReportStateService.js";
import { buildAccountingCloseFinalizationGuard, buildApprovalReadinessProjection } from "../src/api/admin/monthlyReviewCloseGuard.js";

const snapshot = { id: "snapshot-current", raw_hash: "hash-current", metadata: { financial_content: { fingerprint: "qbo-pnl-financial-content-v1:current" } } };
const published = {
  id: "report-1",
  storage_path: "business/2026-09-pnl.pdf",
  monthly_review_published_at: "2026-10-15T03:28:42.903Z",
  publication_status: "published",
};

test("monthly report state only calls a publication current when durable source identity matches", () => {
  assert.equal(projectMonthlyReportState({ report: null, currentSnapshot: snapshot }).status, "not_published");
  assert.equal(projectMonthlyReportState({ report: { ...published, publication_status: "publishing" }, currentSnapshot: snapshot }).status, "publishing");
  assert.equal(projectMonthlyReportState({ report: { ...published, publication_status: "failed" }, currentSnapshot: snapshot }).status, "publication_failed");
  assert.equal(projectMonthlyReportState({ report: published, currentSnapshot: snapshot }).status, "published_legacy_unverified");
  const oldSource = { id: "snapshot-old" };
  assert.equal(projectMonthlyReportState({ report: { ...published, monthly_review_source_snapshot_id: "snapshot-old", monthly_review_source_fingerprint: "qbo-pnl-financial-content-v1:old" }, sourceSnapshot: oldSource, currentSnapshot: snapshot }).status, "published_outdated");
  assert.equal(projectMonthlyReportState({ report: { ...published, monthly_review_source_snapshot_id: "snapshot-old", monthly_review_source_fingerprint: "qbo-pnl-financial-content-v1:current" }, sourceSnapshot: oldSource, currentSnapshot: snapshot }).status, "published_current");
});

test("approval guard uses canonical feed membership and does not relabel matched or excluded rows", () => {
  const sourceLedger = { account_groups: [{ transactions: [
    { id: "excluded-1", description: "Excluded", qbo_lifecycle_status: { key: "needs_review" } },
    { id: "matched-1", description: "Matched", qbo_lifecycle_status: { key: "not_posted" } },
    { id: "review-1", description: "Actual review" },
    { id: "pending-1", description: "Pending" },
  ] }] };
  const guard = buildAccountingCloseFinalizationGuard({
    sourceLedger,
    canonicalFeedState: {
      status_by_transaction_id: { "excluded-1": "excluded", "matched-1": "matched", "review-1": "needs_review", "pending-1": "pending" },
      needs_review_rows: [{ id: "review-1", description: "Actual review" }],
    },
  });
  assert.equal(guard.counts.needs_review_transactions, 1);
  assert.equal(guard.counts.pending_transactions, 1);
  assert.equal(guard.blocker_count, 2);
  assert.equal(guard.blockers.some((row) => row.transaction_id === "excluded-1" || row.transaction_id === "matched-1"), false);
  const readiness = buildApprovalReadinessProjection({ businessId: "business-1", month: "2026-09-01", timezone: "America/New_York", guard, reportState: { status: "published_current" } });
  assert.deepEqual(readiness.blockers.needs_review.transaction_ids, ["review-1"]);
  assert.equal(readiness.blockers.pending.count, 1);
  assert.equal(readiness.period.end, "2026-09-30");
});

test("MRP publication and approval use shared server state, stable request identity, and scoped UI updates", () => {
  const ui = fs.readFileSync(new URL("../src/pages/Admin/MonthlyReviewConsole.jsx", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../src/api/admin/monthlyReview.routes.js", import.meta.url), "utf8");
  const archive = fs.readFileSync(new URL("../src/api/accounting/pnlPdf.routes.js", import.meta.url), "utf8");
  const archiveUi = fs.readFileSync(new URL("../src/components/Accounting/PNLArchiveViewer.jsx", import.meta.url), "utf8");
  assert.match(ui, /publishRequestIdRef/);
  assert.match(ui, /published_current/);
  assert.match(ui, /View Published P&amp;L/);
  assert.match(routes, /loadCanonicalCloseFeedState/);
  assert.match(routes, /reportState\.status !== "published_current"/);
  assert.match(archive, /getMonthlyReportState/);
  assert.match(archiveUi, /"x-business-id": currentBusiness\.id/);
  assert.match(archiveUi, /Legacy report · freshness not yet verified/);
  assert.match(routes, /reconcile-pnl-source/);
});
