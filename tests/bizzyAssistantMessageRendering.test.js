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

function render(message, complete = true, revealCharacters = Infinity) {
  return renderToStaticMarkup(React.createElement(AssistantMessageContent, { message, complete, revealCharacters }));
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

test("an incomplete animation frame keeps formatting for revealed content", () => {
  const partialDom = render({ text: ADOBE_TABLE }, false, 20);
  assert.doesNotMatch(partialDom, /<table>/);
  assert.match(partialDom, /<strong>6 Adobe tran<\/strong>/);
  assert.doesNotMatch(partialDom, /\*\*/);
  assert.match(partialDom, /data-markdown-complete="false"/);
  const completeDom = render({ text: ADOBE_TABLE }, true);
  assert.match(completeDom, /data-markdown-complete="true"/);
  assert.match(completeDom, /<table>/);
});

test("progressive rendering reveals formatted text without Markdown delimiters", () => {
  const markdown = `## Summary\n\n**$921.55 net loss** with *partial-period context*, ***nested emphasis***, \`Cash\`, and [QuickBooks](https://quickbooks.intuit.com).\n\n- Revenue\n- Expenses`;
  for (const boundary of [1, 2, 3, 8, 17, 29, 42, 60, 90, markdown.length - 1]) {
    const dom = render({ text: markdown }, false, boundary);
    assert.doesNotMatch(dom, /\*\*|(?<!\*)\*(?!\*)|`|\]\(|^#{1,6}\s/m);
    assert.match(dom, /data-markdown-complete="false"/);
  }
  const boldFrame = render({ text: markdown }, false, 23);
  assert.match(boldFrame, /<strong>\$921\.55 net loss<\/strong>/);
  const completed = render({ text: markdown }, true);
  const fullyRevealed = render({ text: markdown }, false, markdown.length);
  assert.match(completed, /<h2>Summary<\/h2>/);
  assert.match(completed, /<ul>/);
  assert.match(completed, /<em><strong>nested emphasis<\/strong><\/em>|<strong><em>nested emphasis<\/em><\/strong>/);
  assert.match(fullyRevealed, /<strong>\$921\.55 net loss<\/strong>/);
  assert.match(fullyRevealed, /rel="noopener noreferrer"/);
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
