const GPT_56_MODEL_RE = /^gpt-5\.6(?:-|$)/i;

function flattenMessageContent(content) {
  const chunks = Array.isArray(content) ? content : [content];
  return chunks.map((chunk) => {
    if (typeof chunk === "string") return chunk;
    if (typeof chunk?.text === "string") return chunk.text;
    if (typeof chunk?.text?.value === "string") return chunk.text.value;
    if (typeof chunk?.content === "string") return chunk.content;
    if (Array.isArray(chunk?.content)) return flattenMessageContent(chunk.content);
    return "";
  }).filter(Boolean).join("\n");
}

export function prepareResponsesInput(messages = []) {
  const instructions = [];
  const input = [];
  for (const message of messages) {
    const text = flattenMessageContent(message?.content);
    if (!text) continue;
    if (["system", "developer"].includes(message?.role)) instructions.push(text);
    else input.push({ role: message?.role === "assistant" ? "assistant" : "user", content: text });
  }
  return { instructions: instructions.join("\n\n"), input };
}

export function normalizeOpenAIOutput(response, apiMethod) {
  if (apiMethod === "chat.completions") {
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part?.text || "").join("").trim();
    return null;
  }
  if (typeof response?.output_text === "string") return response.output_text.trim() || null;
  if (Array.isArray(response?.output_text)) return response.output_text.join("\n").trim() || null;
  const text = (response?.output || []).filter((item) => item?.type === "message")
    .flatMap((item) => item?.content || [])
    .map((part) => typeof part?.text === "string" ? part.text : part?.text?.value || "")
    .filter(Boolean).join("");
  return text.trim() || null;
}

export function resolveOpenAIInvocation(model) {
  return GPT_56_MODEL_RE.test(String(model || ""))
    ? { api_method: "responses", supports_custom_temperature: false }
    : { api_method: "chat.completions", supports_custom_temperature: true };
}

function requestIdFromError(error) {
  return error?.request_id || error?.requestId || error?.headers?.["x-request-id"] || error?.headers?.get?.("x-request-id") || null;
}

function sanitizeProviderMessage(value, messages = []) {
  let output = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  for (const message of messages) {
    const content = flattenMessageContent(message?.content);
    if (content && output.includes(content)) output = output.replaceAll(content, "[REDACTED_PROMPT]");
  }
  return output
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_ -]?key["']?\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]")
    .slice(0, 500) || null;
}

export function classifyOpenAIError(error, { model = null, apiMethod = null, messages = [] } = {}) {
  const status = Number(error?.status || error?.statusCode || 0) || null;
  const providerError = error?.error || error?.body?.error || {};
  const code = String(providerError?.code || error?.code || "").trim() || null;
  const type = String(providerError?.type || error?.type || error?.name || "").trim() || null;
  const param = String(providerError?.param || error?.param || "").trim() || null;
  const rawMessage = providerError?.message || error?.message || "";
  const matchText = `${code || ""} ${rawMessage}`.toLowerCase();
  let errorClass = "request_rejected";
  if (status === 429 || /rate|quota/.test(matchText)) errorClass = "rate_limit_or_quota";
  else if (/timeout|timed out|abort|network|fetch|socket|econn/.test(matchText)) errorClass = "timeout_or_network";
  else if (status && status >= 500) errorClass = "provider_server_error";
  return {
    error_class: errorClass,
    http_status: status,
    error_type: type,
    error_code: code,
    invalid_parameter: param,
    provider_message: sanitizeProviderMessage(rawMessage, messages),
    provider_request_id: requestIdFromError(error),
    configured_model: model,
    api_method: apiMethod,
  };
}

export async function invokeBizzyChatCompletion({ client, model, messages, maxTokens = 1400, timeoutMs = 45_000, logger = console } = {}) {
  const started = Date.now();
  const capability = resolveOpenAIInvocation(model);
  if (!client) {
    return { ok: false, content: null, response: null, apiMethod: capability.api_method, diagnostic: { error_class: "missing_configuration", http_status: null, provider_request_id: null, configured_model: model, api_method: capability.api_method, duration_ms: 0 } };
  }
  try {
    let response;
    if (capability.api_method === "responses") {
      const prepared = prepareResponsesInput(messages);
      response = await client.responses.create({
        model,
        instructions: prepared.instructions || undefined,
        input: prepared.input,
        max_output_tokens: maxTokens,
      }, { timeout: timeoutMs, maxRetries: 1 });
    } else {
      response = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
        max_completion_tokens: maxTokens,
      }, { timeout: timeoutMs, maxRetries: 1 });
    }
    const content = normalizeOpenAIOutput(response, capability.api_method);
    return {
      ok: Boolean(content), content, response, apiMethod: capability.api_method,
      diagnostic: {
        error_class: content ? null : "empty_completion",
        http_status: 200,
        provider_request_id: response?._request_id || response?.request_id || null,
        configured_model: model,
        api_method: capability.api_method,
        duration_ms: Date.now() - started,
      },
    };
  } catch (error) {
    const diagnostic = { ...classifyOpenAIError(error, { model, apiMethod: capability.api_method, messages }), duration_ms: Date.now() - started };
    logger.error?.("[bizzy.openai.failure]", diagnostic);
    return { ok: false, content: null, response: null, apiMethod: capability.api_method, diagnostic };
  }
}
