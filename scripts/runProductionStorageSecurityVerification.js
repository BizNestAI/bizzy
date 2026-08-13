import { config as loadDotenv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

if (process.env.DOTENV_CONFIG_PATH) {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH });
}

const ENABLE_FLAG = "PRODUCTION_STORAGE_SECURITY_TEST_ENABLED";
const REQUIRED_ENV = [
  "PRODUCTION_STORAGE_TEST_SUPABASE_URL",
  "PRODUCTION_STORAGE_TEST_SUPABASE_ANON_KEY",
  "PRODUCTION_STORAGE_TEST_SUPABASE_SERVICE_ROLE_KEY",
  "PRODUCTION_STORAGE_TEST_USER_A_EMAIL",
  "PRODUCTION_STORAGE_TEST_USER_A_PASSWORD",
  "PRODUCTION_STORAGE_TEST_USER_A_ID",
  "PRODUCTION_STORAGE_TEST_BUSINESS_A_ID",
  "PRODUCTION_STORAGE_TEST_USER_B_EMAIL",
  "PRODUCTION_STORAGE_TEST_USER_B_PASSWORD",
  "PRODUCTION_STORAGE_TEST_USER_B_ID",
  "PRODUCTION_STORAGE_TEST_BUSINESS_B_ID",
];

const BUCKETS = [
  {
    id: "bizzy-docs",
    directUploadAllowed: true,
    ownUploadReason: "current Bizzy Docs browser upload workflow",
  },
  {
    id: "financial-reports",
    directUploadAllowed: false,
    ownUploadReason: "financial report writes should be backend/service-role only",
  },
  {
    id: "bid-attachments",
    directUploadAllowed: false,
    ownUploadReason: "bid attachment writes should be backend/service-role only",
  },
];

const RUN_ID = `prod_storage_${Date.now()}_${randomUUID().slice(0, 8)}`;
const SECURITY_MARKER = "__security_test__";
const results = [];
const createdObjects = [];

function env(name) {
  return String(process.env[name] || "").trim();
}

function requireEnabled() {
  if (env(ENABLE_FLAG) !== "true") {
    throw new Error(`Refusing to run production Storage verification without ${ENABLE_FLAG}=true.`);
  }
}

function requireEnv() {
  const missing = REQUIRED_ENV.filter((name) => !env(name));
  if (missing.length) {
    throw new Error(`Missing required synthetic production Storage test env: ${missing.join(", ")}`);
  }
}

function assertUuid(name, value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
}

function assertSafePath(path) {
  if (!path.includes(`/${SECURITY_MARKER}/${RUN_ID}/`)) {
    throw new Error(`Refusing unsafe Storage mutation path without run marker: ${path}`);
  }
}

function safeId(id) {
  return id ? `${String(id).slice(0, 8)}...${String(id).slice(-4)}` : null;
}

function record({ bucket, operation, actor, target, expected, actual, pass, reason = "" }) {
  results.push({
    bucket,
    operation,
    actor,
    target,
    expected,
    actual,
    status: pass ? "PASS" : "FAIL",
    reason,
  });
}

function storagePath(businessId, bucket, label) {
  return `${businessId}/${SECURITY_MARKER}/${RUN_ID}/${bucket}/${label}.txt`;
}

function clientFor(url, key, accessToken) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

async function signIn(url, anonKey, label, email, password, expectedUserId) {
  const authClient = clientFor(url, anonKey);
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data?.session?.access_token) {
    throw new Error(`Could not authenticate synthetic User ${label}: ${error?.message || "missing session"}`);
  }
  if (data.user?.id !== expectedUserId) {
    throw new Error(`Synthetic User ${label} auth ID did not match configured ID.`);
  }
  return {
    label: `User ${label}`,
    email,
    id: expectedUserId,
    businessId: env(`PRODUCTION_STORAGE_TEST_BUSINESS_${label}_ID`),
    accessToken: data.session.access_token,
    client: clientFor(url, anonKey, data.session.access_token),
  };
}

