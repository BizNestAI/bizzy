import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import AssistantMessageContent, { assistantMessageText } from "../src/components/Bizzy/AssistantMessageContent.js";

const ADOBE_TABLE = `I found **6 Adobe transactions** in the available history:

| Date | Amount | Description | Category | Status |
|---|---:|---|---|---|
| Aug 28, 2026 | -$7.57 | ADOBE *800-833-6687 | — | Pending |
| Jul 30, 2026 | +$32.16 | ADOBE *800-833-6687 | Software | Posted to QuickBooks |

The recurring charge is about **$7.50–$7.57/month**.`;

function render(message, complete = true) {
  return renderToStaticMarkup(React.createElement(AssistantMessageContent, { message, complete }));
}

test("fresh responseText and hydrated content produce equivalent Adobe table DOM", () => {
  const live = { sender: "assistant", text: assistantMessageText({ responseText: ADOBE_TABLE }) };
  const hydrated = { sender: "assistant", text: assistantMessageText({ content: ADOBE_TABLE }) };
  const liveDom = render(live);
  const hydratedDom = render(hydrated);
  assert.equal(liveDom, hydratedDom);
  assert.match(liveDom, /<table>/);
  assert.match(liveDom, /<thead>/);
  assert.match(liveDom, /<tbody>/);
  assert.match(liveDom, /aria-label="Scrollable table"/);
});

test("canonical assistant renderer supports prose, emphasis, lists, code, and safe links", () => {
  const markdown = `Ordinary paragraph with **bold**, *italic*, \`code\`, and [Bizzi](https://example.com).\n\n- One\n- Two\n\n1. First\n2. Second`;
  const dom = render({ text: markdown });
  assert.match(dom, /<p>Ordinary paragraph/);
  assert.match(dom, /<strong>bold<\/strong>/);
  assert.match(dom, /<em>italic<\/em>/);
  assert.match(dom, /<code>code<\/code>/);
  assert.match(dom, /rel="noopener noreferrer"/);
  assert.match(dom, /<ul>/);
  assert.match(dom, /<ol>/);
});

test("incomplete Markdown renders conservatively until completion", () => {
  const partial = "| Date | Amount |\n|---|---:\n| Aug **";
  const partialDom = render({ text: partial }, false);
  assert.doesNotMatch(partialDom, /<table>/);
  assert.match(partialDom, /data-markdown-complete="false"/);
  const completeDom = render({ text: ADOBE_TABLE }, true);
  assert.match(completeDom, /data-markdown-complete="true"/);
  assert.match(completeDom, /<table>/);
});

test("tables expose a bounded horizontal-scroll container for narrow screens", () => {
  const dom = render({ text: ADOBE_TABLE });
  assert.match(dom, /class="bizzy-table-scroll"/);
  assert.match(dom, /overflow-x:auto/);
  assert.match(dom, /max-width:100%/);
  assert.match(dom, /tabindex="0"/);
});

test("transaction table headers, amounts, dates, and short categories remain unbroken", () => {
  const dom = render({ text: ADOBE_TABLE });
  assert.match(dom, /<th[^>]*>Amount<\/th>/);
  assert.match(dom, /<th[^>]*>Category<\/th>/);
  assert.match(dom, /<td[^>]*>\+\$32\.16<\/td>/);
  assert.match(dom, /white-space:nowrap;word-break:normal;overflow-wrap:normal/);
  assert.match(dom, /nth-child\(1\).*min-width:120px;white-space:nowrap/);
  assert.match(dom, /nth-child\(2\).*min-width:95px;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums/);
  assert.match(dom, /nth-child\(3\).*min-width:220px;white-space:normal/);
  assert.match(dom, /nth-child\(4\).*min-width:130px;white-space:nowrap/);
  assert.match(dom, /nth-child\(5\).*min-width:260px;white-space:normal/);
  assert.match(dom, /table-layout:auto/);
  assert.doesNotMatch(dom, /table-layout:fixed/);
});
