import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDurableMemoryCandidate,
  containsUnstableMemoryFact,
  isSafeDurableMemoryRow,
  filterSafeDurableMemoryRows,
  DURABLE_MEMORY_POLICY_VERSION,
} from "../src/api/gpt/brain/durableMemoryPolicy.js";
import {
  loadRecentStructuredReferences,
  referencesFromChatContext,
  STRUCTURED_REFERENCE_MAX_AGE_DAYS,
  STRUCTURED_REFERENCE_MAX_MESSAGE_DISTANCE,
} from "../src/api/gpt/orchestration/recentStructuredReferences.js";
import { applyMainChatContextBudget } from "../src/api/gpt/brain/chatCostControls.js";
import { HISTORY_AUTHORITY_INSTRUCTION, labelOlderConversationDigest, sortConversationMessages } from "../src/utils/conversationMessageOrder.js";

const source = readFileSync("src/api/gpt/brain/generateBizzyResponse.js", "utf8");
const memorySource = readFileSync("src/api/gpt/brain/bizzyMemoryService.js", "utf8");
const migration = readFileSync("supabase/migrations/20261031_bizzy_durable_memory_safety.sql", "utf8");

test("durable communication preference and explicit business rule are eligible", () => {
  const preference = buildDurableMemoryCandidate({ input_text: "I prefer concise answers with bullets." });
  assert.equal(preference.memory_kind, "communication_preference");
  assert.equal(preference.memory_key, "response_length");
  assert.equal(preference.policy_version, DURABLE_MEMORY_POLICY_VERSION);
  const rule = buildDurableMemoryCandidate({ input_text: "We always require two approvals for purchases." });
  assert.equal(rule.memory_kind, "business_rule");
});

test("approved natural-language durable facts remain eligible after memory directives are removed", () => {
  const accepted = [
    ["Remember that I prefer concise financial explanations.", "communication_preference"],
    ["Keep in mind that I prefer bullet lists.", "communication_preference"],
    ["Remember that we call customers clients.", "terminology_preference"],
    ["Our standing policy is to require written approval before reimbursing an expense.", "business_rule"],
    ["My long-term goal is to open a second location.", "long_term_goal"],
    ["Keep responses short.", "communication_preference"],
    ["Use bullets.", "communication_preference"],
    ["Use bullets", "communication_preference"],
    ["Please always explain things in plain English.", "communication_preference"],
    ["Call vendors suppliers.", "terminology_preference"],
  ];
  for (const [input_text, expectedKind] of accepted) {
    const candidate = buildDurableMemoryCandidate({ input_text });
    assert.equal(candidate?.memory_kind, expectedKind, input_text);
    assert.doesNotMatch(candidate.durable_fact, /^(?:remember|keep in mind)/i);
  }
});

test("remember directives never make unsafe or transient facts durable", () => {
  const rejected = [
    "Remember the Smith job is complete.",
    "Remember that we use cash basis accounting.",
    "Remember we have 10 employees.",
    "Keep in mind I am frustrated today.",
    "Remember our September revenue was $10,000.",
    "Remember this invoice is overdue.",
    "Remember QuickBooks is connected.",
    "Remember that this transaction was posted.",
    "Remember the Adobe charge.",
    "Remember our cash balance.",
    "Remember the forecast for next month.",
  ];
  for (const input_text of rejected) assert.equal(buildDurableMemoryCandidate({ input_text }), null, input_text);
});

test("unstable financial, transaction, invoice, job, and integration facts are excluded", () => {
  const rejected = [
    "Remember that revenue was $82,000 and profit was $12,000.",
    "Remember the Adobe transaction was posted.",
    "Remember invoice 104 is overdue.",
    "Remember the Smith job has a 42% margin.",
    "Remember that QuickBooks is connected and healthy.",
  ];
  for (const input_text of rejected) {
    assert.equal(buildDurableMemoryCandidate({ input_text }), null, input_text);
    assert.equal(containsUnstableMemoryFact(input_text), true, input_text);
  }
});

test("assistant recommendations, refusals, and operational errors are not durable memory", () => {
  assert.equal(buildDurableMemoryCandidate({ input_text: "What should I do next?" }), null);
  assert.equal(buildDurableMemoryCandidate({ input_text: "Categorize and post this transaction to QBO." }), null);
  assert.equal(buildDurableMemoryCandidate({ input_text: "I prefer brief answers.", operationalError: true }), null);
  assert.equal(buildDurableMemoryCandidate({ input_text: "Remember this." }), null);
  assert.match(source, /bizzy_response: ''/);
  assert.doesNotMatch(source, /bizzy_response: bizzyReply[\s\S]{0,200}memory_kind/);
});

