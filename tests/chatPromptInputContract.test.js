import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeChatPromptInput } from "../src/utils/chatPromptInput.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("typed and structured prompts normalize to one explicit contract", () => {
  assert.deepEqual(normalizeChatPromptInput("  How did I perform?  "), {
    text: "How did I perform?",
    intent: null,
  });
  assert.deepEqual(
    normalizeChatPromptInput({
      text: "  Which income categories led?  ",
      intent: "  financial_income_categories  ",
    }),
    {
      text: "Which income categories led?",
      intent: "financial_income_categories",
    }
  );
});

test("unsupported prompt values are rejected without string methods throwing", () => {
  for (const value of [null, undefined, 42, true, [], {}, { text: 42 }]) {
    assert.doesNotThrow(() => normalizeChatPromptInput(value));
    assert.equal(normalizeChatPromptInput(value).text, "");
  }
});

test("new-thread and in-thread quick prompts share structured normalization", () => {
  const persistentBar = read("src/components/Bizzy/BizzyChatBar.jsx");
  const canvasBar = read("src/components/Bizzy/ChatCanvasBar.jsx");
  const context = read("src/context/BizzyChatContext.jsx");
  const hook = read("src/hooks/useBizzyChat.js");

  for (const source of [persistentBar, canvasBar, context, hook]) {
    assert.match(source, /normalizeChatPromptInput/);
  }
  assert.match(canvasBar, /intent: intent \|\| "general"/);
  assert.match(context, /intent: messageOptions\.intent \|\| normalizedInput\.intent/);
  assert.match(hook, /const resolvedIntent = intent \|\| normalizedInput\.intent/);
  assert.doesNotMatch(hook, /userInput\?\.trim\(\)/);
  assert.doesNotMatch(hook, /userInput\.trim\(\)/);
});

test("client-side invalid prompts return before request creation and fetch", () => {
  const hook = read("src/hooks/useBizzyChat.js");
  const normalizeAt = hook.indexOf("normalizeChatPromptInput(userInput)");
  const guardAt = hook.indexOf("if (!normalizedInput.text || isLoading) return", normalizeAt);
  const requestAt = hook.indexOf("const requestId", guardAt);
  const fetchAt = hook.indexOf("safeFetch(primary", requestAt);
  assert.ok(normalizeAt > 0 && normalizeAt < guardAt && guardAt < requestAt && requestAt < fetchAt);
});
