export const BUSINESS_QUICK_PROMPT_REGISTRY_VERSION = "business-quick-prompts-v2";

export const NON_TAX_BUSINESS_QUICK_PROMPTS = Object.freeze([
  prompt("financial_month_performance", "How did my business perform this month?", "Uses a verified Cash-basis Profit and Loss for this month."),
  prompt("financial_income_categories", "Which income categories brought in the most revenue?", "Ranks verified income accounts by revenue contribution."),
  prompt("financial_expense_categories", "Which expense categories cost me the most?", "Separates Cost of Goods Sold from operating expenses."),
  prompt("financial_period_changes", "What changed most compared with last month?", "Compares equivalent Cash-basis reporting periods."),
]);

export const TAX_BUSINESS_QUICK_PROMPTS = Object.freeze([
  prompt("tax_ytd_book_profit", "What is my year-to-date book profit?", "Reports verified Cash-basis book profit, not taxable income."),
  prompt("tax_transactions_needing_review", "Which tax-related transactions need review?", "Reviews supported bookkeeping and tax-classification flags."),
  prompt("tax_professional_readiness", "Are my books ready for my tax professional?", "Assesses bookkeeping readiness and identifies unavailable inputs."),
]);

export const BUSINESS_QUICK_PROMPTS = Object.freeze([...NON_TAX_BUSINESS_QUICK_PROMPTS, ...TAX_BUSINESS_QUICK_PROMPTS]);
export const BUSINESS_QUICK_PROMPT_INTENTS = new Set(BUSINESS_QUICK_PROMPTS.map((entry) => entry.intent));

const BY_INTENT = new Map(BUSINESS_QUICK_PROMPTS.map((entry) => [entry.intent, entry]));
const BY_TEXT = new Map(BUSINESS_QUICK_PROMPTS.map((entry) => [normalizePromptText(entry.text), entry]));

export function getBusinessQuickPrompts(moduleName = "bizzy") {
  return String(moduleName || "").toLowerCase() === "tax" ? TAX_BUSINESS_QUICK_PROMPTS : NON_TAX_BUSINESS_QUICK_PROMPTS;
}

export function getBusinessQuickPromptByIntent(intent) {
  return BY_INTENT.get(String(intent || "")) || null;
}

export function resolveCanonicalBusinessQuickPrompt({ intent = null, text = "" } = {}) {
  const byIntent = getBusinessQuickPromptByIntent(intent);
  const byText = BY_TEXT.get(normalizePromptText(text)) || null;
  if (byIntent && byText && byIntent.intent !== byText.intent) return { status: "mismatch", prompt: null };
  if (byIntent && normalizePromptText(byIntent.text) !== normalizePromptText(text)) return { status: "mismatch", prompt: null };
  if (byIntent) return { status: "canonical", prompt: byIntent };
  if (byText) return { status: "canonical", prompt: byText };
  return { status: "general", prompt: null };
}

export function normalizePromptText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function prompt(intent, text, description) {
  return Object.freeze({ id: intent, intent, text, description, registryVersion: BUSINESS_QUICK_PROMPT_REGISTRY_VERSION });
}
