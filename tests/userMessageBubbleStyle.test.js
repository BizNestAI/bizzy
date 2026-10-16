/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const css = readFileSync(join(root, "src/index.css"), "utf8");
const canvas = readFileSync(join(root, "src/components/Bizzy/ChatCanvas.jsx"), "utf8");
const history = readFileSync(join(root, "src/components/Bizzy/BizzyChatHistory.jsx"), "utf8");
const bubble = readFileSync(join(root, "src/components/Bizzy/UserMessageBubble.jsx"), "utf8");

test("chat canvas routes only user-authored messages through the shared bubble", () => {
  assert.match(canvas, /import UserMessageBubble from "\.\/UserMessageBubble"/);
  assert.match(canvas, /if \(s === "user"\)[\s\S]*?<UserMessageBubble>\{m\.text\}<\/UserMessageBubble>/);
  assert.doesNotMatch(canvas, /\.bubble-user\s*\{/);
  assert.match(bubble, /"bizzy-user-message"/);
  assert.match(history, /<UserMessageBubble>\{msg\.text\}<\/UserMessageBubble>/);
});

test("user bubble uses restrained semantic surface tokens", () => {
  assert.match(css, /--chat-user-bg:\s*rgba\(255,255,255,0\.055\)/);
  assert.match(css, /--chat-user-border:\s*rgba\(255,255,255,0\.07\)/);
  assert.match(css, /--chat-user-radius:\s*18px/);
  assert.match(css, /\.bizzy-user-message\{[\s\S]*?width:\s*fit-content/);
  assert.match(css, /\.bizzy-user-message\{[\s\S]*?max-width:\s*min\(680px, 70%\)/);
  assert.match(css, /\.bizzy-user-message\{[\s\S]*?padding:\s*10px 17px/);
  assert.match(css, /\.bizzy-user-message\{[\s\S]*?border:\s*1px solid var\(--chat-user-border\)/);
  assert.match(css, /\.bizzy-user-message\{[\s\S]*?box-shadow:\s*none/);
  assert.doesNotMatch(css.match(/\.bizzy-user-message\{[\s\S]*?\}/)?.[0] || "", /gradient|blur|glow/);
});

test("user messages share a full-width right-aligned row with a stable wrap boundary", () => {
  assert.match(css, /\.bizzy-user-message-stack\{[\s\S]*?width:\s*100%/);
  assert.match(css, /\.bizzy-user-message-stack\{[\s\S]*?align-items:\s*flex-end/);
  assert.match(canvas, /className="bizzy-user-message-stack"/);
  assert.match(history, /className="bizzy-user-message-stack"/);
});

test("user bubble wraps rich text safely and stays compact on mobile", () => {
  assert.match(css, /white-space:\s*pre-wrap/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /line-height:\s*1\.45/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*?\.bizzy-user-message\{[\s\S]*?max-width:\s*88%/);
});
