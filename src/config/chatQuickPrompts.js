import { ONBOARDING_PROMPTS as ONBOARDING_PROMPT_BANK } from "./onboardingPromptBank.js";

// Exact pre-onboarding prompt order shared by desktop, mobile, and ChatCanvas.
export const ONBOARDING_PROMPTS = ONBOARDING_PROMPT_BANK.map(
  (entry) => entry.canonicalPrompt
);

// Post-onboarding prompts are intentionally unchanged.
export const NORMAL_PROMPTS = [
  "What are my top priorities this week?",
  "What’s changed in my business since last month?",
  "What are my top 3 risks right now?",
  "What should I focus on today?",
];
