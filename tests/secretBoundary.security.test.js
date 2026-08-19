import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildSafeErrorResponse } from "../src/api/_shared/safeErrorResponse.js";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const FRONTEND_ENTRY = path.join(SRC, "main.jsx");

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
const FORBIDDEN_FRONTEND_RE = /VITE_OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY|PLAID_SECRET|PLAID_TOKEN_ENCRYPTION_KEY|QBO_TOKEN_ENCRYPTION_KEY|QB_(?:SANDBOX_|PROD_)?CLIENT_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|RESEND_API_KEY|GOOGLE_CLIENT_SECRET|GMAIL_CLIENT_SECRET|OPENAI_API_KEY/;
const FORBIDDEN_MODULE_RE = /(?:^|\/)(supabaseAdmin|db|quickbooksTokenService|qboClient|qboEnv|openaiClient|plaidClient|plaidTokenCrypto|qboTokenCrypto)\.js$/;
const SENSITIVE_VITE_RE = /\bVITE_[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE|TOKEN_ENCRYPTION|CLIENT_SECRET|OPENAI_API_KEY|STRIPE_SECRET|PLAID_SECRET|QBO_TOKEN|QB_CLIENT_SECRET|RESEND_API_KEY)[A-Z0-9_]*\b/g;
const SECRET_VALUE_PATTERNS = [
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /sbp_[A-Za-z0-9_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  /sk_live_[A-Za-z0-9]+/g,
  /rk_live_[A-Za-z0-9]+/g,
  /re_[A-Za-z0-9]{32,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function read(file) {
  return readFileSync(file, "utf8");
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveImport(fromFile, specifier) {
  if (!specifier?.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && candidate.startsWith(SRC)) || null;
}

function collectFrontendGraph(entry = FRONTEND_ENTRY) {
  const visited = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = read(file);
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveImport(file, match[1] || match[2]);
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }
  return visited;
}

function trackedFilesForSensitiveViteNameScan() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((file) => isFile(path.join(ROOT, file)))
    .filter((file) =>
      !file.startsWith("node_modules/") &&
      !file.startsWith("dist/") &&
      !file.startsWith("tests/")
    );
}

function collectSensitiveViteNameFindings(files, readSource = (file) => read(path.join(ROOT, file))) {
  const findings = [];
  for (const file of files) {
    const source = readSource(file);
    for (const match of source.matchAll(SENSITIVE_VITE_RE)) {
      findings.push(`${file}: ${match[0]}`);
    }
  }
  return findings;
}

test("frontend import graph has no server-only credential modules or secret env references", () => {
  const files = collectFrontendGraph();
  const failures = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const source = read(file);
    if (FORBIDDEN_MODULE_RE.test(file)) failures.push(`${relative}: imports server-only module`);
    if (FORBIDDEN_FRONTEND_RE.test(source)) failures.push(`${relative}: references server secret env/module name`);
  }
  assert.deepEqual(failures, []);
});

test("known sensitive env names are not VITE-prefixed", () => {
  const findings = collectSensitiveViteNameFindings(trackedFilesForSensitiveViteNameScan());
  assert.deepEqual(findings, []);
});

test("repo-wide sensitive VITE scan excludes test fixtures but still catches production files", () => {
  const files = trackedFilesForSensitiveViteNameScan();
  assert.equal(files.some((file) => file.startsWith("tests/")), false);

  const findings = collectSensitiveViteNameFindings(
    ["src/client-fixture.js"],
    () => "const leaked = import.meta.env.VITE_QBO_SECRET || import.meta.env.VITE_OPENAI_API_KEY;"
  );
  assert.deepEqual(findings, [
    "src/client-fixture.js: VITE_QBO_SECRET",
    "src/client-fixture.js: VITE_OPENAI_API_KEY",
  ]);
});

test("gitignore has no merge markers and keeps real env files ignored", () => {
  const gitignore = read(path.join(ROOT, ".gitignore"));
  assert.equal(/<<<<<<<|=======|>>>>>>>/.test(gitignore), false);
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
});

test("tracked source does not contain obvious committed secret values", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((file) => isFile(path.join(ROOT, file)))
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("reports/") && !file.startsWith("tests/"));
  const findings = [];
  for (const file of files) {
    const source = read(path.join(ROOT, file));
    for (const pattern of SECRET_VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) findings.push(file);
    }
  }
  assert.deepEqual([...new Set(findings)], []);
});

test("production error responses hide stack, meta, details, and provider payloads", () => {
  const err = new Error("database exploded at /app/src/server.js");
  err.status = 500;
  err.meta = {
    stack: "at /Users/person/project/src/file.js",
    details: "SQL details",
    providerResponse: { access_token: "secret-fixture-token" },
  };

  const { status, body } = buildSafeErrorResponse(err, { env: { NODE_ENV: "production" } });
  assert.equal(status, 500);
  assert.equal(body.message, "Internal Server Error");
  assert.equal(JSON.stringify(body).includes("/Users/"), false);
  assert.equal(JSON.stringify(body).includes("SQL details"), false);
  assert.equal(JSON.stringify(body).includes("secret-fixture-token"), false);
  assert.equal(Object.hasOwn(body, "meta"), false);
});
