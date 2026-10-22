/* global process, Buffer */
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
const TEST_KEY_K2 = Buffer.alloc(32, 8).toString("base64");

function withPlaidKey() {
  process.env.PLAID_TOKEN_ENCRYPTION_KEY = TEST_KEY;
  process.env.PLAID_TOKEN_ENCRYPTION_KEY_K2 = TEST_KEY_K2;
  process.env.PLAID_TOKEN_ACTIVE_KEY_ID = "k2";
  delete process.env.ENCRYPTION_KEY_32B;
}

function makeMigrationSupabase(rows, { forceConflictIds = [] } = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      const tableRows = rows.filter((row) => (row.table || "plaid_items") === table);
      return {
        select() {
          const filters = [];
          let max = tableRows.length;
          const query = {
            not(field, operator) {
              assert.equal(operator, "is");
              filters.push((row) => row[field] !== null && row[field] !== undefined);
              return this;
            },
            order() { return this; },
            eq(field, value) {
              filters.push((row) => row[field] === value);
              return this;
            },
            async limit(value) {
              max = value;
              return { data: tableRows.filter((row) => filters.every((fn) => fn(row))).slice(0, max), error: null };
            },
          };
          return query;
        },
        update(payload) {
          const filters = [];
          const query = {
            eq(field, value) {
              filters.push([field, value]);
              return this;
            },
            select() { return this; },
            async maybeSingle() {
              const match = tableRows.find((row) => filters.every(([field, value]) => row[field] === value));
              if (!match || forceConflictIds.includes(match.id)) return { data: null, error: null };
              updates.push({ table, payload, filters });
              Object.assign(match, payload);
              return { data: { id: match.id }, error: null };
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

  assert.match(first, /^enc:v2:k2:/);
  assert.match(second, /^enc:v2:k2:/);
  assert.notEqual(first, second);
  assert.equal(cryptoMod.decryptPlaidAccessToken(first), token);

  const raw = Buffer.from(first.slice("enc:v2:k2:".length), "base64");
  raw[raw.length - 1] ^= 0xff;
  assert.throws(() => cryptoMod.decryptPlaidAccessToken(`enc:v2:k2:${raw.toString("base64")}`));
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
        PLAID_TOKEN_ENCRYPTION_KEY_K2: TEST_KEY_K2,
        PLAID_TOKEN_ACTIVE_KEY_ID: "k2",
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
        PLAID_TOKEN_ENCRYPTION_KEY_K2: "",
        PLAID_TOKEN_ACTIVE_KEY_ID: "k2",
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
  assert.match(plaidMigrationSource, /encryptPlaidAccessToken\(plain\)/);
});

test("Plaid legacy token migration encrypts plaintext, skips encrypted rows, and leaves malformed rows untouched", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?migrationCrypto=${Date.now()}`);
  const migrationMod = await import(`../src/services/plaid/plaidTokenMigration.js?migration=${Date.now()}`);
  const legacyPlaintext = "access-sandbox-legacy-secret";
  const encrypted = cryptoMod.encryptPlaidAccessTokenLegacyV1("access-sandbox-current-secret");
  const rows = [
    { id: "row-current", business_id: "biz-a", plaid_item_id: "item-current", plaid_access_token: encrypted },
    { id: "row-legacy", business_id: "biz-a", plaid_item_id: "item-legacy", plaid_access_token: legacyPlaintext },
    { id: "row-bad", business_id: "biz-a", plaid_item_id: "item-bad", plaid_access_token: "not-a-plaid-token" },
  ];
  const supabase = makeMigrationSupabase(rows);

  const dryRun = await migrationMod.migratePlaidItemAccessTokens({ supabaseClient: supabase, apply: false });
  assert.equal(supabase.updates.length, 0);
  assert.equal(dryRun.summary.would_migrate, 2);
  assert.equal(dryRun.summary.needs_attention, 1);
  assert.doesNotMatch(JSON.stringify(dryRun), /legacy-secret|current-secret/);

  const applied = await migrationMod.migratePlaidItemAccessTokens({ supabaseClient: supabase, apply: true });
  assert.equal(applied.summary.migrated, 2);
  assert.equal(supabase.updates.length, 2);
  assert.match(rows[1].plaid_access_token, /^enc:v2:k2:/);
  assert.equal(cryptoMod.decryptPlaidAccessToken(rows[1].plaid_access_token), legacyPlaintext);
  assert.equal(rows[2].plaid_access_token, "not-a-plaid-token");
  assert.doesNotMatch(JSON.stringify(applied), /legacy-secret|current-secret/);

  const second = await migrationMod.migratePlaidItemAccessTokens({ supabaseClient: supabase, apply: true });
  assert.equal(second.summary.already_current, 2);
  assert.equal(second.summary.needs_attention, 1);
  assert.equal(supabase.updates.length, 2);
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

test("Plaid runtime rejects plaintext outside the bounded migration", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?lazy=${Date.now()}`);
  const legacyPlaintext = "access-sandbox-lazy-secret";
  await assert.rejects(
    cryptoMod.resolveStoredPlaidAccessToken({ storedToken: legacyPlaintext }),
    /plaid_access_token_migration_required/
  );
});

test("Plaid credential classifiers distinguish current, legacy encrypted, plaintext, and invalid formats", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?classifyCrypto=${Date.now()}`);
  const migrationMod = await import(`../src/services/plaid/plaidTokenMigration.js?classify=${Date.now()}`);
  const encrypted = cryptoMod.encryptPlaidAccessToken("access-sandbox-classified-secret");
  const legacy = cryptoMod.encryptPlaidAccessTokenLegacyV1("access-sandbox-legacy-encrypted");
  const legacyBlob = legacy.slice("enc:v1:".length);

  assert.equal(migrationMod.classifyPlaidItemCredential(encrypted).format, "V2_K2");
  assert.equal(migrationMod.classifyPlaidItemCredential(legacy).format, "V1_K1");
  assert.equal(migrationMod.classifyPlaidItemCredential("access-sandbox-legacy-secret").format, "PLAINTEXT_LEGACY");
  assert.equal(migrationMod.classifyPlaidItemCredential(legacyBlob).format, "INVALID");
  assert.equal(migrationMod.classifyLinkedFinancialItemCredential(legacyBlob).format, "INVESTMENT_V1_K1");
  assert.equal(migrationMod.classifyLinkedFinancialItemCredential("not-valid").format, "INVALID");
});

test("Plaid keyring reads v1 with k1 and selects k2 for v2 during mixed-key deployment", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?mixed=${Date.now()}`);
  const plain = "access-sandbox-mixed-key-token";
  const v1 = cryptoMod.encryptPlaidAccessTokenLegacyV1(plain);
  const v2 = cryptoMod.encryptPlaidAccessToken(plain);
  assert.equal(cryptoMod.decryptPlaidAccessToken(v1), plain);
  assert.equal(cryptoMod.decryptPlaidAccessToken(v2), plain);
  assert.match(v1, /^enc:v1:/);
  assert.match(v2, /^enc:v2:k2:/);
});

