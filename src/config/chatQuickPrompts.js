import { ONBOARDING_PROMPT_BANK } from "./onboardingPromptBank";

// Show only a curated subset of onboarding prompts, while the full bank remains answerable.
const ALLOWED_IDS = [
  "setup_biz",
  "sync_quickbooks_plaid",
  "daily_use",
  "bizzi_value",
  "first_step",
  "can_bizzi_take_actions",
];

// Optional label overrides for display (does not affect underlying answers).
const LABEL_OVERRIDES = {
  setup_biz: "How do I set up my business in Bizzi?",
  sync_quickbooks_plaid: "How do I sync Plaid and QuickBooks?",
};

export const ONBOARDING_PROMPTS = ONBOARDING_PROMPT_BANK
  .filter((entry) => ALLOWED_IDS.includes(entry?.id))
  .map((entry) => LABEL_OVERRIDES[entry.id] || entry.canonicalPrompt)
  .filter(Boolean);

export const NORMAL_PROMPTS = [
  "What are my top priorities this week?",
  "What’s changed in my business since last month?",
  "What are my top 3 risks right now?",
  "What should I focus on today?",
];