test("retrieval accepts only current durable policy rows and rejects historical financial rows", () => {
  assert.equal(isSafeDurableMemoryRow({ memory_kind: "communication_preference", policy_version: DURABLE_MEMORY_POLICY_VERSION, input_text: "I prefer brief answers.", bizzy_response: "" }), true);
  assert.equal(isSafeDurableMemoryRow({ input_text: "Revenue was $20,000", bizzy_response: "" }), false);
  assert.equal(isSafeDurableMemoryRow({ memory_kind: "business_rule", policy_version: DURABLE_MEMORY_POLICY_VERSION, input_text: "Revenue was $20,000", bizzy_response: "" }), false);
  assert.match(source, /Non-authoritative durable user context/);
  assert.match(source, /Never use it as evidence for current financial/);
});

test("vector and keyword retrieval share the same safe row filter", () => {
  const rows = [
    { id: "safe", memory_kind: "communication_preference", policy_version: DURABLE_MEMORY_POLICY_VERSION, input_text: "I prefer brief answers.", bizzy_response: "" },
    { id: "old", memory_kind: "communication_preference", policy_version: null, input_text: "I prefer old answers.", bizzy_response: "" },
    { id: "financial", memory_kind: "business_rule", policy_version: DURABLE_MEMORY_POLICY_VERSION, input_text: "Revenue was $10,000.", bizzy_response: "" },
  ];
  assert.deepEqual(filterSafeDurableMemoryRows(rows).map((row) => row.id), ["safe"]);
});

test("same-user same-business recall is cross-thread while user and business isolation remain mandatory", () => {
  assert.match(migration, /bm\.user_id = user_uuid/);
  assert.match(migration, /bm\.business_id = business_uuid/);
  assert.doesNotMatch(migration, /bm\.thread_id|source_thread_id\s*=/);
  assert.match(memorySource, /\.eq\('user_id', user_id\)[\s\S]*\.eq\('business_id', business_id\)/);
  assert.match(migration, /bm\.business_id is not null/);
});

test("semantic preference supersession uses deterministic identity metadata", () => {
  const oldPreference = buildDurableMemoryCandidate({ input_text: "I prefer concise answers." });
  const newPreference = buildDurableMemoryCandidate({ input_text: "I prefer detailed answers." });
  assert.equal(oldPreference.memory_key, newPreference.memory_key);
  assert.match(memorySource, /upsert\(row, \{ onConflict: 'user_id,business_id,memory_kind,memory_key' \}\)/);
  assert.match(migration, /bizzy_memory_durable_identity_idx/);
});

test("main thread context keeps twelve full messages in chronological order and a bounded older digest", () => {
  assert.match(source, /\.limit\(24\)/);
  assert.match(source, /safeRecentMessages\.slice\(0, 12\)/);
  assert.match(source, /safeRecentMessages\.slice\(12, 24\)/);
  assert.match(source, /older\.slice\(\)\.reverse\(\)/);
  assert.match(source, /\[\.\.\.recentChat\][\s\S]*\.reverse\(\)/);
  assert.match(labelOlderConversationDigest("older"), /Incomplete historical conversation digest/);
  assert.match(source, /\.eq\('message_kind', 'conversation'\)/);
});

test("current request and system instructions survive protected-content overflow", () => {
  const system = { role: "system", content: "S".repeat(100) };
  const current = { role: "user", content: "EXACT CURRENT REQUEST" };
  const messages = [system, { role: "user", content: "old".repeat(100) }, { role: "assistant", content: "answer".repeat(100) }, current];
  for (const maxChars of [150, 100, 1]) {
    const result = applyMainChatContextBudget(messages, { maxChars, minHistoricalChars: 10 });
    assert.ok(result.messages.includes(system));
    assert.ok(result.messages.includes(current));
    if (maxChars < system.content.length + current.content.length) {
      assert.ok(result.overflow);
      assert.ok(result.overflow_chars > 0);
    }
  }
});

test("tied timestamps sort deterministically with user before assistant and preserve newest twelve", () => {
  const rows = Array.from({ length: 14 }, (_, turn) => [
    { role: "assistant", content: `a${turn}`, created_at: `2026-09-${String(turn + 1).padStart(2, "0")}T12:00:00Z`, message_role_position: 1, message_sequence: turn * 2 + 2 },
    { role: "user", content: `u${turn}`, created_at: `2026-09-${String(turn + 1).padStart(2, "0")}T12:00:00Z`, message_role_position: 0, message_sequence: turn * 2 + 1 },
  ]).flat();
  const chronological = sortConversationMessages(rows);
  assert.deepEqual(chronological.slice(0, 2).map((row) => row.content), ["u0", "a0"]);
  const newestTwelve = sortConversationMessages(rows, { descending: true }).slice(0, 12).reverse();
  assert.deepEqual(newestTwelve.slice(-2).map((row) => row.content), ["u13", "a13"]);
});

