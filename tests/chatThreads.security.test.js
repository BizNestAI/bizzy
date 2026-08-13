import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const hookSource = readFileSync(join(root, "src/hooks/useChatThreads.js"), "utf8");
const safeFetchSource = readFileSync(join(root, "src/utils/safeFetch.js"), "utf8");
const serverSource = readFileSync(join(root, "src/server.js"), "utf8");
const contextSource = readFileSync(join(root, "src/context/BizzyChatContext.jsx"), "utf8");

test("chat thread hook uses canonical authenticated request helper for /api/chats", () => {
  assert.match(hookSource, /import \{ apiUrl, safeFetch \} from ['"]\.\.\/utils\/safeFetch['"]/);
  assert.match(hookSource, /safeFetch\(url\.toString\(\),/);
  assert.match(hookSource, /safeFetch\(apiUrl\(`\/api\/chats\/\$\{id\}`\),/);
  assert.doesNotMatch(hookSource, /\bfetch\(/);
});

test("chat thread hook does not provide a client-selected user id for authorization", () => {
  assert.doesNotMatch(hookSource, /useAuth/);
  assert.doesNotMatch(hookSource, /x-user-id/);
  assert.doesNotMatch(hookSource, /userIdRef/);
  assert.doesNotMatch(hookSource, /localStorage\.getItem\(['"]user_id['"]\)/);
});

test("chat thread requests continue to carry tenant business context", () => {
  assert.match(hookSource, /url\.searchParams\.set\('business_id', businessId\)/);
  assert.match(hookSource, /headers:\s*\{\s*'x-business-id': businessId\s*\}/);
});

test("canonical request helper attaches Supabase bearer credentials", () => {
  assert.match(safeFetchSource, /const token = await getFreshAccessToken\(\)/);
  assert.match(safeFetchSource, /supabase\.auth\.getSession\(\)/);
  assert.match(safeFetchSource, /headers\.set\("Authorization", `Bearer \$\{token\}`\)/);
});

test("/api/chats remains protected by auth and tenant middleware", () => {
  assert.match(
    serverSource,
    /app\.use\("\/api\/chats", requireAuth, requireBusinessContext, chatsRoutes\)/
  );
});

test("all frontend /api/chats callers use safeFetch instead of raw fetch", () => {
  for (const [file, source] of [
    ["src/hooks/useChatThreads.js", hookSource],
    ["src/context/BizzyChatContext.jsx", contextSource],
  ]) {
    assert.match(source, /safeFetch/, `${file} should use safeFetch for chat API calls`);
    assert.doesNotMatch(source, /fetch\([^)]*\/api\/chats/, `${file} must not raw-fetch /api/chats`);
  }
});
