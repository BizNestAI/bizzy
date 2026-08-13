export const MAIN_CHAT_MODEL_PRICING_USD_PER_MILLION = Object.freeze({
  'gpt-5.6-terra': {
    input: 2.5,
    cached_input: 0.25,
    output: 15,
  },
});

export const DEFAULT_MAIN_CHAT_CONTEXT_CHAR_BUDGET = Number(
  process.env.BIZZY_MAIN_CHAT_CONTEXT_CHAR_BUDGET || 120_000
);

export const MAIN_CHAT_COST_WARNING_USD = Number(
  process.env.BIZZY_MAIN_CHAT_COST_WARNING_USD || 20
);

export const MAIN_CHAT_COST_ELEVATED_WARNING_USD = Number(
  process.env.BIZZY_MAIN_CHAT_COST_ELEVATED_WARNING_USD || 35
);

function toNonNegativeInteger(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function readFirstNumber(...values) {
  for (const value of values) {
    const n = toNonNegativeInteger(value);
    if (n > 0) return n;
  }
  return 0;
}

export function extractOpenAIUsage(apiResponse = {}) {
  const usage = apiResponse?.usage || {};
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outputDetails = usage.output_tokens_details || usage.completion_tokens_details || {};

  return {
    input_tokens: readFirstNumber(usage.input_tokens, usage.prompt_tokens),
    cached_input_tokens: readFirstNumber(
      inputDetails.cached_tokens,
      inputDetails.cached_input_tokens
    ),
    cache_write_tokens: readFirstNumber(
      inputDetails.cache_creation_tokens,
      inputDetails.cache_creation_input_tokens,
      inputDetails.cache_write_tokens
    ),
    output_tokens: readFirstNumber(usage.output_tokens, usage.completion_tokens),
    reasoning_tokens: readFirstNumber(
      outputDetails.reasoning_tokens,
      usage.reasoning_tokens
    ),
    total_tokens: readFirstNumber(usage.total_tokens),
  };
}

export function estimateOpenAICostUsd(model, usage = {}) {
  const pricing = MAIN_CHAT_MODEL_PRICING_USD_PER_MILLION[model] || null;
  if (!pricing) return 0;

  const inputTokens = toNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    toNonNegativeInteger(usage.cached_input_tokens)
  );
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = toNonNegativeInteger(usage.output_tokens);

  const cost =
    (uncachedInputTokens * pricing.input +
      cachedInputTokens * pricing.cached_input +
      outputTokens * pricing.output) /
    1_000_000;

  return Number(cost.toFixed(8));
}

export function buildMainChatUsageTelemetry(apiResponse = {}, fallbackModel = 'unknown') {
  const model = apiResponse?.model || fallbackModel || 'unknown';
  const usage = extractOpenAIUsage(apiResponse);
  return {
    model,
    ...usage,
    estimated_openai_cost_usd: estimateOpenAICostUsd(model, usage),
  };
}

function messageTextLength(message = {}) {
  const content = message?.content;
  if (typeof content === 'string') return content.length;
  try {
    return JSON.stringify(content ?? '').length;
  } catch {
    return String(content ?? '').length;
  }
}

function trimMessageContent(message, maxChars) {
  if (typeof message?.content !== 'string') return message;
  if (message.content.length <= maxChars) return message;
  return {
    ...message,
    content: `${message.content.slice(0, Math.max(0, maxChars))}\n\n[Earlier context trimmed for safety.]`,
  };
}

