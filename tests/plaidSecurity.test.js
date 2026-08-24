import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const plaidRoutesSource = readFileSync(join(root, "src/api/integrations/plaid.routes.js"), "utf8");
const plaidIntegrationSource = readFileSync(join(root, "src/services/plaid/plaidIntegrationService.js"), "utf8");
const plaidSyncSource = readFileSync(join(root, "src/services/plaid/plaidSyncService.js"), "utf8");
const plaidMigrationSource = readFileSync(join(root, "src/services/plaid/plaidTokenMigration.js"), "utf8");
const legacyPlaidControllerSource = readFileSync(join(root, "src/api/investments/plaid.controller.js"), "utf8");
const legacyBalancesSource = readFileSync(join(root, "src/api/investments/balances.service.js"), "utf8");
const legacyPlaidServiceSource = readFileSync(join(root, "src/api/investments/plaid.service.js"), "utf8");
const legacyCryptoUtilSource = readFileSync(join(root, "src/api/investments/crypto.util.js"), "utf8");
const integrationManagerSource = readFileSync(join(root, "src/hooks/useIntegrationManager.js"), "utf8");
const settingsSource = readFileSync(join(root, "src/pages/Settings/SettingsHome.jsx"), "utf8");

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function withPlaidKey() {
  process.env.PLAID_TOKEN_ENCRYPTION_KEY = TEST_KEY;
  delete process.env.ENCRYPTION_KEY_32B;
}

function makeMigrationSupabase(rows) {
  const updates = [];
  return {
    updates,
    from(table) {
      assert.equal(table, "plaid_items");
      return {
        select(columns) {
          assert.match(columns, /plaid_access_token/);
          return {
            async limit() {
              return { data: rows, error: null };
            },
          };
        },
        update(payload) {
          const filters = [];
          const query = {
            eq(field, value) {
              filters.push([field, value]);
              return this;
            },
            then(resolve, reject) {
              try {
                updates.push({ payload, filters });
                rows
                  .filter((row) => filters.every(([field, value]) => row[field] === value))
                  .forEach((row) => Object.assign(row, payload));
                resolve({ error: null });
              } catch (err) {
                reject(err);
              }
            },
          };
          return query;
        },
      };
    },
  };
}

