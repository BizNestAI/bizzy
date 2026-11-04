import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

test("sidebar orders Jobs above Tax", () => {
  const sidebar = fs.readFileSync("src/components/UserAdmin/Sidebar.jsx", "utf8");
  const jobsIndex = sidebar.indexOf("{ label: 'Jobs', path: '/dashboard/leads-jobs/job-costing' }");
  const taxIndex = sidebar.indexOf("{ label: 'Tax', path: '/dashboard/tax' }");
  assert.ok(jobsIndex > -1, "Jobs tab should exist");
  assert.ok(taxIndex > -1, "Tax tab should exist");
  assert.ok(jobsIndex < taxIndex, "Jobs should be listed before Tax");
});

test("sidebar does not expose the undeveloped Activity module", () => {
  const sidebar = fs.readFileSync("src/components/UserAdmin/Sidebar.jsx", "utf8");
  const tabs = sidebar.slice(sidebar.indexOf("const tabs = ["), sidebar.indexOf("];", sidebar.indexOf("const tabs = [")));
  assert.doesNotMatch(tabs, /label: ['"]Activity['"]/);
  assert.doesNotMatch(tabs, /\/dashboard\/activity/);
});

test("Settings is grouped above Live and the business profile instead of the primary module stack", () => {
  const sidebar = fs.readFileSync("src/components/UserAdmin/Sidebar.jsx", "utf8");
  const navRail = fs.readFileSync("src/layout/NavRail.jsx", "utf8");
  const tabs = sidebar.slice(sidebar.indexOf("const tabs = ["), sidebar.indexOf("];", sidebar.indexOf("const tabs = [")));
  assert.doesNotMatch(tabs, /label: ['"]Settings\/Sync['"]/);
  const settingsButton = navRail.indexOf('aria-label="Settings"');
  const liveBadge = navRail.indexOf("title={`Data source mode:");
  const profileBadge = navRail.indexOf("<NavRailBusinessBadge />");
  assert.ok(settingsButton > -1, "bottom Settings control should exist");
  assert.ok(settingsButton < liveBadge && liveBadge < profileBadge, "Settings should appear above Live, followed by the business profile");
  assert.match(navRail, /onMouseEnter=\{showSettingsTooltip\}/);
  assert.match(navRail, /onFocus=\{showSettingsTooltip\}/);
  assert.match(navRail, /settingsTooltip && createPortal\(/);
  assert.match(navRail, /role="tooltip"/);
});
