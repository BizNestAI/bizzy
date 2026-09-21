/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const css = readFileSync(join(root, "src/index.css"), "utf8");
const composer = readFileSync(join(root, "src/components/Bizzy/BizzyChatComposer.jsx"), "utf8");
const chatBar = readFileSync(join(root, "src/components/Bizzy/BizzyChatBar.jsx"), "utf8");
const canvasBar = readFileSync(join(root, "src/components/Bizzy/ChatCanvasBar.jsx"), "utf8");
const submitButton = readFileSync(join(root, "src/components/Bizzy/BizzySubmitButton.jsx"), "utf8");

test("Bizzi chat bars share the same composer implementation", () => {
  assert.match(chatBar, /import BizzyChatComposer from "\.\/BizzyChatComposer"/);
  assert.match(canvasBar, /import BizzyChatComposer from "\.\/BizzyChatComposer"/);
  assert.match(chatBar, /<BizzyChatComposer/);
  assert.match(canvasBar, /<BizzyChatComposer/);
  assert.doesNotMatch(chatBar, /<textarea[\s\S]*<BizzySubmitButton/);
  assert.doesNotMatch(canvasBar, /<textarea[\s\S]*<BizzySubmitButton/);
  assert.doesNotMatch(chatBar + canvasBar, /no-purple-glow/);
});

test("shared composer keeps keyboard, multiline, quick prompts, and send affordances", () => {
  assert.match(composer, /if \(event\.key === "Enter" && !event\.shiftKey\)/);
  assert.match(composer, /handleSubmit\(event\)/);
  assert.match(composer, /Math\.min\(el\.scrollHeight, 150\)/);
  assert.doesNotMatch(composer, /BizzyVoiceIcon|<Mic/);
  assert.match(composer, /<Sparkles/);
  assert.match(composer, /title="Quick prompts"/);
  assert.match(composer, /aria-expanded=\{quickPromptsOpen\}/);
  assert.match(composer, /aria-controls=\{promptPanelId\}/);
  assert.match(composer, /inert=\{!quickPromptsOpen\}/);
  assert.match(composer, /setQuickPromptsOpen\(false\)/);
  assert.match(composer, /<BizzySubmitButton/);
  assert.match(composer, /aria-disabled/);
  assert.match(composer, /placeholder=\{unavailable \? "Chat is unavailable in read-only Admin View\."/);
});

test("quick prompts start closed and use a content-sized reduced-motion-safe transition", () => {
  assert.match(composer, /useState\(false\)/);
  assert.match(css, /\.bizzy-quick-prompts-panel\{[\s\S]*?grid-template-rows:\s*0fr/);
  assert.match(css, /\.bizzy-quick-prompts-panel\.is-open\{[\s\S]*?grid-template-rows:\s*1fr/);
  assert.match(css, /\.bizzy-quick-prompts-panel\.is-open\{[\s\S]*?margin-bottom:\s*8px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bizzy-quick-prompts-panel/);
});

test("composer visual tokens are subtle and green is reserved for focus or send-ready states", () => {
  assert.match(css, /--chat-composer-bg:\s*#20211f/);
  assert.match(css, /--chat-composer-border:\s*rgba\(255,255,255,0\.09\)/);
  assert.match(css, /--chat-composer-border-hover:\s*rgba\(255,255,255,0\.14\)/);
  assert.match(css, /--chat-composer-border-focus:\s*rgba\(62,220,158,0\.42\)/);
  assert.match(css, /\.bizzy-chat-composer\{[\s\S]*?border:\s*1px solid var\(--chat-composer-border\)/);
  assert.match(css, /\.bizzy-chat-composer\{[\s\S]*?border-radius:\s*26px/);
  assert.match(css, /\.bizzy-chat-composer:focus-within\{[\s\S]*?var\(--chat-composer-border-focus\)/);
  assert.doesNotMatch(css, /\.bizzy-chat-composer\{[\s\S]*?var\(--accent-line\)/);
});

test("composer controls are embedded and send button has distinct ready state", () => {
  assert.match(css, /\.bizzy-chat-composer__control\{[\s\S]*?var\(--chat-composer-control-bg\)/);
  assert.match(css, /\.bizzy-chat-composer__control\{[\s\S]*?var\(--chat-composer-control-border\)/);
  assert.match(submitButton, /active && !disabled && !isLoading/);
  assert.match(submitButton, /rgba\(var\(--accent-rgb\),0\.20\)/);
  assert.match(submitButton, /var\(--chat-composer-control-bg\)/);
});

test("quick prompt chips are visually lighter than the composer and remain focusable", () => {
  assert.match(css, /\[data-bizzy-chip\],[\s\S]*?border-color:\s*rgba\(255,255,255,0\.09\) !important/);
  assert.match(css, /\[data-bizzy-chip\],[\s\S]*?background:\s*rgba\(255,255,255,0\.035\) !important/);
  assert.match(css, /\[data-bizzy-chip\]:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