test("Plaid v2 rejects the wrong k2 and authenticated-envelope tampering", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?wrong=${Date.now()}`);
  const encrypted = cryptoMod.encryptPlaidAccessToken("access-sandbox-wrong-key-token");
  process.env.PLAID_TOKEN_ENCRYPTION_KEY_K2 = Buffer.alloc(32, 9).toString("base64");
  assert.throws(() => cryptoMod.decryptPlaidAccessToken(encrypted));
  process.env.PLAID_TOKEN_ENCRYPTION_KEY_K2 = TEST_KEY_K2;
  const payload = Buffer.from(encrypted.slice("enc:v2:k2:".length), "base64");
  payload[29] ^= 1;
  assert.throws(() => cryptoMod.decryptPlaidAccessToken(`enc:v2:k2:${payload.toString("base64")}`));
});

test("bounded migration uses CAS, reports conflicts, and replay is idempotent without leaking credentials", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?casCrypto=${Date.now()}`);
  const migrationMod = await import(`../src/services/plaid/plaidTokenMigration.js?cas=${Date.now()}`);
  const secretA = "access-sandbox-plaintext-migration-token";
  const secretB = "access-sandbox-v1-migration-token";
  const rows = [
    { id: "plain-row", table: "plaid_items", plaid_access_token: secretA },
    { id: "conflict-row", table: "plaid_items", plaid_access_token: cryptoMod.encryptPlaidAccessTokenLegacyV1(secretB) },
  ];
  const db = makeMigrationSupabase(rows, { forceConflictIds: ["conflict-row"] });
  const dryRun = await migrationMod.migratePlaidTokens({ supabaseClient: db, apply: false, limit: 10 });
  assert.equal(dryRun.summary.would_migrate, 2);
  assert.equal(db.updates.length, 0);
  const applied = await migrationMod.migratePlaidTokens({ supabaseClient: db, apply: true, limit: 10 });
  assert.equal(applied.summary.migrated, 1);
  assert.equal(applied.summary.conflict, 1);
  assert.match(rows[0].plaid_access_token, /^enc:v2:k2:/);
  assert.equal(cryptoMod.decryptPlaidAccessToken(rows[0].plaid_access_token), secretA);
  const serialized = JSON.stringify(applied);
  assert.doesNotMatch(serialized, /plaintext-migration-token|v1-migration-token|enc:v[12]:/);
  const replay = await migrationMod.migratePlaidTokens({ supabaseClient: db, apply: true, limit: 10 });
  assert.equal(replay.summary.already_current, 1);
  assert.equal(replay.summary.conflict, 1);
  assert.equal(db.updates.length, 1);
});

