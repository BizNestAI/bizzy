import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "src/hooks/useOnboardingStatus.js"), "utf8");

test("quick prompt mode uses only the canonical backend onboarding result", () => {
  const quickPromptModeBlock = source.match(/const quickPromptMode = useMemo\(\(\) => \{([\s\S]*?)\n {2}\}, \[/)?.[1] || "";
  assert.match(quickPromptModeBlock, /state\.onboardingComplete/);
  assert.doesNotMatch(quickPromptModeBlock, /onboardingCompletedOnce|hasViewedIntegrations|qbConnected|plaidConnected/);
});

test("frontend reads one canonical onboarding endpoint and stores no completion facts locally", () => {
  assert.match(source, /\/api\/onboarding\/status\?business_id=/);
  assert.doesNotMatch(source, /LOCAL_KEYS|localStorage\.setItem|hasViewedIntegrationsPage|onboardingCompletedOnce/);
});

test("business profile completion is not recomputed in the browser", () => {
  assert.doesNotMatch(source, /\.from\("business_profiles"\)|profile\?\.business_name|profile\?\.industry|profile\?\.state/);
  assert.match(source, /status\?\.business_profile_complete/);
});
/* global process */
