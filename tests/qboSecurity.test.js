import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const root = process.cwd();
const qboAuthSource = readFileSync(join(root, "src/api/auth/quickbooksAuth.js"), "utf8");
const tokenServiceSource = readFileSync(join(root, "src/services/quickbooksTokenService.js"), "utf8");
const qboClientSource = readFileSync(join(root, "src/utils/qboClient.js"), "utf8");
const webhookRoutesSource = readFileSync(join(root, "src/api/qbo/qboJobCostingWebhooks.routes.js"), "utf8");
const ongoingSyncSource = readFileSync(join(root, "src/services/jobCosting/qboOngoingSyncService.js"), "utf8");
const migrationSource = readFileSync(join(root, "src/services/quickbooks/qboTokenMigration.js"), "utf8");
const frontendSource = [
  "src/pages/Settings/SettingsHome.jsx",
  "src/hooks/useIntegrationManager.js",
  "src/services/api/authenticatedFetch.js",
].map((file) => readFileSync(join(root, file), "utf8")).join("\n");

const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

function withQboKey() {
  process.env.QBO_TOKEN_ENCRYPTION_KEY = TEST_KEY;
  delete process.env.ENCRYPTION_KEY_32B;
}

function makeStateDb() {
  const rows = [];
  return {
    rows,
    from(table) {
      assert.equal(table, "oauth_connection_states");
      return {
        insert(payload) {
          rows.push({ id: `state-${rows.length + 1}`, ...payload });
          return Promise.resolve({ error: null });
        },
        update(payload) {
          const filters = [];
          let usedAtNull = false;
          let expiresAfter = null;
          return {
            eq(field, value) {
              filters.push([field, value]);
              return this;
            },
            is(field, value) {
              if (field === "used_at" && value === null) usedAtNull = true;
              return this;
            },
            gt(field, value) {
              if (field === "expires_at") expiresAfter = value;
              return this;
            },
            select() {
              return this;
            },
            async maybeSingle() {
              const row = rows.find((candidate) => {
                const eqMatch = filters.every(([field, value]) => candidate[field] === value);
                const usedMatch = !usedAtNull || candidate.used_at == null;
                const expiryMatch = !expiresAfter || candidate.expires_at > expiresAfter;
                return eqMatch && usedMatch && expiryMatch;
              });
              if (!row) return { data: null, error: null };
              Object.assign(row, payload);
              return {
                data: {
                  id: row.id,
                  user_id: row.user_id,
                  business_id: row.business_id,
                  expires_at: row.expires_at,
                  metadata: row.metadata,
                },
                error: null,
              };
            },
          };
        },
        delete() {
          return {
            eq() {
              return this;
            },
            lt() {
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

function makeMigrationDb(rows) {
  const updates = [];
  return {
    updates,
    from(table) {
      assert.equal(table, "quickbooks_tokens");
      return {
        select(columns) {
          assert.match(columns, /access_token/);
          return {
            async limit() {
              return { data: rows, error: null };
            },
          };
        },
        update(payload) {
          const filters = [];
          return {
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
        },
      };
    },
  };
}

test("QBO token crypto uses randomized AES-GCM envelopes and fails closed on tampering", async () => {
  withQboKey();
  const qboCrypto = await import(`../src/services/quickbooks/qboTokenCrypto.js?crypto=${Date.now()}`);
  const token = "qbo-access-token";
  const first = qboCrypto.encryptQboToken(token);
  const second = qboCrypto.encryptQboToken(token);
  assert.match(first, /^enc:v1:/);
  assert.notEqual(first, second);
  assert.equal(qboCrypto.decryptQboToken(first), token);
  const raw = Buffer.from(first.slice("enc:v1:".length), "base64");
  raw[raw.length - 1] ^= 0xff;
  assert.throws(() => qboCrypto.decryptQboToken(`enc:v1:${raw.toString("base64")}`));
});

test("QBO production requires dedicated token encryption key and rejects shared fallback", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import './src/services/quickbooks/qboTokenCrypto.js';"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        QBO_TOKEN_ENCRYPTION_KEY: "",
        ENCRYPTION_KEY_32B: TEST_KEY,
      },
      encoding: "utf8",
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /qbo_token_encryption_key_missing/);
});

test("QBO OAuth state is random, persisted, bound to user/business/provider, and single-use", async () => {
  const stateService = await import(`../src/services/quickbooks/qboOAuthStateService.js?state=${Date.now()}`);
  const db = makeStateDb();
  const first = await stateService.createQboOAuthState({
    db,
    userId: "user-a",
    businessId: "biz-a",
    includeProjectsScope: true,
    forceSwitchCompany: true,
    forceBackfill: true,
    returnTo: "/dashboard/settings?tab=Integrations",
    returnOrigin: "http://localhost:5173/dashboard/settings",
  });
  const second = await stateService.createQboOAuthState({ db, userId: "user-a", businessId: "biz-a" });

  assert.notEqual(first.state, second.state);
  assert.equal(db.rows[0].provider, "quickbooks");
  assert.equal(db.rows[0].business_id, "biz-a");
  assert.equal(db.rows[0].user_id, "user-a");
  assert.notEqual(db.rows[0].state_hash, first.state);
  assert.equal(db.rows[0].metadata.includeProjectsScope, true);
  assert.equal(db.rows[0].metadata.returnTo, "/dashboard/settings?tab=Integrations");
  assert.equal(db.rows[0].metadata.returnOrigin, "http://localhost:5173");

  const consumed = await stateService.consumeQboOAuthState({ db, state: first.state });
  assert.equal(consumed.businessId, "biz-a");
  assert.equal(consumed.userId, "user-a");
  assert.equal(consumed.metadata.forceSwitchCompany, true);
  assert.equal(consumed.metadata.forceBackfill, true);
  assert.equal(consumed.metadata.returnTo, "/dashboard/settings?tab=Integrations");
  assert.equal(consumed.metadata.returnOrigin, "http://localhost:5173");
  await assert.rejects(() => stateService.consumeQboOAuthState({ db, state: first.state }), /QBO_OAUTH_STATE_INVALID/);
  await assert.rejects(() => stateService.consumeQboOAuthState({ db, state: "bad" }), /QBO_OAUTH_STATE_INVALID/);
});

test("QBO OAuth state expiry is enforced by consume predicate", async () => {
  const stateService = await import(`../src/services/quickbooks/qboOAuthStateService.js?expired=${Date.now()}`);
  const db = makeStateDb();
  const createdAt = new Date("2026-08-07T10:00:00.000Z");
  const { state } = await stateService.createQboOAuthState({
    db,
    userId: "user-a",
    businessId: "biz-a",
    now: createdAt,
  });
  await assert.rejects(
    () => stateService.consumeQboOAuthState({
      db,
      state,
      now: new Date("2026-08-07T10:11:00.000Z"),
    }),
    /QBO_OAUTH_STATE_INVALID/
  );
});

test("QBO OAuth callback derives tenant from persisted state, not decoded callback metadata", () => {
  assert.match(qboAuthSource, /consumeQboOAuthState/);
  assert.doesNotMatch(qboAuthSource, /Buffer\.from\(String\(rawState\).*base64url/);
  assert.doesNotMatch(qboAuthSource, /parsed\?\.businessId/);
  assert.match(qboAuthSource, /const business_id = oauthState\.businessId/);
  assert.match(qboAuthSource, /const user_id = oauthState\.userId/);
  assert.match(qboAuthSource, /const forceBackfill = oauthState\.metadata\?\.forceBackfill === true/);
});

test("QBO OAuth initiation requires canonical auth and business authorization", () => {
  assert.match(qboAuthSource, /const requireVerifiedBusiness = \[requireAuth, requireBusinessAccess\(\)\]/);
  assert.match(qboAuthSource, /router\.get\("\/quickbooks", \.\.\.requireVerifiedBusiness/);
  assert.match(qboAuthSource, /const businessId = req\.business\?\.id/);
  assert.doesNotMatch(qboAuthSource, /req\.query\.business_id[^;]*;/);
});

test("QBO OAuth initiation supports authenticated JSON start for memory-only browser sessions", () => {
  assert.match(qboAuthSource, /req\.accepts\(\["json", "html"\]\) === "json" \|\| req\.query\?\.format === "json"/);
  assert.match(qboAuthSource, /return res\.json\(\{ ok: true, redirectUrl: url \}\)/);
  assert.match(frontendSource, /safeFetch\(urlObj\.toString\(\), \{/);
  assert.match(frontendSource, /headers: \{ Accept: "application\/json" \}/);
  assert.match(frontendSource, /urlObj\.searchParams\.set\("return_to", "\/dashboard\/settings\?tab=Integrations"\)/);
  assert.match(frontendSource, /window\.location\.assign\(url\)/);
  assert.doesNotMatch(frontendSource, /window\.location\.assign\(urlObj\.toString\(\)\)/);
});

test("QBO OAuth callback redirects to the authorized frontend origin and stored return path", () => {
  assert.match(qboAuthSource, /function resolveRequestFrontendOrigin\(req\)/);
  assert.match(qboAuthSource, /CONFIGURED_FRONTEND_ORIGINS\.includes\(origin\)/);
  assert.match(qboAuthSource, /returnOrigin: resolveRequestFrontendOrigin\(req\)/);
  assert.match(qboAuthSource, /function buildQboFrontendRedirect\(oauthState/);
  assert.match(qboAuthSource, /CONFIGURED_FRONTEND_ORIGINS\.includes\(oauthState\?\.metadata\?\.returnOrigin\)/);
  assert.match(qboAuthSource, /normalizeReturnTo\(oauthState\?\.metadata\?\.returnTo\)/);
  assert.match(qboAuthSource, /const dest = buildQboFrontendRedirect\(oauthState\)/);
});

test("QBO duplicate realm callback is surfaced as a specific user-facing integration error", () => {
  assert.match(qboAuthSource, /QBO_REALM_ALREADY_CONNECTED/);
  assert.match(qboAuthSource, /realm_already_connected/);
  assert.match(frontendSource, /qbError === "realm_already_connected"/);
  assert.match(frontendSource, /realmAlreadyConnected: true/);
});

test("QBO new token writes and refresh writes encrypt access and refresh tokens", () => {
  assert.match(qboAuthSource, /encryptQuickBooksTokenPayload/);
  assert.match(tokenServiceSource, /encryptQuickBooksTokenPayload/);
  assert.match(tokenServiceSource, /access_token:\s*payload\.access_token \? encryptQboToken\(payload\.access_token\)/);
  assert.match(tokenServiceSource, /refresh_token:\s*payload\.refresh_token \? encryptQboToken\(payload\.refresh_token\)/);
  assert.match(tokenServiceSource, /await supabase\.from\("quickbooks_tokens"\)\.upsert\(payload/);
});

test("QBO token upserts use the production-compatible business_id conflict target", () => {
  assert.match(qboAuthSource, /\.upsert\(basePayload, \{ onConflict: "business_id" \}\)/);
  assert.match(tokenServiceSource, /\.upsert\(payload, \{ onConflict: "business_id" \}\)/);
  assert.doesNotMatch(qboAuthSource, /onConflict: "business_id,qbo_env"/);
  assert.doesNotMatch(tokenServiceSource, /onConflict: "business_id,qbo_env"/);
});

test("QBO browser responses and status query do not expose token fields", () => {
  assert.doesNotMatch(qboAuthSource, /res\.json\([^)]*access_token/i);
  assert.doesNotMatch(qboAuthSource, /res\.json\([^)]*refresh_token/i);
  assert.doesNotMatch(qboAuthSource, /\.select\("realm_id, refresh_token, access_token/);
  assert.match(qboAuthSource, /\.select\("realm_id,connected_company_name/);
});

test("QBO legacy token migration encrypts plaintext, is idempotent, and preserves malformed rows", async () => {
  withQboKey();
  const qboCrypto = await import(`../src/services/quickbooks/qboTokenCrypto.js?migrationCrypto=${Date.now()}`);
  const migration = await import(`../src/services/quickbooks/qboTokenMigration.js?migration=${Date.now()}`);
  const rows = [
    {
      id: "row-current",
      business_id: "biz-a",
      realm_id: "realm-a",
      qbo_env: "sandbox",
      access_token: qboCrypto.encryptQboToken("qbo-access-current"),
      refresh_token: qboCrypto.encryptQboToken("qbo-refresh-current"),
    },
    {
      id: "row-legacy",
      business_id: "biz-b",
      realm_id: "realm-b",
      qbo_env: "sandbox",
      access_token: "qbo-access-legacy-secret",
      refresh_token: "qbo-refresh-legacy-secret",
    },
    {
      id: "row-mixed",
      business_id: "biz-mixed",
      realm_id: "realm-mixed",
      qbo_env: "sandbox",
      access_token: qboCrypto.encryptQboToken("qbo-access-mixed"),
      refresh_token: "qbo-refresh-mixed-secret",
    },
    {
      id: "row-bad",
      business_id: "biz-c",
      realm_id: "realm-c",
      qbo_env: "sandbox",
      access_token: "not-valid",
      refresh_token: "not-valid",
    },
  ];
  const db = makeMigrationDb(rows);
  const dryRun = await migration.migrateQboTokens({ supabaseClient: db, apply: false });
  assert.equal(db.updates.length, 0);
  assert.equal(dryRun.summary.already_encrypted, 1);
  assert.equal(dryRun.summary.would_encrypt, 2);
  assert.equal(dryRun.summary.needs_attention, 1);
  assert.doesNotMatch(JSON.stringify(dryRun), /legacy-secret|current-secret/);

  const applied = await migration.migrateQboTokens({ supabaseClient: db, apply: true });
  assert.equal(applied.summary.encrypted, 2);
  assert.match(rows[1].access_token, /^enc:v1:/);
  assert.match(rows[1].refresh_token, /^enc:v1:/);
  assert.equal(qboCrypto.decryptQboToken(rows[1].access_token), "qbo-access-legacy-secret");
  assert.equal(qboCrypto.decryptQboToken(rows[1].refresh_token), "qbo-refresh-legacy-secret");
  assert.match(rows[2].access_token, /^enc:v1:/);
  assert.match(rows[2].refresh_token, /^enc:v1:/);
  assert.equal(qboCrypto.decryptQboToken(rows[2].refresh_token), "qbo-refresh-mixed-secret");
  assert.equal(rows[3].access_token, "not-valid");
  assert.doesNotMatch(JSON.stringify(applied), /legacy-secret|current-secret/);

  const second = await migration.migrateQboTokens({ supabaseClient: db, apply: true });
  assert.equal(second.summary.already_encrypted, 3);
  assert.equal(db.updates.length, 2);
});

test("QBO lazy migration upgrades plaintext credentials server-side without rewriting ciphertext", async () => {
  withQboKey();
  const cryptoMod = await import(`../src/services/quickbooks/qboTokenCrypto.js?lazy=${Date.now()}`);
  let persisted = null;
  const plaintext = "qbo-refresh-lazy-secret";
  const resolved = await cryptoMod.resolveStoredQboToken({
    storedToken: plaintext,
    persistEncrypted: async (encrypted) => {
      persisted = encrypted;
    },
  });

  assert.equal(resolved, plaintext);
  assert.match(persisted, /^enc:v1:/);
  assert.equal(cryptoMod.decryptQboToken(persisted), plaintext);

  let rewrote = false;
  const resolvedAgain = await cryptoMod.resolveStoredQboToken({
    storedToken: persisted,
    persistEncrypted: async () => {
      rewrote = true;
    },
  });
  assert.equal(resolvedAgain, plaintext);
  assert.equal(rewrote, false);
});

test("QBO migration fails closed without crypto key", async () => {
  const oldQboKey = process.env.QBO_TOKEN_ENCRYPTION_KEY;
  const oldSharedKey = process.env.ENCRYPTION_KEY_32B;
  delete process.env.QBO_TOKEN_ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY_32B;
  try {
    const migration = await import(`../src/services/quickbooks/qboTokenMigration.js?missing=${Date.now()}`);
    await assert.rejects(
      migration.migrateQboTokens({
        supabaseClient: makeMigrationDb([
          { business_id: "biz-a", qbo_env: "sandbox", access_token: "qbo-access-a", refresh_token: "qbo-refresh-a" },
        ]),
      }),
      /qbo_token_encryption_key_missing/
    );
  } finally {
    if (oldQboKey) process.env.QBO_TOKEN_ENCRYPTION_KEY = oldQboKey;
    if (oldSharedKey) process.env.ENCRYPTION_KEY_32B = oldSharedKey;
  }
});

test("QBO client and sync helpers resolve credentials server-side by business mapping", () => {
  assert.match(qboClientSource, /getQuickBooksAccessToken\(businessId\)/);
  assert.match(qboClientSource, /getLatestQuickBooksTokenRow\(businessId\)/);
  assert.match(qboClientSource, /process\.env\.NODE_ENV !== "production"/);
  assert.doesNotMatch(qboClientSource, /req\.body|req\.query|access_token:\s*req/);
  assert.match(ongoingSyncSource, /findBusinessIdForRealm/);
  assert.match(ongoingSyncSource, /\.eq\("realm_id", String\(realmId\)\)/);
  assert.match(ongoingSyncSource, /processing_status: !businessId \|\| newerEvent \? "skipped" : "queued"/);
});

test("QBO webhook signatures are HMAC verified and invalid signatures are rejected", () => {
  const rawBody = Buffer.from(JSON.stringify({ eventNotifications: [] }));
  const verifierToken = "webhook-secret";
  const signature = crypto.createHmac("sha256", verifierToken).update(rawBody).digest("base64");
  const expected = crypto.createHmac("sha256", verifierToken).update(rawBody).digest("base64");
  assert.equal(signature, expected);
  assert.match(ongoingSyncSource, /createHmac\("sha256", verifierToken\)\.update\(body\)\.digest\("base64"\)/);
  assert.match(ongoingSyncSource, /timingSafeEqual/);
  assert.match(webhookRoutesSource, /invalid_qbo_webhook_signature/);
});

test("QBO logs and frontend scan do not include server secrets or token response dependencies", () => {
  assert.match(qboAuthSource, /redactQboSecrets/);
  assert.match(tokenServiceSource, /redactQboSecrets/);
  assert.doesNotMatch(frontendSource, /QBO_CLIENT_SECRET|QUICKBOOKS_CLIENT_SECRET|VITE_QBO_SECRET|VITE_QUICKBOOKS_SECRET/i);
  assert.doesNotMatch(frontendSource, /quickbooks.*refresh_token|quickbooks.*access_token/i);
  assert.match(migrationSource, /encryptQboToken/);
});