test("Plaid token crypto uses randomized AES-GCM envelopes and fails closed on tampering", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?case=${Date.now()}`);

  const token = "access-sandbox-test-token";
  const first = cryptoMod.encryptPlaidAccessToken(token);
  const second = cryptoMod.encryptPlaidAccessToken(token);

  assert.match(first, /^enc:v1:/);
  assert.match(second, /^enc:v1:/);
  assert.notEqual(first, second);
  assert.equal(cryptoMod.decryptPlaidAccessToken(first), token);

  const raw = Buffer.from(first.slice("enc:v1:".length), "base64");
  raw[raw.length - 1] ^= 0xff;
  assert.throws(() => cryptoMod.decryptPlaidAccessToken(`enc:v1:${raw.toString("base64")}`));
});

test("Plaid production requires dedicated token encryption key and rejects shared fallback", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import './src/services/plaid/plaidTokenCrypto.js';",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PLAID_TOKEN_ENCRYPTION_KEY: "",
        ENCRYPTION_KEY_32B: TEST_KEY,
      },
      encoding: "utf8",
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /plaid_token_encryption_key_missing/);
});

test("Plaid production import fails closed without token encryption key", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import './src/services/plaid/plaidTokenCrypto.js';",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PLAID_TOKEN_ENCRYPTION_KEY: "",
        ENCRYPTION_KEY_32B: "",
      },
      encoding: "utf8",
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /plaid_token_encryption_key_missing/);
});

test("Plaid public-token exchange responses do not expose access token fields", () => {
  const responseSources = [
    legacyPlaidControllerSource,
    legacyBalancesSource,
    plaidRoutesSource,
    plaidIntegrationSource,
  ].join("\n");

  assert.doesNotMatch(responseSources, /res\.json\([^)]*access_token/i);
  assert.doesNotMatch(responseSources, /return\s+\{[^}]*access_token_saved/i);
  assert.doesNotMatch(responseSources, /return\s+res\.json\([^)]*plaid_access_token/i);
  assert.match(legacyPlaidControllerSource, /return res\.json\(\{ item_id, mode: 'plaid', connected: true \}\)/);
});

test("Plaid integration stores encrypted credentials and server-side sync decrypts them", () => {
  assert.match(plaidIntegrationSource, /plaid_access_token:\s*encryptPlaidAccessToken\(access_token\)/);
  assert.match(plaidSyncSource, /resolveStoredPlaidAccessToken/);
  assert.match(plaidSyncSource, /access_token:\s*accessToken/);
  assert.doesNotMatch(plaidSyncSource, /access_token:\s*item\.plaid_access_token/);
});

test("active Plaid credential write paths use encryption helpers", () => {
  assert.match(plaidIntegrationSource, /plaid_access_token:\s*encryptPlaidAccessToken\(access_token\)/);
  assert.doesNotMatch(plaidIntegrationSource, /plaid_access_token:\s*access_token[,}]/);
  assert.match(legacyPlaidServiceSource, /const enc = encrypt\(access_token\)/);
  assert.match(legacyPlaidServiceSource, /access_token_enc:\s*enc\.toString\('base64'\)/);
  assert.match(legacyCryptoUtilSource, /encryptPlaidAccessToken\(plain\)/);
  assert.match(plaidMigrationSource, /encryptPlaidAccessToken\(row\.plaid_access_token\)/);
});

test("Plaid legacy token migration encrypts plaintext, skips encrypted rows, and leaves malformed rows untouched", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?migrationCrypto=${Date.now()}`);
  const migrationMod = await import(`../src/services/plaid/plaidTokenMigration.js?migration=${Date.now()}`);
  const legacyPlaintext = "access-sandbox-legacy-secret";
  const encrypted = cryptoMod.encryptPlaidAccessToken("access-sandbox-current-secret");
  const rows = [
    { id: "row-current", business_id: "biz-a", plaid_item_id: "item-current", plaid_access_token: encrypted },
    { id: "row-legacy", business_id: "biz-a", plaid_item_id: "item-legacy", plaid_access_token: legacyPlaintext },
    { id: "row-bad", business_id: "biz-a", plaid_item_id: "item-bad", plaid_access_token: "not-a-plaid-token" },
  ];
  const supabase = makeMigrationSupabase(rows);

  const dryRun = await migrationMod.migratePlaidItemAccessTokens({ supabaseClient: supabase, apply: false });
  assert.equal(supabase.updates.length, 0);
  assert.equal(dryRun.summary.already_encrypted, 1);
  assert.equal(dryRun.summary.would_encrypt, 1);
  assert.equal(dryRun.summary.needs_attention, 1);
  assert.doesNotMatch(JSON.stringify(dryRun), /legacy-secret|current-secret/);

  const applied = await migrationMod.migratePlaidItemAccessTokens({ supabaseClient: supabase, apply: true });
  assert.equal(applied.summary.encrypted, 1);
  assert.equal(supabase.updates.length, 1);
  assert.match(rows[1].plaid_access_token, /^enc:v1:/);
  assert.equal(cryptoMod.decryptPlaidAccessToken(rows[1].plaid_access_token), legacyPlaintext);
  assert.equal(rows[2].plaid_access_token, "not-a-plaid-token");
  assert.doesNotMatch(JSON.stringify(applied), /legacy-secret|current-secret/);

  const second = await migrationMod.migratePlaidItemAccessTokens({ supabaseClient: supabase, apply: true });
  assert.equal(second.summary.already_encrypted, 2);
  assert.equal(second.summary.needs_attention, 1);
  assert.equal(supabase.updates.length, 1);
});

test("Plaid legacy token migration fails closed without valid crypto configuration", async () => {
  const oldPlaidKey = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  const oldSharedKey = process.env.ENCRYPTION_KEY_32B;
  delete process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY_32B;
  try {
    const migrationMod = await import(`../src/services/plaid/plaidTokenMigration.js?missingKey=${Date.now()}`);
    await assert.rejects(
      migrationMod.migratePlaidItemAccessTokens({
        supabaseClient: makeMigrationSupabase([
          {
            id: "row-legacy",
            business_id: "biz-a",
            plaid_item_id: "item-legacy",
            plaid_access_token: "access-sandbox-legacy-secret",
          },
        ]),
        apply: true,
      }),
      /plaid_token_encryption_key_missing/
    );
  } finally {
    if (oldPlaidKey) process.env.PLAID_TOKEN_ENCRYPTION_KEY = oldPlaidKey;
    if (oldSharedKey) process.env.ENCRYPTION_KEY_32B = oldSharedKey;
  }
});