test("history instructions make stale financial facts non-authoritative", () => {
  const digest = labelOlderConversationDigest("assistant: September revenue was $10,000.");
  assert.match(digest, /Financial amounts, statuses, dates, and operational facts below are non-authoritative/);
  assert.match(digest, /Current canonical financial and operational context always overrides them/);
  assert.match(HISTORY_AUTHORITY_INSTRUCTION, /Current canonical context from the active loaders overrides conversation history/);
  assert.doesNotMatch(HISTORY_AUTHORITY_INSTRUCTION, /prefer conversation history/i);
});

test("prompt budget preserves systems and current request while trimming history oldest-first", () => {
  const messages = [
    { role: "system", content: "S".repeat(120) },
    { role: "user", content: "old user ".repeat(50) },
    { role: "assistant", content: "old assistant ".repeat(50) },
    { role: "user", content: "CURRENT REQUEST" },
  ];
  const result = applyMainChatContextBudget(messages, { maxChars: 180, minHistoricalChars: 40 });
  assert.equal(result.trimmed, true);
  assert.ok(result.messages.some((message) => message.role === "system"));
  assert.ok(result.messages.some((message) => message.content === "CURRENT REQUEST"));
  assert.ok(result.messages.length < messages.length);
});

function structuredDb(rows, calls = []) {
  const query = {
    select() { return this; },
    eq(field, value) { calls.push([field, value]); return this; },
    order() { return this; },
    limit(value) { calls.push(["limit", value]); return Promise.resolve({ data: rows, error: null }); },
  };
  return { from() { return query; } };
}

test("structured references expire after thirty days", async () => {
  const rows = [{ role: "assistant", message_kind: "conversation", created_at: "2026-08-01T00:00:00Z", structured_references: { merchant: "Adobe" } }];
  const refs = await loadRecentStructuredReferences({ db: structuredDb(rows), businessId: "b", threadId: "t", now: new Date("2026-09-30T00:00:00Z") });
  assert.equal(STRUCTURED_REFERENCE_MAX_AGE_DAYS, 30);
  assert.equal(refs.merchant, null);
});

test("structured references expire beyond the recent twelve-message distance", async () => {
  const calls = [];
  const rows = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", message_kind: "conversation", created_at: "2026-09-30T00:00:00Z", structured_references: null }));
  const refs = await loadRecentStructuredReferences({ db: structuredDb(rows, calls), businessId: "b", threadId: "t", now: new Date("2026-09-30T01:00:00Z") });
  assert.equal(STRUCTURED_REFERENCE_MAX_MESSAGE_DISTANCE, 12);
  assert.ok(calls.some(([field, value]) => field === "limit" && value === 12));
  assert.equal(refs.merchant, null);
});

test("explicit new entities supersede older structured references", () => {
  const previous = { merchant: "Adobe", job: { job_id: "old", canonical_name: "Old Job" }, period: { start_date: "2026-01-01", end_date: "2026-01-31" } };
  const next = referencesFromChatContext({ intent: "transaction_search", entities: { search_text: "Stripe" }, intent_context: { matched_merchant: "Stripe", data: [{ transaction_id: "txn", transaction_date: "2026-09-01", amount: -10 }] } }, previous);
  assert.equal(next.merchant, "Stripe");
  assert.deepEqual(next.transactions.map((row) => row.transaction_id), ["txn"]);
});

test("ambiguous and unmatched explicit jobs clear old references while unrelated turns preserve them", () => {
  const previous = { job: { job_id: "old", canonical_name: "Old Job" } };
  const ambiguous = referencesFromChatContext({ intent: "job_profitability", entities: { job_search: "P&V" }, intent_context: { data: [{ job_id: "a", job_name: "Projection and Video" }, { job_id: "b", job_name: "Photography and Video" }], requires_clarification: true } }, previous);
  assert.equal(ambiguous.job, null);
  const unmatched = referencesFromChatContext({ intent: "job_profitability", entities: { job_search: "Missing Job" }, intent_context: { data: [], requires_clarification: false } }, previous);
  assert.equal(unmatched.job, null);
  const unrelated = referencesFromChatContext({ intent: "financial_summary", entities: {}, intent_context: { data: [] } }, previous);
  assert.equal(unrelated.job.job_id, "old");
});
