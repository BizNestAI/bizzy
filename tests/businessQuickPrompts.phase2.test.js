import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUSINESS_QUICK_PROMPT_REGISTRY_VERSION,
  NON_TAX_BUSINESS_QUICK_PROMPTS,
  TAX_BUSINESS_QUICK_PROMPTS,
  resolveCanonicalBusinessQuickPrompt,
} from "../src/config/businessQuickPrompts.js";
import { invalidateLegacyQuickPromptCaches, resolveStoredQuickPrompt } from "../src/services/prompts/quickPromptService.js";
import { buildBusinessQuickPromptEvidence, buildCanonicalEvidenceInstruction } from "../src/api/gpt/businessQuickPromptExecution.js";
import { getSanitizedReportingStatus, verifyAndActivateReportingConfiguration } from "../src/services/evidence/reportingConfigurationApiService.js";

const read = (path) => readFileSync(path, "utf8");
const NON_TAX = [
  ["financial_month_performance", "How did my business perform this month?"],
  ["financial_income_categories", "Which income categories brought in the most revenue?"],
  ["financial_expense_categories", "Which expense categories cost me the most?"],
  ["financial_period_changes", "What changed most compared with last month?"],
];
const TAX = [
  ["tax_ytd_book_profit", "What is my year-to-date book profit?"],
  ["tax_transactions_needing_review", "Which tax-related transactions need review?"],
  ["tax_professional_readiness", "Are my books ready for my tax professional?"],
];

test("canonical versioned Tax and non-Tax registries have the exact launch order", () => {
  assert.equal(BUSINESS_QUICK_PROMPT_REGISTRY_VERSION, "business-quick-prompts-v2");
  assert.deepEqual(NON_TAX_BUSINESS_QUICK_PROMPTS.map(({ intent, text }) => [intent, text]), NON_TAX);
  assert.deepEqual(TAX_BUSINESS_QUICK_PROMPTS.map(({ intent, text }) => [intent, text]), TAX);
  const visible = [...NON_TAX_BUSINESS_QUICK_PROMPTS, ...TAX_BUSINESS_QUICK_PROMPTS].map((row) => row.text).join("\n");
  assert.doesNotMatch(visible, /cash flow|estimated tax|deductions am I missing|save for taxes|top priorities|top 3 risks/i);
});

test("chip and identical typed text resolve alike while mismatches and arbitrary text do not", () => {
  for (const prompt of [...NON_TAX_BUSINESS_QUICK_PROMPTS, ...TAX_BUSINESS_QUICK_PROMPTS]) {
    assert.equal(resolveCanonicalBusinessQuickPrompt({ intent: prompt.intent, text: prompt.text }).prompt.intent, prompt.intent);
    assert.equal(resolveCanonicalBusinessQuickPrompt({ text: prompt.text }).prompt.intent, prompt.intent);
  }
  assert.equal(resolveCanonicalBusinessQuickPrompt({ intent: NON_TAX[0][0], text: NON_TAX[1][1] }).status, "mismatch");
  assert.equal(resolveCanonicalBusinessQuickPrompt({ text: "Can you draft a customer follow-up?" }).status, "general");
});

test("registry version removes legacy cache and obsolete stored selections fail closed", () => {
  const map = new Map([["qp:v1:user:accounting", "old"], [`bizzy:business-quick-prompts:old`, "old"], ["onboarding:prompt-state", "keep"]]);
  const storage = { get length() { return map.size; }, key(index) { return [...map.keys()][index]; }, removeItem(key) { map.delete(key); } };
  invalidateLegacyQuickPromptCaches(storage);
  assert.deepEqual([...map.keys()], ["onboarding:prompt-state"]);
  assert.equal(resolveStoredQuickPrompt("What’s my top expense?"), null);
  assert.equal(resolveStoredQuickPrompt({ intent: NON_TAX[0][0], text: NON_TAX[0][1] }).intent, NON_TAX[0][0]);
});

