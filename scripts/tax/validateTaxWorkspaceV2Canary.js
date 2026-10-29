/* global Buffer, process */
import "dotenv/config";
import { supabase } from "../../src/services/supabaseAdmin.js";
import {
  __taxWorkspaceProjectionTestInternals as internals,
  TAX_WORKSPACE_LEGACY_PROJECTION_VERSION,
  TAX_WORKSPACE_PROJECTION_VERSION,
} from "../../src/services/tax/taxWorkspaceProjection.service.js";

const BUSINESS_ID = "cffc2183-e77c-4148-a206-d5192e090925";
const TAX_YEAR = 2026;
const ONE_MIB = 1024 * 1024;

const expectedV1Id = requiredEnv("EXPECTED_V1_PROJECTION_ID");
const expectedV1Fingerprint = requiredEnv("EXPECTED_V1_SOURCE_FINGERPRINT");
const apiBaseUrl = requiredEnv("BIZZI_API_URL").replace(/\/+$/, "");
const accessToken = requiredEnv("PAT_ACCESS_TOKEN");

const [v1, v2] = await Promise.all([
  exactProjection(TAX_WORKSPACE_LEGACY_PROJECTION_VERSION),
  exactProjection(TAX_WORKSPACE_PROJECTION_VERSION),
]);

assertEqual(v1.id, expectedV1Id, "v1 projection ID changed");
assertEqual(v1.source_fingerprint, expectedV1Fingerprint, "v1 source fingerprint changed");
assertEqual(v1.projection_version, TAX_WORKSPACE_LEGACY_PROJECTION_VERSION, "stored v1 version");
assertEqual(v2.projection_version, TAX_WORKSPACE_PROJECTION_VERSION, "stored v2 version");
assertEqual(v2.status, "complete", "stored v2 status");

const payload = v2.projection_data;
internals.validatePayload(payload);
assertEqual(payload.evaluatedTransactionCount, 714, "evaluated transactions");
assertEqual(payload.matrixIncludedCount, 690, "matrix transactions");
assertEqual(payload.outsideDeductionsCount, 24, "outside-deductions transactions");
assertEqual(payload.matrixIncludedCount + payload.outsideDeductionsCount, payload.evaluatedTransactionCount, "evaluated conservation");
assertObject(payload.treatmentCounts, { estimated: 276, reviewed: 43, needs_input: 371 }, "treatment partition");
assertObject(payload.actionOwnerCounts, {
  customer_fact_required: 315,
  bizzi_tax_mapping_required: 51,
  professional_review_required: 17,
  none: 307,
}, "action ownership");
assertEqual(payload.questionGroupCount, 15, "question groups");
assertEqual(payload.questionMembershipSum, 315, "question summed memberships");
assertEqual(payload.questionCoveredUniqueCount, 315, "question unique memberships");
assertEqual(payload.questionMembershipOverlapCount, 0, "question overlap");
assertEqual(unionSize(Object.values(payload.identityEvidence.categories || {})), 690, "category identity union");
assertEqual(unionSize(Object.values(payload.identityEvidence.months || {})), 690, "monthly identity union");
assertEqual((payload.identityEvidence.categories?.income || payload.identityEvidence.categories?.Income || []).length, 0, "Income matrix identities");
assertEqual(payload.estimatedDeductibleAmount, 8523.81, "estimated deductible amount");
const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
assert(payloadBytes < ONE_MIB, `payload is ${payloadBytes} bytes, not below 1 MiB`);

const [unversioned, explicitV2] = await Promise.all([
  readWorkspace(""),
  readWorkspace(`&projectionVersion=${encodeURIComponent(TAX_WORKSPACE_PROJECTION_VERSION)}`),
]);
assertEqual(unversioned.projectionVersion, TAX_WORKSPACE_LEGACY_PROJECTION_VERSION, "unversioned GET version");
assertEqual(unversioned.projectionId, expectedV1Id, "unversioned GET v1 projection ID");
assertEqual(explicitV2.projectionVersion, TAX_WORKSPACE_PROJECTION_VERSION, "explicit GET version");
assertEqual(explicitV2.projectionId, v2.id, "explicit GET v2 projection ID");
assertNoIdentityManifests(explicitV2.projection);

console.log(JSON.stringify({
  ok: true,
  businessId: BUSINESS_ID,
  taxYear: TAX_YEAR,
  v1: { unchanged: true, projectionId: v1.id, projectionVersion: v1.projection_version },
  v2: {
    projectionId: v2.id,
    projectionVersion: v2.projection_version,
    status: v2.status,
    payloadBytes,
    evaluated: payload.evaluatedTransactionCount,
    matrix: payload.matrixIncludedCount,
    outsideDeductions: payload.outsideDeductionsCount,
    treatments: payload.treatmentCounts,
    actionOwners: payload.actionOwnerCounts,
    questions: {
      groups: payload.questionGroupCount,
      memberships: payload.questionMembershipSum,
      unique: payload.questionCoveredUniqueCount,
      overlap: payload.questionMembershipOverlapCount,
    },
    categoryIdentityUnion: 690,
    monthlyIdentityUnion: 690,
    incomeMatrixIdentities: 0,
    amount: payload.estimatedDeductibleAmount,
    fingerprintsValidated: true,
    browserIdentityManifestsExposed: false,
  },
}, null, 2));

async function exactProjection(version) {
  const { data, error } = await supabase
    .from("tax_workspace_projections")
    .select("id,projection_version,source_fingerprint,status,projection_data,generated_at")
    .eq("business_id", BUSINESS_ID)
    .eq("tax_year", TAX_YEAR)
    .eq("projection_version", version)
    .eq("status", "complete")
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  assert(data, `no complete ${version} projection exists`);
  return data;
}

async function readWorkspace(versionQuery) {
  const response = await fetch(`${apiBaseUrl}/api/tax/workspace?businessId=${BUSINESS_ID}&year=${TAX_YEAR}${versionQuery}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => null);
  assert(response.ok && body?.ok === true && body?.data, `workspace GET failed with HTTP ${response.status}`);
  return body.data;
}

function assertNoIdentityManifests(value) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes("identityEvidence"), "browser response exposes identityEvidence");
  assert(!serialized.includes("identityManifest"), "browser response exposes identityManifest");
}

function unionSize(groups) {
  return new Set(groups.flat().map(String)).size;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertObject(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) assertEqual(actual?.[key], value, `${label}: ${key}`);
  assertEqual(Object.keys(actual || {}).length, Object.keys(expected).length, `${label}: unexpected keys`);
}

function assertEqual(actual, expected, label) {
  assert(Object.is(actual, expected), `${label}: expected ${expected}, received ${actual}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`CANARY VALIDATION FAILED: ${message}`);
}