test("investment-column legacy payload remains readable and migrates to a versioned k2 envelope", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?investmentCrypto=${Date.now()}`);
  const migrationMod = await import(`../src/services/plaid/plaidTokenMigration.js?investmentMigration=${Date.now()}`);
  const investmentCrypto = await import(`../src/api/investments/crypto.util.js?investment=${Date.now()}`);
  const plain = "access-sandbox-investment-token";
  const v1 = cryptoMod.encryptPlaidAccessTokenLegacyV1(plain);
  const legacyBlob = v1.slice("enc:v1:".length);
  assert.equal(investmentCrypto.decrypt(legacyBlob), plain);
  const rows = [{ id: "investment-row", table: "linked_financial_items", provider: "plaid", access_token_enc: legacyBlob }];
  const db = makeMigrationSupabase(rows);
  const report = await migrationMod.migratePlaidTokens({ supabaseClient: db, apply: true, limit: 10 });
  assert.equal(report.summary.migrated, 1);
  assert.equal(investmentCrypto.decrypt(rows[0].access_token_enc), plain);
  assert.match(Buffer.from(rows[0].access_token_enc, "base64").toString("utf8"), /^enc:v2:k2:/);
});

test("rotation verifier requires the expected active count and authenticated k2 credentials", async () => {
  withPlaidKey();
  const cryptoMod = await import(`../src/services/plaid/plaidTokenCrypto.js?verifyCrypto=${Date.now()}`);
  const migrationMod = await import(`../src/services/plaid/plaidTokenMigration.js?verifyMigration=${Date.now()}`);
  const rows = [
    { id: "active-1", table: "plaid_items", is_active: true, status: "connected", plaid_access_token: cryptoMod.encryptPlaidAccessToken("access-sandbox-verify-one") },
    { id: "active-2", table: "plaid_items", is_active: true, status: "active", plaid_access_token: cryptoMod.encryptPlaidAccessToken("access-sandbox-verify-two") },
  ];
  const verified = await migrationMod.verifyPlaidTokenRotation({
    supabaseClient: makeMigrationSupabase(rows),
    expectedActiveItems: 2,
    limit: 10,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.active_v2_k2_authenticated, 2);
  assert.equal(verified.active_legacy_or_plaintext, 0);
  assert.doesNotMatch(JSON.stringify(verified), /verify-one|verify-two|enc:v2/);
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