export function applyMainChatContextBudget(
  messages = [],
  { maxChars = DEFAULT_MAIN_CHAT_CONTEXT_CHAR_BUDGET, minHistoricalChars = 1_000 } = {}
) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], trimmed: false, input_chars: 0, max_chars: maxChars };
  }

  const totalChars = messages.reduce((sum, msg) => sum + messageTextLength(msg), 0);
  if (totalChars <= maxChars) {
    return { messages, trimmed: false, input_chars: totalChars, max_chars: maxChars };
  }

  const lastUserIndex = [...messages]
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find(({ msg }) => msg?.role === 'user')?.index;

  const next = messages.map((msg, index) => {
    if (index === lastUserIndex) return msg;
    if (msg?.role === 'system' || msg?.role === 'developer') return msg;
    return trimMessageContent(msg, minHistoricalChars);
  });

  let pruned = next;
  while (
    pruned.length > 1 &&
    pruned.reduce((sum, msg) => sum + messageTextLength(msg), 0) > maxChars
  ) {
    const removableIndex = pruned.findIndex(
      (msg, index) =>
        index !== lastUserIndex &&
        msg?.role !== 'system' &&
        msg?.role !== 'developer'
    );
    if (removableIndex < 0) break;
    pruned = pruned.filter((_, index) => index !== removableIndex);
  }

  const finalChars = pruned.reduce((sum, msg) => sum + messageTextLength(msg), 0);
  return {
    messages: pruned,
    trimmed: true,
    input_chars: finalChars,
    original_input_chars: totalChars,
    max_chars: maxChars,
  };
}

export function shouldFallbackToLegacyUsageIncrement(error = {}) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === '42883' || message.includes('record_bizzy_main_chat_usage');
}

export async function incrementLegacyMonthlyUsage({
  supabaseClient,
  userId,
  month,
  nowIso = new Date().toISOString(),
}) {
  const { data: usageData, error: fetchError } = await supabaseClient
    .from('gpt_usage')
    .select('query_count')
    .eq('user_id', userId)
    .eq('month', month)
    .maybeSingle();
  if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

  const nextCount = (usageData?.query_count || 0) + 1;
  const { error: upsertError } = await supabaseClient
    .from('gpt_usage')
    .upsert(
      {
        user_id: userId,
        month,
        query_count: nextCount,
        last_used: nowIso,
      },
      { onConflict: 'user_id,month' }
    );
  if (upsertError) throw upsertError;
  return { query_count: nextCount, telemetry_recorded: false };
}

export async function recordMainChatUsage({
  supabaseClient,
  userId,
  businessId = null,
  month,
  telemetry = {},
  requestId = null,
  nowIso = new Date().toISOString(),
}) {
  if (!userId) return null;

  const payload = {
    p_user_id: userId,
    p_business_id: businessId || null,
    p_month: month,
    p_model: telemetry.model || 'unknown',
    p_input_tokens: toNonNegativeInteger(telemetry.input_tokens),
    p_cached_input_tokens: toNonNegativeInteger(telemetry.cached_input_tokens),
    p_cache_write_tokens: toNonNegativeInteger(telemetry.cache_write_tokens),
    p_output_tokens: toNonNegativeInteger(telemetry.output_tokens),
    p_reasoning_tokens: toNonNegativeInteger(telemetry.reasoning_tokens),
    p_estimated_openai_cost_usd: Number(telemetry.estimated_openai_cost_usd || 0),
    p_request_id: requestId || null,
  };

  const { data, error } = await supabaseClient.rpc('record_bizzy_main_chat_usage', payload);
  if (error) {
    if (shouldFallbackToLegacyUsageIncrement(error)) {
      return incrementLegacyMonthlyUsage({ supabaseClient, userId, month, nowIso });
    }
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    query_count: Number(row?.query_count || 0),
    estimated_openai_cost_usd: Number(row?.estimated_openai_cost_usd || 0),
    telemetry_recorded: true,
  };
}

export function maybeLogMainChatCostWarning({
  logger = console,
  userId,
  businessId,
  month,
  model,
  queryCount,
  estimatedMonthlyCostUsd,
}) {
  const monthlyCost = Number(estimatedMonthlyCostUsd || 0);
  const level = monthlyCost >= MAIN_CHAT_COST_ELEVATED_WARNING_USD
    ? 'elevated'
    : monthlyCost >= MAIN_CHAT_COST_WARNING_USD
      ? 'warning'
      : null;
  if (!level) return { warned: false };

  logger.warn?.('[gpt cost] monthly main-chat spend threshold reached', {
    level,
    user_id: userId,
    business_id: businessId || null,
    month,
    model,
    query_count: queryCount,
    estimated_openai_cost_usd: Number(monthlyCost.toFixed(4)),
  });
  return { warned: true, level };
}
