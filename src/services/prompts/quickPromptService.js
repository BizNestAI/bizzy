import {
  BUSINESS_QUICK_PROMPT_REGISTRY_VERSION,
  getBusinessQuickPrompts,
  resolveCanonicalBusinessQuickPrompt,
} from "../../config/businessQuickPrompts.js";

const CACHE_PREFIX = "bizzy:business-quick-prompts:";

export function invalidateLegacyQuickPromptCaches(storage = globalThis.localStorage) {
  if (!storage) return;
  const removals = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith("qp:") || (key?.startsWith(CACHE_PREFIX) && !key.includes(BUSINESS_QUICK_PROMPT_REGISTRY_VERSION))) removals.push(key);
  }
  removals.forEach((key) => storage.removeItem(key));
}

export async function getQuickPromptsForModule(_userId, moduleName) {
  try { invalidateLegacyQuickPromptCaches(); } catch { /* storage is optional */ }
  return getBusinessQuickPrompts(moduleName);
}

export function resolveStoredQuickPrompt(value) {
  const text = typeof value === "string" ? value : value?.text;
  const intent = typeof value === "object" ? value?.intent : null;
  const resolved = resolveCanonicalBusinessQuickPrompt({ intent, text });
  return resolved.status === "canonical" ? resolved.prompt : null;
}
