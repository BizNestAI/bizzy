/**
 * Normalize the two supported customer chat inputs into one submission shape.
 * Quick-prompt controls provide { text, intent }; typed messages provide strings.
 * Unsupported values are rejected instead of being stringified into chat content.
 */
export function normalizeChatPromptInput(value) {
  if (typeof value === "string") {
    return { text: value.trim(), intent: null };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { text: "", intent: null };
  }

  const text = typeof value.text === "string" ? value.text.trim() : "";
  const intent = typeof value.intent === "string" ? value.intent.trim() : "";
  return { text, intent: intent || null };
}
