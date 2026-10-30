/* global Buffer, process */
const USAGE = `Usage:
  node --env-file=.env scripts/tax/validateTaxWorkspaceV2Canary.js \\
    --business-id <uuid> \\
    --year <yyyy> \\
    --v2-projection-id <uuid> \\
    --expected-v1-projection-id <uuid> \\
    --expected-v1-fingerprint <64-char-sha256>

Required secure environment:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BIZZI_API_URL, PAT_ACCESS_TOKEN

The command is read-only and never prints identity manifests or credentials.`;

const parsed = parseArguments(process.argv.slice(2));
if (parsed.help) {
  console.log(USAGE);
  process.exit(0);
}

const { supabase } = await import("../../src/services/supabaseAdmin.js");
const {
  __taxWorkspaceProjectionTestInternals: internals,
  TAX_WORKSPACE_LEGACY_PROJECTION_VERSION,
  TAX_WORKSPACE_PROJECTION_VERSION,
} = await import("../../src/services/tax/taxWorkspaceProjection.service.js");
const {
  EXPECTED_TAX_WORKSPACE_V2_AMOUNT_CONTRACT,
  validateTaxWorkspaceV2AmountContract,
} = await import("./taxWorkspaceV2AmountContract.js");

const ONE_MIB = 1024 * 1024;
const apiBaseUrl = requiredEnv("BIZZI_API_URL").replace(/\/+$/, "");
const accessToken = requiredEnv("PAT_ACCESS_TOKEN");
const { businessId, taxYear, v2ProjectionId, expectedV1Id, expectedV1Fingerprint } = parsed;

const [v1, v2] = await Promise.all([
  exactProjection(expectedV1Id, TAX_WORKSPACE_LEGACY_PROJECTION_VERSION),
  exactProjection(v2ProjectionId, TAX_WORKSPACE_PROJECTION_VERSION),
]);

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
assertEqual(payload.questionGroupCount, 8, "semantic question groups");
assertEqual(payload.questionMembershipSum, 315, "question summed memberships");
assertEqual(payload.questionCoveredUniqueCount, 315, "question unique memberships");
assertEqual(payload.questionMembershipOverlapCount, 0, "question overlap");
assertEqual(unionSize(Object.values(payload.identityEvidence.categories || {})), 690, "category identity union");
assertEqual(unionSize(Object.values(payload.identityEvidence.months || {})), 690, "monthly identity union");
assertEqual((payload.identityEvidence.categories?.income || payload.identityEvidence.categories?.Income || []).length, 0, "Income matrix identities");
const amountValidation = validateTaxWorkspaceV2AmountContract(payload, EXPECTED_TAX_WORKSPACE_V2_AMOUNT_CONTRACT);
const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
assert(payloadBytes < ONE_MIB, `payload is ${payloadBytes} bytes, not below 1 MiB`);

const [unversioned, explicitV2] = await Promise.all([
  readWorkspace(""),
  readWorkspace(`&projectionVersion=${encodeURIComponent(TAX_WORKSPACE_PROJECTION_VERSION)}`),
]);
assertEqual(unversioned.projectionVersion, TAX_WORKSPACE_LEGACY_PROJECTION_VERSION, "unversioned GET version");
assertEqual(unversioned.projectionId, expectedV1Id, "unversioned GET v1 projection ID");
assertEqual(explicitV2.projectionVersion, TAX_WORKSPACE_PROJECTION_VERSION, "explicit GET version");
assertEqual(explicitV2.projectionId, v2ProjectionId, "explicit GET v2 projection ID");
assertNoIdentityManifests(explicitV2.projection);

console.log(JSON.stringify({
  ok: true,
  businessId,
  taxYear,
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
    amounts: {
      estimatedDeduction: amountValidation.estimatedDeductibleAmount,
      reviewedDeduction: amountValidation.reviewedDeductibleAmount,
      deductibleTotal: amountValidation.deductibleAmount,
      awaitingInputSignedGross: amountValidation.needsInputGrossExpense,
      signedBookTotal: amountValidation.bookExpenseAmount,
      monthlyTransactionCount: amountValidation.transactionCount,
    },
    fingerprintsValidated: true,
    browserIdentityManifestsExposed: false,
  },
}, null, 2));

async function exactProjection(id, version) {
  const { data, error } = await supabase
    .from("tax_workspace_projections")
    .select("id,projection_version,source_fingerprint,status,projection_data,generated_at")
    .eq("id", id)
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .eq("projection_version", version)
    .maybeSingle();
  if (error) throw error;
  assert(data, `the specified ${version} projection does not exist in this scope`);
  return data;
}

async function readWorkspace(versionQuery) {
  const response = await fetch(`${apiBaseUrl}/api/tax/workspace?businessId=${encodeURIComponent(businessId)}&year=${taxYear}${versionQuery}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => null);
  assert(response.ok && body?.ok === true && body?.data, `workspace GET failed with HTTP ${response.status}`);
  return body.data;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const names = new Map([
    ["--business-id", "businessId"],
    ["--year", "taxYear"],
    ["--v2-projection-id", "v2ProjectionId"],
    ["--expected-v1-projection-id", "expectedV1Id"],
    ["--expected-v1-fingerprint", "expectedV1Fingerprint"],
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [rawName, inlineValue] = token.split("=", 2);
    const key = names.get(rawName);
    if (!key) usageError(`Unknown argument: ${rawName}`);
    if (values[key] != null) usageError(`Duplicate argument: ${rawName}`);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) usageError(`Missing value for ${rawName}`);
    values[key] = value;
  }
  for (const [name, key] of names) if (!values[key]) usageError(`Missing required argument: ${name}`);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const key of ["businessId", "v2ProjectionId", "expectedV1Id"]) if (!uuid.test(values[key])) usageError(`Invalid UUID for ${key}`);
  if (!/^\d{4}$/.test(values.taxYear)) usageError("--year must be a four-digit year");
  values.taxYear = Number(values.taxYear);
  if (!/^[0-9a-f]{64}$/i.test(values.expectedV1Fingerprint)) usageError("--expected-v1-fingerprint must be a SHA-256 hex digest");
  return values;
}

function usageError(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function assertNoIdentityManifests(value) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes("identityEvidence"), "browser response exposes identityEvidence");
  assert(!serialized.includes("identityManifest"), "browser response exposes identityManifest");
  assert(!serialized.includes("semanticManifest"), "browser response exposes semanticManifest");
  assert(!serialized.includes("semanticFingerprint"), "browser response exposes semanticFingerprint");
  assert(!serialized.includes("ruleVersions"), "browser response exposes rule-version provenance");
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
