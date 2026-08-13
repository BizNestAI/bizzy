import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const mainSource = read("src/main.jsx");
const confirmationSource = read("src/pages/UserAdmin/EmailConfirmation.jsx");
const authContextSource = read("src/context/AuthContext.jsx");
const authServiceSource = read("src/services/authService.js");
const protectedRouteSource = read("src/components/UserAdmin/ProtectedRoute.jsx");
const cleanupSource = read("src/services/authSessionCleanup.js");

test("root confirmation links are routed to /auth/confirm before dashboard redirect", () => {
  assert.match(mainSource, /function RootRedirect\(\)/);
  assert.match(mainSource, /params\.has\("code"\)/);
  assert.match(mainSource, /params\.has\("token_hash"\)/);
  assert.match(mainSource, /hashParams\.has\("access_token"\)/);
  assert.match(mainSource, /return <Navigate to=\{`\/auth\/confirm\$\{search\}\$\{hash\}`\} replace \/>/);
  assert.match(mainSource, /<Route path="\/" element=\{<RootRedirect \/>\} \/>/);
  assert.doesNotMatch(mainSource, /<Route path="\/" element=\{<Navigate to="\/dashboard\/bizzi\/chat" replace \/>/);
});

test("auth provider does not consume confirmation codes before the confirmation page", () => {
  assert.match(authContextSource, /hasAuthCallbackParams/);
  assert.match(authContextSource, /window\.location\.replace\(`\/auth\/confirm\$\{url\.search\}\$\{url\.hash\}`\)/);
  assert.match(authContextSource, /clearStoredBusinessState\(\);/);
  assert.doesNotMatch(authContextSource, /exchangeCodeForSession\(code\)[\s\S]*url\.searchParams\.delete\("code"\)/);
});

test("email confirmation cannot succeed from a stale existing session without confirmation params", () => {
  assert.match(confirmationSource, /clearStoredBusinessState\(\);/);
  assert.match(confirmationSource, /const code = params\.get\("code"\)/);
  assert.match(confirmationSource, /const tokenHash = params\.get\("token_hash"\)/);
  assert.match(confirmationSource, /const accessToken = params\.get\("access_token"\)/);
  assert.match(confirmationSource, /const refreshToken = params\.get\("refresh_token"\)/);
  assert.match(confirmationSource, /if \(code\) \{/);
  assert.match(confirmationSource, /else if \(tokenHash\) \{/);
  assert.match(confirmationSource, /else if \(accessToken && refreshToken\) \{/);
  assert.match(confirmationSource, /supabase\.auth\.setSession\(\{/);
  assert.match(confirmationSource, /setState\(\{ status: "invalid", message: "" \}\)/);
  assert.doesNotMatch(confirmationSource, /const \{ data \} = await supabase\.auth\.getSession\(\)[\s\S]*setState\(\{ status: "success"/);
});

test("starting signup clears stale auth and business context first", () => {
  assert.match(authServiceSource, /clearStoredAuthAndBusinessState\(\);/);
  assert.match(authServiceSource, /await supabase\.auth\.signOut\(\{ scope: 'local' \}\);/);
  assert.match(authServiceSource, /Local stale auth\/business state has already been cleared\./);
  assert.match(cleanupSource, /"currentBusinessId"/);
  assert.match(cleanupSource, /"business_id"/);
  assert.match(cleanupSource, /"bizzy:onboarding_completed_once"/);
  assert.match(cleanupSource, /"bizzy:qb_connected"/);
  assert.match(cleanupSource, /"bizzy:plaid_connected"/);
});

test("protected route auth failures use the shared stale-state cleanup", () => {
  assert.match(protectedRouteSource, /clearStoredAuthAndBusinessState\(\);/);
  assert.doesNotMatch(protectedRouteSource, /function clearStoredAuthState\(\)/);
});
