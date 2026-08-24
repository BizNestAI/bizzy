import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const headlineSource = read("src/api/insights/headline.controller.js");
const movesSource = read("src/api/gpt/suggestedMovesEngine.js");
const pulseSource = read("src/api/insights/pulse.controller.js");
const top3Source = read("src/api/insights/top3.controller.js");

test("Admin View headline GET returns cached headline or unavailable before generation/cache insert", () => {
  assert.match(headlineSource, /import \{ isAdminViewRequest,\s+sendAdminViewReadOnlyUnavailable \}/);
  const controllerStart = headlineSource.indexOf("export async function getDailyHeadline");
  const controller = headlineSource.slice(controllerStart);
  const cachedReturn = controller.indexOf("if (!selErr && cached)");
  const adminBranch = controller.indexOf("if (isAdminViewRequest(req))");
  assert.ok(cachedReturn > 0, "headline route must read existing cache first");
  assert.ok(adminBranch > cachedReturn, "Admin View should allow existing persisted headline");
  assert.ok(adminBranch < controller.indexOf("seedFrom(`${business_id}|${today}`)"), "Admin View must branch before headline generation");
  assert.ok(adminBranch < controller.indexOf("getAccountingSnapshot(business_id)"), "Admin View must branch before internal metrics fetch");
  assert.ok(adminBranch < controller.indexOf("supabase.from('bizzy_headlines').insert"), "Admin View must branch before headline cache insert");
  assert.match(headlineSource, /sendAdminViewReadOnlyUnavailable\(res, \{ error: 'admin_view_read_only_data_unavailable' \}\)/);
});

test("Admin View accounting moves GET is persisted-only and ignores query user authority", () => {
  const routeStart = movesSource.indexOf('router.get("/", async (req, res) =>');
  const adminBranch = movesSource.indexOf("if (isAdminViewRequest(req))", routeStart);
  assert.ok(routeStart > 0, "moves GET route must exist");
  assert.ok(adminBranch > routeStart, "moves GET must branch for Admin View");
  assert.match(
    movesSource.slice(routeStart, adminBranch),
    /const business_id = req\.tenantContext\?\.businessId \|\| req\.business\?\.id \|\| req\.auth\?\.businessId/
  );
  assert.match(movesSource.slice(routeStart, adminBranch), /\(\(!user_id && !isAdminViewRequest\(req\)\) \|\| !business_id\)/);
  assert.ok(adminBranch < movesSource.indexOf("generateSuggestedMoves({", adminBranch), "Admin View must branch before suggested move generation");
  assert.ok(adminBranch < movesSource.indexOf("buildMockMoves", adminBranch), "Admin View must branch before mock/default fabrication");
  const adminBlock = movesSource.slice(adminBranch, movesSource.indexOf("// If specific month requested", adminBranch));
  assert.match(adminBlock, /\.from\("financial_moves"\)/);
  assert.match(adminBlock, /admin_view_cache_only: true/);
  assert.doesNotMatch(adminBlock, /generateSuggestedMoves|OpenAI|upsert|insert|update|delete|getEmbedding/);
});

test("Admin View legacy insight pulse is blocked before internal metrics HTTP fetch", () => {
  const controllerStart = pulseSource.indexOf("export async function getPulse");
  const controller = pulseSource.slice(controllerStart);
  const adminBranch = controller.indexOf("if (isAdminViewRequest(req))");
  assert.ok(adminBranch > 0, "pulse route must branch for Admin View");
  assert.ok(adminBranch < controller.indexOf("fetchSignals(business_id)"), "Admin View must branch before internal metrics fetch");
  assert.match(pulseSource, /sendAdminViewReadOnlyUnavailable\(res, \{ error: 'admin_view_read_only_data_unavailable' \}\)/);
});

test("Admin View legacy insight top3 is blocked before internal metrics HTTP fetch and mock synthesis", () => {
  const controllerStart = top3Source.indexOf("export async function getTop3Alerts");
  const controller = top3Source.slice(controllerStart);
  const adminBranch = controller.indexOf("if (isAdminViewRequest(req))");
  assert.ok(adminBranch > 0, "top3 route must branch for Admin View");
  assert.ok(adminBranch < controller.indexOf("getJSON("), "Admin View must branch before internal metrics fetch");
  assert.ok(adminBranch < controller.indexOf("wantsMock"), "Admin View must branch before mock alert synthesis");
  assert.match(top3Source, /sendAdminViewReadOnlyUnavailable\(res, \{ error: 'admin_view_read_only_data_unavailable' \}\)/);
});
