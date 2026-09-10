import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const modalOverlayFiles = [
  "src/pages/Tax/TaxDashboard.jsx",
  "src/components/Tax/TaxProfileModal.jsx",
  "src/components/Tax/Setup/TaxSetupWorkflow.jsx",
  "src/components/Tax/Planning/RecordTaxPaymentModal.jsx",
  "src/components/Tax/Confidence/TaxConfidenceDrawer.jsx",
  "src/components/Tax/Explanations/TaxExplanationDrawer.jsx",
  "src/components/Accounting/CreateQuickBooksAccountModal.jsx",
  "src/components/Accounting/ReconciliationTraceDrawer.jsx",
  "src/components/Accounting/PNLArchiveViewer.jsx",
  "src/pages/accounting/BookkeepingCleanup.jsx",
  "src/pages/Admin/MonthlyReviewConsole.jsx",
  "src/pages/Calendar/EventModal.jsx",
  "src/pages/Calendar/CalendarQuickOpen.jsx",
  "src/pages/Docs/DocDetail.jsx",
  "src/pages/LeadsJobs/JobsDashboard.jsx",
  "src/pages/Marketing/ReplyDrawer.jsx",
  "src/pages/Marketing/ReviewsCsvImport.jsx",
  "src/components/Marketing/EmailPreviewModal.jsx",
  "src/components/Marketing/SchedulePostModal.jsx",
  "src/components/Marketing/EditPostModal.jsx",
  "src/components/Marketing/EmailCampaignGallery.jsx",
  "src/components/Investments/HoldingsTable.jsx",
  "src/components/Investments/WealthMovesPanel.jsx",
  "src/components/Email/ActivityDrawer.jsx",
  "src/components/Bizzy/ChatDrawer.jsx",
  "src/components/Bizzy/OperatorRequestsPanel.jsx",
  "src/components/BizzyDocs/UploadDocModal.jsx",
];

test("shared modal backdrop blurs dashboard content without covering the desktop sidebar", () => {
  const css = read("src/index.css");
  assert.match(css, /\.bizzy-modal-main-backdrop\s*\{/);
  assert.match(css, /backdrop-filter:\s*blur\(10px\)\s*saturate\(120%\)/);
  assert.match(css, /-webkit-backdrop-filter:\s*blur\(10px\)\s*saturate\(120%\)/);
  assert.match(css, /@media \(min-width:\s*768px\)[\s\S]*left:\s*var\(--nav-w,\s*0px\)\s*!important/);
});

test("app modal and drawer overlays opt into the sidebar-safe blur backdrop", () => {
  for (const file of modalOverlayFiles) {
    const source = read(file);
    assert.match(source, /bizzy-modal-main-backdrop/, `${file} should use the shared modal backdrop`);
  }
});

test("legacy fullscreen modal backdrops were not left on primary modal wrappers", () => {
  const legacyWrapperPatterns = [
    ["src/components/Marketing/EmailPreviewModal.jsx", /fixed inset-0[^"]*bg-black bg-opacity-80/],
    ["src/components/Marketing/SchedulePostModal.jsx", /fixed inset-0[^"]*bg-black bg-opacity-70/],
    ["src/components/Marketing/EditPostModal.jsx", /fixed inset-0[^"]*bg-black bg-opacity-70/],
    ["src/components/Accounting/CreateQuickBooksAccountModal.jsx", /fixed inset-0[^"]*bg-black\/70/],
    ["src/pages/Calendar/EventModal.jsx", /fixed inset-0[^"]*bg-black\/70/],
  ];

  for (const [file, pattern] of legacyWrapperPatterns) {
    assert.doesNotMatch(read(file), pattern, `${file} still has an unscoped legacy modal backdrop`);
  }
});