async function verifySyntheticTenant(admin, user, businessId) {
  const { data: business, error: businessError } = await admin
    .from("business_profiles")
    .select("id,user_id")
    .eq("id", businessId)
    .maybeSingle();
  if (businessError) throw new Error(`Could not verify synthetic business ${safeId(businessId)}: ${businessError.message}`);
  if (!business) throw new Error(`Configured synthetic business ${safeId(businessId)} does not exist.`);

  const { data: membership, error: membershipError } = await admin
    .from("user_business_link")
    .select("user_id,business_id,role")
    .eq("user_id", user.id)
    .eq("business_id", businessId)
    .maybeSingle();
  if (membershipError) throw new Error(`Could not verify synthetic membership: ${membershipError.message}`);
  if (!membership && business.user_id !== user.id) {
    throw new Error(`Synthetic user ${safeId(user.id)} is not owner/member of configured business ${safeId(businessId)}.`);
  }
}

async function verifyNoCrossMembership(admin, user, otherBusinessId) {
  const { data: business, error: businessError } = await admin
    .from("business_profiles")
    .select("id,user_id")
    .eq("id", otherBusinessId)
    .maybeSingle();
  if (businessError) throw new Error(`Could not verify synthetic cross-owner absence: ${businessError.message}`);
  if (business?.user_id === user.id) {
    throw new Error(`Synthetic ${user.label} is owner of the other synthetic business; aborting invalid tenant setup.`);
  }

  const { data, error } = await admin
    .from("user_business_link")
    .select("user_id,business_id,role")
    .eq("user_id", user.id)
    .eq("business_id", otherBusinessId)
    .maybeSingle();
  if (error) throw new Error(`Could not verify synthetic cross-membership absence: ${error.message}`);
  if (data) {
    throw new Error(`Synthetic ${user.label} is a member of the other synthetic business; aborting invalid tenant setup.`);
  }
}

async function seedObject(admin, bucket, businessId, label) {
  const path = storagePath(businessId, bucket, label);
  assertSafePath(path);
  const { error } = await admin.storage
    .from(bucket)
    .upload(path, Buffer.from(`Bizzi production Storage security verification ${RUN_ID}`), {
      contentType: "text/plain",
      upsert: false,
    });
  if (error) throw new Error(`Could not seed ${bucket} object ${safeId(path)}: ${error.message}`);
  createdObjects.push({ bucket, path });
  return { bucket, path };
}