test("Plaid lazy migration upgrades plaintext without returning it in persistence output", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?lazy=${Date.now()}`);
  const legacyPlaintext = "access-sandbox-lazy-secret";
  let persisted = null;

  const resolved = await cryptoMod.resolveStoredPlaidAccessToken({
    storedToken: legacyPlaintext,
    persistEncrypted: async (encrypted) => {
      persisted = encrypted;
    },
  });

  assert.equal(resolved, legacyPlaintext);
  assert.match(persisted, /^enc:v1:/);
  assert.equal(cryptoMod.decryptPlaidAccessToken(persisted), legacyPlaintext);

  let rewrote = false;
  const resolvedAgain = await cryptoMod.resolveStoredPlaidAccessToken({
    storedToken: persisted,
    persistEncrypted: async () => {
      rewrote = true;
    },
  });
  assert.equal(resolvedAgain, legacyPlaintext);
  assert.equal(rewrote, false);
});

test("Plaid credential classifiers distinguish current, legacy encrypted, plaintext, and invalid formats", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?classifyCrypto=${Date.now()}`);
  const migrationMod = await import(`../src/services/plaid/plaidTokenMigration.js?classify=${Date.now()}`);
  const encrypted = cryptoMod.encryptPlaidAccessToken("access-sandbox-classified-secret");
  const legacyBlob = encrypted.slice("enc:v1:".length);

  assert.equal(migrationMod.classifyPlaidItemCredential(encrypted).format, "ENCRYPTED_CURRENT");
  assert.equal(migrationMod.classifyPlaidItemCredential("access-sandbox-legacy-secret").format, "PLAINTEXT_LEGACY");
  assert.equal(migrationMod.classifyPlaidItemCredential(legacyBlob).format, "INVALID");
  assert.equal(migrationMod.classifyLinkedFinancialItemCredential(legacyBlob).format, "ENCRYPTED_LEGACY");
  assert.equal(migrationMod.classifyLinkedFinancialItemCredential("not-valid").format, "INVALID");
});

test("Plaid exchange rejects the same Plaid item attached to another business", () => {
  assert.match(plaidIntegrationSource, /\.eq\("plaid_item_id", item_id\)/);
  assert.match(plaidIntegrationSource, /\.neq\("business_id", businessId\)/);
  assert.match(plaidIntegrationSource, /plaid_item_already_linked/);
});

test("Plaid browser routes remain auth-protected and tenant-scoped by server mounts", () => {
  const serverSource = readFileSync(join(root, "src/server.js"), "utf8");
  const investmentsRoutesSource = readFileSync(join(root, "src/api/investments/investments.routes.js"), "utf8");

  assert.match(serverSource, /const requireCustomerOrAdminView = \[requireAuthOrAdminView, requireBusinessContext, rejectAdminViewWrites\(\)\]/);
  assert.match(serverSource, /app\.use\("\/api\/integrations\/plaid", \.\.\.requireCustomerOrAdminView, plaidIntegrationsRouter\)/);
  assert.match(investmentsRoutesSource, /router\.post\('\/plaid\/create-link-token', ensureAuthIds, requireVerifiedBusiness, createLinkToken\)/);
  assert.match(investmentsRoutesSource, /router\.post\('\/plaid\/exchange-public-token', ensureAuthIds, requireVerifiedBusiness, exchangePublicToken\)/);
  assert.match(plaidRoutesSource, /router\.post\("\/disconnect-item", requireAuth,/);
});

test("Plaid disconnect decrypts server-side and does not trust known foreign item IDs alone", () => {
  assert.match(plaidRoutesSource, /\.eq\("business_id", businessId\)\s*\.eq\("plaid_item_id", plaidItemId\)/);
  assert.match(plaidRoutesSource, /resolveStoredPlaidAccessToken/);
  assert.doesNotMatch(plaidRoutesSource, /itemRemove\(\{ access_token: item\.plaid_access_token \}\)/);
});

test("Plaid destructive disconnect cannot be enabled by a browser-controlled admin header", () => {
  assert.doesNotMatch(plaidRoutesSource, /x-bizzi-admin/);
  assert.match(plaidRoutesSource, /process\.env\.ADMIN_API_KEY/);
  assert.match(plaidRoutesSource, /process\.env\.NODE_ENV !== "production" && process\.env\.PLAID_DELETE_DATA_ENABLED === "true"/);
});

test("Plaid error handling redacts provider token fields", async () => {
  const { redactPlaidSecrets, safePlaidErrorPayload } = await import("../src/services/plaid/plaidSecurity.js");
  const payload = redactPlaidSecrets({
    access_token: "access-sandbox-secret",
    nested: { public_token: "public-sandbox-secret", ok: "visible" },
  });
  assert.deepEqual(payload, {
    access_token: "[redacted]",
    nested: { public_token: "[redacted]", ok: "visible" },
  });

  const safe = safePlaidErrorPayload({
    response: {
      data: {
        error_code: "ITEM_LOGIN_REQUIRED",
        error_type: "ITEM_ERROR",
        access_token: "access-sandbox-secret",
        request_id: "req-1",
      },
    },
  });
  assert.deepEqual(safe, {
    error_code: "ITEM_LOGIN_REQUIRED",
    error_type: "ITEM_ERROR",
    display_message: null,
    request_id: "req-1",
  });
});

test("frontend Plaid code does not depend on provider access tokens", () => {
  const frontendPlaidSources = [integrationManagerSource, settingsSource].join("\n");
  assert.doesNotMatch(frontendPlaidSources, /plaid_access_token|processor_token|PLAID_SECRET|PLAID_CLIENT_SECRET/i);
  assert.doesNotMatch(frontendPlaidSources, /exchangeRes\?\.access_token|access_token\s*[:=]\s*exchangeRes/i);
  assert.match(frontendPlaidSources, /link_token|linkToken/);
});
