import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getSuggestedReportingTimezone,
  getReportingTimezoneOption,
} from "../src/services/evidence/reportingTimezoneSuggestions.js";

test("reviewed business-state mapping suggests only unambiguous timezones", () => {
  assert.equal(getSuggestedReportingTimezone("North Carolina"), "America/New_York");
  assert.equal(getSuggestedReportingTimezone("CA"), "America/Los_Angeles");
  assert.equal(getSuggestedReportingTimezone("Colorado"), "America/Denver");
  assert.equal(getSuggestedReportingTimezone("Illinois"), "America/Chicago");
  for (const state of ["Florida", "Indiana", "Kentucky", "Tennessee", "Idaho", "Oregon", "Texas", "Kansas", "Nebraska", "North Dakota", "South Dakota", "Michigan", "Alaska", "", null]) {
    assert.equal(getSuggestedReportingTimezone(state), null, state || "missing state");
  }
});

test("friendly labels retain canonical IANA identities", () => {
  assert.deepEqual(getReportingTimezoneOption("America/New_York"), { value: "America/New_York", label: "Eastern Time" });
  assert.equal(getReportingTimezoneOption("Etc/GMT+5"), null);
});

test("settings flow preserves server precedence and uses the accessible dark listbox", () => {
  const source = fs.readFileSync(new URL("../src/pages/Settings/SettingsHome.jsx", import.meta.url), "utf8");
  assert.match(source, /next\.reporting_timezone \|\| suggestion \|\| ""/);
  assert.match(source, /setTimezone\(status\.reporting_timezone \|\| ""\).*setEditing\(false\)/s);
  assert.match(source, /ListboxButton[\s\S]*aria-describedby="financial-reporting-timezone-description"/);
  assert.match(source, /ListboxOptions[\s\S]*portal[\s\S]*z-\[10030\][\s\S]*max-h-72[\s\S]*overflow-y-auto/);
  assert.doesNotMatch(source, /<select id="financial-reporting-timezone"/);
  assert.match(source, /busyRef\.current/);
  assert.match(source, /requestIdRef\.current \|\|= crypto\.randomUUID\(\)/);
  assert.match(source, /configureFinancialReporting\(\{ businessId, timezone, requestId: requestIdRef\.current \}\)/);
  assert.doesNotMatch(source, /resolvedOptions\(\)\.timeZone|navigator\.geolocation/);
});

test("successful confirmation refreshes quick-prompt availability without navigation or reload", () => {
  const settings = fs.readFileSync(new URL("../src/pages/Settings/SettingsHome.jsx", import.meta.url), "utf8");
  const chat = fs.readFileSync(new URL("../src/components/Bizzy/BizzyChatBar.jsx", import.meta.url), "utf8");
  assert.match(settings, /bizzy:financial-reporting-updated/);
  assert.match(chat, /addEventListener\("bizzy:financial-reporting-updated"/);
  assert.match(chat, /setReportingStatus\(event\.detail\.status\)/);
  const setup = settings.slice(settings.indexOf("function FinancialReportingSetup"), settings.indexOf("function ModeToggle"));
  assert.doesNotMatch(setup, /window\.location\.reload|location\.reload/);
});