async function attemptUpload({ client, bucket, path, actor, target, expectAllowed, reason }) {
  assertSafePath(path);
  const { data, error } = await client.storage
    .from(bucket)
    .upload(path, Buffer.from(`upload ${RUN_ID} ${actor}`), {
      contentType: "text/plain",
      upsert: false,
    });
  const allowed = !error && Boolean(data?.path);
  if (allowed) createdObjects.push({ bucket, path: data.path || path });
  record({
    bucket,
    operation: "UPLOAD",
    actor,
    target,
    expected: expectAllowed ? "allowed" : "denied",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : "uploaded generated test object",
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function attemptList({ client, bucket, prefix, actor, target, expectAllowed, reason }) {
  if (!prefix.includes(`${SECURITY_MARKER}/${RUN_ID}`)) {
    throw new Error(`Refusing unsafe list prefix without run marker: ${prefix}`);
  }
  const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 10 });
  const visible = Array.isArray(data) && data.length > 0;
  record({
    bucket,
    operation: "LIST",
    actor,
    target,
    expected: expectAllowed ? "visible generated test objects" : "denied/no generated objects visible",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : `${data?.length || 0} object(s) visible`,
    pass: expectAllowed ? visible : Boolean(error) || !visible,
    reason,
  });
}

async function attemptDownload({ client, bucket, path, actor, target, expectAllowed, reason }) {
  assertSafePath(path);
  const { data, error } = await client.storage.from(bucket).download(path);
  const allowed = !error && Boolean(data);
  record({
    bucket,
    operation: "DOWNLOAD",
    actor,
    target,
    expected: expectAllowed ? "allowed" : "denied",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : "downloaded generated test object",
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function attemptSignedUrl({ client, bucket, path, actor, target, expectAllowed, reason }) {
  assertSafePath(path);
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 60);
  const allowed = !error && Boolean(data?.signedUrl);
  record({
    bucket,
    operation: "SIGNED_URL",
    actor,
    target,
    expected: expectAllowed ? "allowed" : "denied",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : "signed URL issued",
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function attemptOverwrite({ client, bucket, path, actor, target, expectAllowed, reason }) {
  assertSafePath(path);
  const { data, error } = await client.storage
    .from(bucket)
    .upload(path, Buffer.from(`overwrite ${RUN_ID} ${actor}`), {
      contentType: "text/plain",
      upsert: true,
    });
  const allowed = !error && Boolean(data?.path);
  record({
    bucket,
    operation: "OVERWRITE",
    actor,
    target,
    expected: expectAllowed ? "allowed" : "denied",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : "overwrote generated test object",
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function attemptDelete({ client, bucket, path, actor, target, expectAllowed, reason }) {
  assertSafePath(path);
  const { data, error } = await client.storage.from(bucket).remove([path]);
  const allowed = !error && Array.isArray(data) && data.length > 0;
  record({
    bucket,
    operation: "DELETE",
    actor,
    target,
    expected: expectAllowed ? "allowed" : "denied",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : `${data?.length || 0} delete result(s)`,
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function cleanup(admin) {
  for (const object of [...createdObjects].reverse()) {
    try {
      if (!object?.bucket || !object?.path) continue;
      assertSafePath(object.path);
      await admin.storage.from(object.bucket).remove([object.path]);
    } catch (error) {
      console.warn("[production-storage-security] cleanup skipped one generated object", {
        bucket: object?.bucket || null,
        pathMarker: object?.path?.includes(SECURITY_MARKER) ? `${SECURITY_MARKER}/${RUN_ID}` : "unsafe",
        message: error?.message || String(error),
      });
    }
  }
}

function summarize() {
  const failed = results.filter((result) => result.status === "FAIL");
  return {
    runId: RUN_ID,
    executedAt: new Date().toISOString(),
    totalTests: results.length,
    pass: results.length - failed.length,
    fail: failed.length,
    verdict: failed.length ? "FAIL — STORAGE ISOLATION FAILURE CONFIRMED" : "PASS — STORAGE TENANT ISOLATION VERIFIED",
  };
}

async function writeReports(summary, tenants) {
  await mkdir("reports", { recursive: true });
  const report = {
    summary,
    safety: {
      enabledFlagRequired: ENABLE_FLAG,
      generatedPathMarker: `${SECURITY_MARKER}/${RUN_ID}`,
      noUsersOrBusinessesCreated: true,
      cleanupRestrictedToGeneratedMarker: true,
    },
    tenants: {
      userA: { userId: safeId(tenants.userA?.id), businessId: safeId(tenants.userA?.businessId) },
      userB: { userId: safeId(tenants.userB?.id), businessId: safeId(tenants.userB?.businessId) },
    },
    buckets: BUCKETS.map(({ id, directUploadAllowed, ownUploadReason }) => ({ id, directUploadAllowed, ownUploadReason })),
    results,
  };
  await writeFile(join("reports", "production-storage-security-verification.json"), JSON.stringify(report, null, 2));

  const lines = [];
  lines.push("# Production Storage Security Verification");
  lines.push("");
  lines.push(`Executed: ${summary.executedAt}`);
  lines.push(`Run ID: \`${summary.runId}\``);
  lines.push(`Verdict: **${summary.verdict}**`);
  lines.push("");
  lines.push("No JWTs, API keys, service-role credentials, passwords, or customer file contents are included in this report.");
  lines.push("");
  lines.push("## Safety Controls");
  lines.push("");
  lines.push(`- Requires \`${ENABLE_FLAG}=true\`.`);
  lines.push("- Uses only explicitly configured synthetic test users and businesses.");
  lines.push("- Does not create or delete users/businesses.");
  lines.push(`- Mutations are restricted to paths containing \`${SECURITY_MARKER}/${RUN_ID}\`.`);
  lines.push("- Cleanup deletes only objects created during this exact run.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total tests: ${summary.totalTests}`);
  lines.push(`- Passed: ${summary.pass}`);
  lines.push(`- Failed: ${summary.fail}`);
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| Status | Bucket | Operation | Actor | Target | Expected | Actual | Reason |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of results) {
    lines.push(`| ${result.status} | ${result.bucket} | ${result.operation} | ${result.actor} | ${result.target} | ${result.expected} | ${result.actual.replaceAll("|", "\\|")} | ${result.reason.replaceAll("|", "\\|")} |`);
  }
  await writeFile(join("reports", "production-storage-security-verification.md"), `${lines.join("\n")}\n`);
}

async function run() {
  requireEnabled();
  requireEnv();

  const url = env("PRODUCTION_STORAGE_TEST_SUPABASE_URL").replace(/\/+$/, "");
  const anonKey = env("PRODUCTION_STORAGE_TEST_SUPABASE_ANON_KEY");
  const serviceKey = env("PRODUCTION_STORAGE_TEST_SUPABASE_SERVICE_ROLE_KEY");
  const userAId = env("PRODUCTION_STORAGE_TEST_USER_A_ID");
  const userBId = env("PRODUCTION_STORAGE_TEST_USER_B_ID");
  const businessAId = env("PRODUCTION_STORAGE_TEST_BUSINESS_A_ID");
  const businessBId = env("PRODUCTION_STORAGE_TEST_BUSINESS_B_ID");

  for (const [name, value] of Object.entries({ userAId, userBId, businessAId, businessBId })) {
    assertUuid(name, value);
  }
  if (userAId === userBId || businessAId === businessBId) {
    throw new Error("Synthetic production Storage users and businesses must be distinct.");
  }

  const admin = clientFor(url, serviceKey);
  const userA = await signIn(url, anonKey, "A", env("PRODUCTION_STORAGE_TEST_USER_A_EMAIL"), env("PRODUCTION_STORAGE_TEST_USER_A_PASSWORD"), userAId);
  const userB = await signIn(url, anonKey, "B", env("PRODUCTION_STORAGE_TEST_USER_B_EMAIL"), env("PRODUCTION_STORAGE_TEST_USER_B_PASSWORD"), userBId);
  userA.businessId = businessAId;
  userB.businessId = businessBId;

  try {
    await verifySyntheticTenant(admin, userA, businessAId);
    await verifySyntheticTenant(admin, userB, businessBId);
    await verifyNoCrossMembership(admin, userA, businessBId);
    await verifyNoCrossMembership(admin, userB, businessAId);

    const seeded = {};
    for (const bucket of BUCKETS) {
      seeded[bucket.id] = {
        A: await seedObject(admin, bucket.id, businessAId, "business-a-seed"),
        B: await seedObject(admin, bucket.id, businessBId, "business-b-seed"),
      };
    }

    const pairs = [
      { actor: "User A", user: userA, own: "A", victim: "B", ownBusinessId: businessAId, victimBusinessId: businessBId, target: "Business B" },
      { actor: "User B", user: userB, own: "B", victim: "A", ownBusinessId: businessBId, victimBusinessId: businessAId, target: "Business A" },
    ];

    for (const bucket of BUCKETS) {
      for (const pair of pairs) {
        const ownObject = seeded[bucket.id][pair.own];
        const victimObject = seeded[bucket.id][pair.victim];
        await attemptList({ client: pair.user.client, bucket: bucket.id, prefix: `${pair.ownBusinessId}/${SECURITY_MARKER}/${RUN_ID}`, actor: pair.actor, target: "own business", expectAllowed: true, reason: "authorized synthetic business prefix" });
        await attemptDownload({ client: pair.user.client, bucket: bucket.id, path: ownObject.path, actor: pair.actor, target: "own business", expectAllowed: true, reason: "authorized synthetic object" });
        await attemptSignedUrl({ client: pair.user.client, bucket: bucket.id, path: ownObject.path, actor: pair.actor, target: "own business", expectAllowed: true, reason: "authorized signed URL behavior" });
        await attemptUpload({ client: pair.user.client, bucket: bucket.id, path: storagePath(pair.ownBusinessId, bucket.id, `${pair.actor.replace(/\s/g, "").toLowerCase()}-own-upload`), actor: pair.actor, target: "own business", expectAllowed: bucket.directUploadAllowed, reason: bucket.ownUploadReason });
        await attemptList({ client: pair.user.client, bucket: bucket.id, prefix: `${pair.victimBusinessId}/${SECURITY_MARKER}/${RUN_ID}`, actor: pair.actor, target: pair.target, expectAllowed: false, reason: "foreign synthetic business prefix" });
        await attemptDownload({ client: pair.user.client, bucket: bucket.id, path: victimObject.path, actor: pair.actor, target: pair.target, expectAllowed: false, reason: "foreign synthetic object" });
        await attemptSignedUrl({ client: pair.user.client, bucket: bucket.id, path: victimObject.path, actor: pair.actor, target: pair.target, expectAllowed: false, reason: "foreign signed URL request" });
        await attemptUpload({ client: pair.user.client, bucket: bucket.id, path: storagePath(pair.victimBusinessId, bucket.id, `${pair.actor.replace(/\s/g, "").toLowerCase()}-foreign-upload`), actor: pair.actor, target: pair.target, expectAllowed: false, reason: "upload into foreign synthetic path" });
        await attemptOverwrite({ client: pair.user.client, bucket: bucket.id, path: victimObject.path, actor: pair.actor, target: pair.target, expectAllowed: false, reason: "overwrite foreign synthetic object" });
        await attemptDelete({ client: pair.user.client, bucket: bucket.id, path: victimObject.path, actor: pair.actor, target: pair.target, expectAllowed: false, reason: "delete foreign synthetic object" });
      }

      const anon = clientFor(url, anonKey);
      const anonObject = seeded[bucket.id].A;
      await attemptList({ client: anon, bucket: bucket.id, prefix: `${businessAId}/${SECURITY_MARKER}/${RUN_ID}`, actor: "Anonymous", target: "private storage", expectAllowed: false, reason: "anonymous list denied" });
      await attemptDownload({ client: anon, bucket: bucket.id, path: anonObject.path, actor: "Anonymous", target: "private storage", expectAllowed: false, reason: "anonymous download denied" });
      await attemptSignedUrl({ client: anon, bucket: bucket.id, path: anonObject.path, actor: "Anonymous", target: "private storage", expectAllowed: false, reason: "anonymous signed URL denied" });
      await attemptUpload({ client: anon, bucket: bucket.id, path: storagePath(businessAId, bucket.id, "anonymous-upload"), actor: "Anonymous", target: "private storage", expectAllowed: false, reason: "anonymous upload denied" });
      await attemptOverwrite({ client: anon, bucket: bucket.id, path: anonObject.path, actor: "Anonymous", target: "private storage", expectAllowed: false, reason: "anonymous overwrite denied" });
      await attemptDelete({ client: anon, bucket: bucket.id, path: anonObject.path, actor: "Anonymous", target: "private storage", expectAllowed: false, reason: "anonymous delete denied" });
    }

    const summary = summarize();
    await writeReports(summary, { userA, userB });
    console.log(JSON.stringify({
      verdict: summary.verdict,
      totalTests: summary.totalTests,
      pass: summary.pass,
      fail: summary.fail,
      report: "reports/production-storage-security-verification.md",
      json: "reports/production-storage-security-verification.json",
    }, null, 2));
    if (summary.fail) process.exitCode = 2;
  } finally {
    await cleanup(admin);
  }
}

run().catch(async (error) => {
  console.error("[production-storage-security] aborted", {
    message: error?.message || String(error),
    code: error?.code || null,
  });
  process.exitCode = 1;
});
