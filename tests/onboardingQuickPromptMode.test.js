import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "src/hooks/useOnboardingStatus.js"), "utf8");

test("quick prompt mode cannot become normal solely from a local completed-once flag", () => {
  const quickPromptModeBlock = source.match(/const quickPromptMode = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[/)?.[1] || "";
  const integrationGateIndex = quickPromptModeBlock.indexOf('if (!state.qbConnected || !state.plaidConnected) return "onboarding";');
  const completedOnceIndex = quickPromptModeBlock.indexOf('if (state.onboardingCompletedOnce) return "normal";');

  assert.ok(integrationGateIndex >= 0, "quick prompt mode must gate on live QBO/Plaid connection state");
  assert.ok(completedOnceIndex >= 0, "quick prompt mode may still honor completed-once after prerequisites");
  assert.ok(
    integrationGateIndex < completedOnceIndex,
    "live QBO/Plaid prerequisites must be checked before completed-once can select normal prompts"
  );
});

test("successful integration status checks clear stale local connection flags", () => {
  assert.match(
    source,
    /window\.localStorage\.setItem\(LOCAL_KEYS\.qbConnected, qbConnected \? "true" : "false"\)/
  );
  assert.match(
    source,
    /window\.localStorage\.setItem\(LOCAL_KEYS\.plaidConnected, plaidConnected \? "true" : "false"\)/
  );
  assert.doesNotMatch(
    source,
    /\n\s*plaidConnected = plaidConnected \|\| Boolean\(readLocalFlag\(LOCAL_KEYS\.plaidConnected\)\);\n\s*const profile =/
  );
});

test("business profile completion reads every field it evaluates", () => {
  assert.match(source, /\.select\("id,business_name,industry,state,services_offered"\)/);
  assert.match(source, /profile\?\.state/);
  assert.match(source, /profile\?\.services_offered/);
});