test("financial execution accepts only tenant-bound Cash reconciled Phase 1 packages", async () => {
  const row = { id: "pkg", schema_version: "business-evidence-package-v1", intent: NON_TAX[0][0], business_id: "biz", period: { start: "2026-10-01", end: "2026-10-14", is_partial: true }, comparison_period: null, accounting_basis: "Cash", currency: "USD", sources: [{ type: "qbo_profit_and_loss", refreshed_at: "2026-10-14T12:00:00Z" }], completeness: "complete", reconciliation: { status: "reconciled", difference: "0.00" }, formula_version: "financial-evidence-v1", metrics: { revenue: "100.00" }, warnings: [] };
  const result = await buildBusinessQuickPromptEvidence({ db: {}, businessId: "biz", intent: row.intent, requestId: "req", builders: { financial: async () => row } });
  assert.equal(result.projection.accounting_basis, "Cash");
  assert.deepEqual(result.provenance.sources, ["QuickBooks Profit and Loss"]);
  assert.match(buildCanonicalEvidenceInstruction(result.projection), /Do not recalculate, replace, extrapolate, rank again, or invent/);
  await assert.rejects(() => buildBusinessQuickPromptEvidence({ db: {}, businessId: "other", intent: row.intent, requestId: "req", builders: { financial: async () => row } }), /evidence_identity_invalid/);
  await assert.rejects(() => buildBusinessQuickPromptEvidence({ db: {}, businessId: "biz", intent: row.intent, requestId: "req", builders: { financial: async () => ({ ...row, accounting_basis: "Accrual" }) } }), /cash_basis_required/);
});

test("sanitized status omits realm and setup uses server provider identity plus RPC only", async () => {
  const calls = [];
  const config = { status: "verified", qbo_realm_id: "hidden", provider_schema_version: "75", reporting_timezone: "America/New_York", home_currency: "USD", realm_verified_at: "r", currency_verified_at: "c", timezone_confirmed_at: "t", verified_at: "v", updated_at: "u" };
  const db = { from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: config, error: null }; } }; }, async rpc(name, args) { calls.push([name, args]); return { data: config, error: null }; } };
  const status = await getSanitizedReportingStatus({ db, businessId: "biz" });
  assert.equal(status.ready, true); assert.equal(status.currency, "USD"); assert.equal("qbo_realm_id" in status, false);
  await verifyAndActivateReportingConfiguration({ db, businessId: "biz", timezone: "America/New_York", requestId: "req", actorUserId: "user", verifyProvider: async () => ({ realmId: "server-realm", currency: "USD", schemaVersion: "75" }) });
  assert.deepEqual(calls.map(([, args]) => args.p_action), ["verify_qbo_identity", "verify_currency", "confirm_timezone", "activate"]);
  assert.equal(calls[0][1].p_provider_realm_id, "server-realm"); assert.equal(calls[1][1].p_provider_currency, "USD");
});

test("UI and server contracts preserve onboarding and enforce accessible overflow and security ordering", () => {
  const bar = read("src/components/Bizzy/BizzyChatBar.jsx");
  const row = read("src/components/Bizzy/AskBizzyQuickPrompts.jsx");
  const handler = read("src/api/gpt/brain/generateBizzyResponse.js");
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  assert.match(bar, /isOnboardingMode \? ONBOARDING_PROMPTS/);
  assert.match(bar, /intent: canonicalIntent \|\| "general"/);
  assert.match(row, /Previous quick prompts/); assert.match(row, /Next quick prompts/); assert.match(row, /aria-describedby/); assert.match(row, /ArrowLeft/); assert.match(row, /ArrowRight/);
  assert.ok(handler.indexOf("resolveBusinessQuickPromptRequest") < handler.indexOf("reserveChatCredit(supabase"));
  assert.ok(handler.indexOf("canonicalEvidence = await buildBusinessQuickPromptEvidence") < handler.indexOf("orchestration = canonicalQuickPrompt"));
  assert.match(handler, /evidence_package_id: bundle\.canonicalEvidencePackageId/);
  assert.match(settings, /readOnly=\{ownerAdministrationDisabled\}/);
  assert.doesNotMatch(row + bar, /supabaseAdmin|quickbooksTokenService|openai|node-fetch/i);
});
