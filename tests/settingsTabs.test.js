import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SettingsTabs from "../src/pages/Settings/SettingsTabs.js";
import { SETTINGS_TABS } from "../src/pages/Settings/settingsTabsConfig.js";

test("every production Settings tab renders its configured icon without throwing", () => {
  assert.ok(SETTINGS_TABS.every((item) => typeof item.icon === "function" || typeof item.icon === "object"));
  for (const activeTab of SETTINGS_TABS.map((item) => item.key)) {
    const html = renderToStaticMarkup(
      React.createElement(SettingsTabs, {
        items: SETTINGS_TABS,
        activeTab,
        onSelect() {},
        softBorder: "transparent",
      })
    );
    assert.match(html, new RegExp(`aria-selected="true"[^>]*>[\\s\\S]*${activeTab}`));
    assert.equal((html.match(/<svg/g) || []).length, SETTINGS_TABS.length);
  }
});

test("an explicitly icon-optional Settings item remains renderable", () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsTabs, {
      items: [{ key: "Optional", icon: null }],
      activeTab: "Optional",
      softBorder: "transparent",
    })
  );
  assert.match(html, />Optional<\/button>/);
  assert.doesNotMatch(html, /<svg/);
});
