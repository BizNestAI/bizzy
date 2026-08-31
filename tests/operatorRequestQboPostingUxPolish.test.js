import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} missing`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} missing`);
  return source.slice(start, end);
}

test("Operator Response approval handles categorization without immediate QBO posting", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const approveBody = sliceBetween(
    route,
    'router.post("/businesses/:businessId/operator-responses/:requestId/approve"',
    '\nrouter.post("/runs/:runId/lock"'
  );

  assert.match(approveBody, /approveBookkeepingTransactions\(/);
  assert.match(approveBody, /requireNeedsReview:\s*true/);
  assert.match(approveBody, /resolved_transaction_status:\s*"approved"/);
  assert.doesNotMatch(approveBody, /postSingleBookkeepingTransactionNow|runBooksPostOnce|postToQbo|claim_qbo_posting_intent/);
});

test("Auto-post policy remains explicit and approval grace uses the configured 24-hour period", () => {
  const approvalService = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const autoPostRoute = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");
  const autoPostService = read("src/services/bookkeeping/autoPostControl.js");

  assert.match(approvalService, /const autoPostEnabled = await getAutoPostToQuickBooks\(db,\s*businessId\)/);
  assert.match(approvalService, /computePostAfterForAutoPost\(autoPostEnabled,\s*24\)/);
  assert.match(autoPostRoute, /getAutoPostSettings\(\{ db: supabase, businessId, graceHours: POSTING_GRACE_HOURS \}\)/);
  assert.match(autoPostRoute, /setAutoPostEnabled\(\{[\s\S]*graceHours: POSTING_GRACE_HOURS/);
  assert.match(autoPostService, /posting_grace_hours:\s*normalizedGraceHours/);
  assert.match(autoPostService, /post_after:\s*nextEnabled \? postAfter : null/);
});

test("Monthly Review QBO labels distinguish Handled from Posted and scheduled queue state", () => {
  const monthly = read("src/api/admin/monthlyReview.routes.js");
  const mirror = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const lifecycle = read("src/services/bookkeeping/qboPostingLifecycle.js");
  const statusBody = sliceBetween(monthly, "function deriveQboSyncStatus", "function deriveBooksReviewTab");
  const mirrorStatusBody = sliceBetween(mirror, "export function deriveMirrorQboPostingStatus", "function qboBadgeClass");

  assert.match(statusBody, /return deriveQboPostingLifecycle\(cat\)/);
  assert.match(lifecycle, /if \(hasQboTxn\)/);
  assert.match(lifecycle, /key:\s*"posted"/);
  assert.match(lifecycle, /key:\s*"queued"/);
  assert.match(lifecycle, /label:\s*"Handled · Not posted"/);
  assert.match(lifecycle, /key:\s*"needs_review"/);
  assert.doesNotMatch(lifecycle, /post_error[\s\S]{0,120}hasQboTxn/);

  assert.match(mirrorStatusBody, /return deriveQboPostingLifecycle\(row\)/);
});

test("Operator Request submission removes confirmed rows locally before silent revalidation", () => {
  const statusCard = read("src/components/Bizzy/OperatorStatusCard.jsx");
  const panel = read("src/components/Bizzy/OperatorRequestsPanel.jsx");
  const chatHome = read("src/pages/Bizzy/ChatHome.jsx");

  const submitOneBody = sliceBetween(statusCard, "const submitOne = async", "\n  if (!effectiveCount");
  assert.match(statusCard, /import \{ AnimatePresence, motion \} from "framer-motion"/);
  assert.match(submitOneBody, /persistedIds\.has\(String\(req\.id\)\)/);
  assert.match(submitOneBody, /setRequests\(\(prev\) => prev\.filter\(\(r\) => r\.id !== req\.id\)\)/);
  assert.match(submitOneBody, /revalidateSilently\(\)/);
  assert.doesNotMatch(submitOneBody, /await onRefresh\(\)/);
  assert.match(statusCard, /setRowErrors\(\(prev\) => \(\{ \.\.\.prev, \[req\.id\]: summarizeClarificationSubmitFailure/);
  assert.match(statusCard, /disabled=\{rowSubmitting\}/);

  assert.match(panel, /onSubmitted=\{\(persistedIds\) =>/);
  assert.match(panel, /setRequests\(\(prev\) => prev\.filter\(\(row\) => !persistedIds\.has\(String\(row\.id\)\)\)\)/);
  assert.match(panel, /load\(page,\s*\{ silent: true \}\)/);

  assert.match(chatHome, /const loadNeedsReviewRequests = useCallback\(async \(options = \{\}\)/);
  assert.match(chatHome, /const silent = options\?\.silent === true/);
  assert.match(chatHome, /onRefresh=\{\(\) => loadNeedsReviewRequests\(\{ silent: true \}\)\}/);
});
