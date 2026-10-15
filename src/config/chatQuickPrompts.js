import { ONBOARDING_PROMPTS as ONBOARDING_PROMPT_BANK } from "./onboardingPromptBank.js";
import { NON_TAX_BUSINESS_QUICK_PROMPTS } from "./businessQuickPrompts.js";

// Exact pre-onboarding prompt order shared by desktop, mobile, and ChatCanvas.
export const ONBOARDING_PROMPTS = ONBOARDING_PROMPT_BANK.map(
  (entry) => entry.canonicalPrompt
);

// Compatibility export; the canonical post-onboarding ownership is the versioned registry.
export const NORMAL_PROMPTS = NON_TAX_BUSINESS_QUICK_PROMPTS.map((entry) => entry.text);
