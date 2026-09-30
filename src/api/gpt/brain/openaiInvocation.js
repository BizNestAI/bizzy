export function classifyOpenAIError(error) {
  const status = Number(error?.status || error?.statusCode || 0) || null;
  const code = String(error?.code || error?.error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  let errorClass = "request_rejected";
  if (status === 429 || /rate|quota/.test(`${code} ${message}`)) errorClass = "rate_limit_or_quota";
  else if (/timeout|timed out|abort|network|fetch|socket|econn/.test(`${code} ${message}`)) errorClass = "timeout_or_network";
  return {
    error_class: errorClass,
    http_status: status,
    provider_request_id: error?.request_id || error?.requestId || error?.headers?.["x-request-id"] || null,
  };
}

export async function invokeBizzyChatCompletion({ client, model, messages, maxTokens = 1400, timeoutMs = 45_000 } = {}) {
  const started = Date.now();
  if (!client) {
    return { ok: false, content: null, response: null, diagnostic: { error_class: "missing_configuration", http_status: null, provider_request_id: null, duration_ms: 0 } };
  }
  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.7,
      max_completion_tokens: maxTokens,
    }, { timeout: timeoutMs, maxRetries: 1 });
    const content = response?.choices?.[0]?.message?.content?.trim() || null;
    return {
      ok: Boolean(content), content, response,
      diagnostic: {
        error_class: content ? null : "empty_completion",
        http_status: 200,
        provider_request_id: response?._request_id || response?.request_id || null,
        duration_ms: Date.now() - started,
      },
    };
  } catch (error) {
    return { ok: false, content: null, response: null, diagnostic: { ...classifyOpenAIError(error), duration_ms: Date.now() - started } };
  }
}
