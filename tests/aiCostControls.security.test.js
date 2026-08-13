import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMainChatContextBudget,
  buildMainChatUsageTelemetry,
  estimateOpenAICostUsd,
  maybeLogMainChatCostWarning,
  recordMainChatUsage,
} from "../src/api/gpt/brain/chatCostControls.js";

const root = process.cwd();
const chatSource = readFileSync(join(root, "src/api/gpt/brain/generateBizzyResponse.js"), "utf8");
const gptRoutesSource = readFileSync(join(root, "src/api/gpt/brain/gpt.routes.js"), "utf8");
const migration = readFileSync(join(root, "supabase/migrations/20260820_add_ai_cost_observability.sql"), "utf8");

test("main Bizzy chat stays on the configured Terra model and paid cap remains 300", () => {
  assert.match(chatSource, /process\.env\.BIZZY_GPT_MODEL \|\| 'gpt-5\.6-terra'/);
  assert.match(chatSource, /const PAID_CHAT_LIMIT = 300/);
  assert.doesNotMatch(chatSource, /gpt-4o-mini['"`]\s*;\s*const BIZZY_CHAT_MODEL/);
});

test("actual OpenAI Chat Completions token usage is normalized without prompt text", () => {
  const telemetry = buildMainChatUsageTelemetry({
    model: "gpt-5.6-terra",
    usage: {
      prompt_tokens: 8000,
      completion_tokens: 800,
      total_tokens: 8800,
      prompt_tokens_details: {
        cached_tokens: 1200,
        cache_creation_input_tokens: 300,
      },
      completion_tokens_details: {
        reasoning_tokens: 100,
      },
    },
    choices: [{ message: { content: "confidential answer" } }],
  });

  assert.deepEqual(telemetry, {
    model: "gpt-5.6-terra",
    input_tokens: 8000,
    cached_input_tokens: 1200,
    cache_write_tokens: 300,
    output_tokens: 800,
    reasoning_tokens: 100,
    total_tokens: 8800,
    estimated_openai_cost_usd: 0.0293,
  });
  assert.equal(JSON.stringify(telemetry).includes("confidential answer"), false);
});

test("Terra cost estimates use centralized configured pricing", () => {
  assert.equal(estimateOpenAICostUsd("gpt-5.6-terra", {
    input_tokens: 3000,
    cached_input_tokens: 0,
    output_tokens: 500,
  }), 0.015);
  assert.equal(estimateOpenAICostUsd("gpt-5.6-terra", {
    input_tokens: 8000,
    cached_input_tokens: 0,
    output_tokens: 800,
  }), 0.032);
  assert.equal(estimateOpenAICostUsd("gpt-5.6-terra", {
    input_tokens: 20000,
    cached_input_tokens: 0,
    output_tokens: 1200,
  }), 0.068);
  assert.equal(estimateOpenAICostUsd("gpt-5.6-terra", {
    input_tokens: 30000,
    cached_input_tokens: 0,
    output_tokens: 1400,
  }), 0.096);
});

test("context budget trimming preserves the current user message", () => {
  const current = "current customer question that must remain";
  const messages = [
    { role: "system", content: "system instructions" },
    { role: "user", content: "old ".repeat(10_000) },
    { role: "assistant", content: "older answer ".repeat(10_000) },
    { role: "user", content: current },
  ];

  const result = applyMainChatContextBudget(messages, { maxChars: 5000, minHistoricalChars: 100 });
  assert.equal(result.trimmed, true);
  assert.equal(result.messages.at(-1).content, current);
  assert.equal(result.messages.at(-1).role, "user");
  assert.ok(result.messages.reduce((sum, msg) => sum + String(msg.content || "").length, 0) <= 5000);
});

test("usage recording sends numeric telemetry to the service-role RPC", async () => {
  let captured = null;
  const supabaseClient = {
    async rpc(name, params) {
      captured = { name, params };
      return {
        data: { query_count: 42, estimated_openai_cost_usd: "21.250000" },
        error: null,
      };
    },
  };

  const result = await recordMainChatUsage({
    supabaseClient,
    userId: "11111111-1111-4111-8111-111111111111",
    businessId: "22222222-2222-4222-8222-222222222222",
    month: "2026-08",
    requestId: "33333333-3333-4333-8333-333333333333",
    telemetry: {
      model: "gpt-5.6-terra",
      input_tokens: 8000,
      cached_input_tokens: 1000,
      cache_write_tokens: 0,
      output_tokens: 800,
      reasoning_tokens: 25,
      estimated_openai_cost_usd: 0.0295,
    },
  });

  assert.equal(captured.name, "record_bizzy_main_chat_usage");
  assert.equal(captured.params.p_user_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(captured.params.p_business_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(captured.params.p_model, "gpt-5.6-terra");
  assert.equal(captured.params.p_input_tokens, 8000);
  assert.equal(captured.params.p_output_tokens, 800);
  assert.equal(result.query_count, 42);
  assert.equal(result.estimated_openai_cost_usd, 21.25);
  assert.equal(JSON.stringify(captured).includes("prompt"), false);
  assert.equal(JSON.stringify(captured).includes("response"), false);
});

test("internal cost warnings log but do not block paid chat", () => {
  const warnings = [];
  const result = maybeLogMainChatCostWarning({
    logger: { warn: (...args) => warnings.push(args) },
    userId: "11111111-1111-4111-8111-111111111111",
    businessId: "22222222-2222-4222-8222-222222222222",
    month: "2026-08",
    model: "gpt-5.6-terra",
    queryCount: 200,
    estimatedMonthlyCostUsd: 35.01,
  });

  assert.equal(result.warned, true);
  assert.equal(result.level, "elevated");
  assert.equal(warnings.length, 1);
  assert.doesNotThrow(() => maybeLogMainChatCostWarning({
    logger: { warn: () => { throw new Error("would block"); } },
    estimatedMonthlyCostUsd: 0,
  }));
});

test("migration preserves browser query_count reads but keeps cost analytics server-only", () => {
  assert.match(migration, /ALTER TABLE public\.gpt_usage[\s\S]*ADD COLUMN IF NOT EXISTS input_tokens/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.gpt_usage_events/);
  assert.match(migration, /business_id uuid REFERENCES public\.business_profiles\(id\)/);
  assert.match(migration, /request_id uuid UNIQUE/);
  assert.match(migration, /ON CONFLICT \(request_id\) DO NOTHING/);
  assert.match(migration, /GET DIAGNOSTICS v_event_inserted = ROW_COUNT/);
  assert.match(migration, /IF v_event_inserted = 0 AND p_request_id IS NOT NULL THEN/);
  assert.match(migration, /ALTER TABLE public\.gpt_usage_events ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.gpt_usage_events FROM authenticated/);
  assert.match(migration, /GRANT ALL ON TABLE public\.gpt_usage_events TO service_role/);
  assert.match(migration, /REVOKE SELECT ON TABLE public\.gpt_usage FROM authenticated/);
  assert.match(migration, /GRANT SELECT \(user_id, month, query_count, last_used\) ON TABLE public\.gpt_usage TO authenticated/);
  assert.doesNotMatch(migration, /GRANT SELECT \([^)]*estimated_openai_cost_usd[^)]*\) ON TABLE public\.gpt_usage TO authenticated/);
});

test("server response strips internal telemetry before returning to browser", () => {
  assert.match(chatSource, /const \{ internalTelemetry, \.\.\.publicResult \} = result \|\| \{\}/);
  assert.match(chatSource, /return res\.json\(\{ \.\.\.publicResult \}\)/);
  assert.doesNotMatch(chatSource, /res\.json\(\{ \.\.\.result \}\)/);
});

test("chat access billing gate uses canonical tenant authorization", () => {
  assert.match(gptRoutesSource, /const privateBusinessRoute = \[requireAuth, requireBusinessAccess\(\)\]/);
  assert.match(
    gptRoutesSource,
    /router\.get\('\/chat-access',\s+\.\.\.privateBusinessRoute,\s+getBizzyChatAccessHandler\)/
  );
  assert.doesNotMatch(
    gptRoutesSource,
    /router\.get\('\/chat-access',\s+requireAuth,\s+getBizzyChatAccessHandler\)/
  );
});
