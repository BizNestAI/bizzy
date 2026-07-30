import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.QB_PROD_CLIENT_ID ||= "test-client-id";
process.env.QB_PROD_CLIENT_SECRET ||= "test-client-secret";
process.env.QB_PROD_REDIRECT_URI ||= "http://localhost/qbo/callback";
process.env.QB_ENABLE_PROJECTS_SCOPE = "true";

const {
  QBO_ACCOUNTING_SCOPE,
  QBO_PROJECT_SCOPE,
  QBO_PROJECTS_CAPABILITY_STATUSES,
  QboProjectsGraphqlClient,
  buildQuickBooksOAuthScopes,
  checkQboProjectsCapability,
  createQuickBooksProjectForJob,
  determineProjectsCapabilityStatus,
  normalizeQboProject,
  parseProjectsEnabledPreference,
  runQboProjectsSync,
  tokenHasScope,
} = await import("../src/services/jobCosting/qboProjectsService.js");

function createFakeDb() {
  const tables = {
    business_profiles: [{ id: "business-1", user_id: "user-1" }],
    qbo_customers: [{ business_id: "business-1", realm_id: "realm-1", qbo_customer_id: "cust-1", customer_id: "customer-row-1" }],
    job_external_links: [],
    qbo_projects: [],
    qbo_projects_capabilities: [],
    jobs: [],
    job_revenue_documents: [
      { id: "doc-1", business_id: "business-1", realm_id: "realm-1", source_system: "quickbooks", job_id: null, project_ref: { value: "project-1" } },
    ],
    job_candidates: [],
  };

  const db = {
    tables,
    from(table) {
      const state = { table, filters: [], inFilters: [], isFilters: [], orderKey: null, limitValue: null };
      const applyFilters = () => {
        let rows = [...(tables[table] || [])];
        for (const [key, value] of state.filters) rows = rows.filter((row) => row[key] === value);
        for (const [key, values] of state.inFilters) rows = rows.filter((row) => values.includes(row[key]));
        for (const [key, value] of state.isFilters) rows = rows.filter((row) => row[key] === value);
        if (state.orderKey) rows.sort((a, b) => String(b[state.orderKey] || "").localeCompare(String(a[state.orderKey] || "")));
        if (state.limitValue != null) rows = rows.slice(0, state.limitValue);
        return rows;
      };
      const chain = {
        select(_cols, opts = {}) {
          state.countOnly = opts?.count === "exact" && opts?.head;
          return chain;
        },
        eq(key, value) {
          state.filters.push([key, value]);
          return chain;
        },
        in(key, values) {
          state.inFilters.push([key, values]);
          return chain;
        },
        is(key, value) {
          state.isFilters.push([key, value]);
          return chain;
        },
        order(key) {
          state.orderKey = key;
          return chain;
        },
        limit(value) {
          state.limitValue = value;
          return Promise.resolve(state.countOnly ? { data: null, count: applyFilters().length, error: null } : { data: applyFilters(), error: null });
        },
        maybeSingle() {
          return Promise.resolve({ data: applyFilters()[0] || null, error: null });
        },
        then(resolve) {
          const rows = applyFilters();
          resolve(state.countOnly ? { data: null, count: rows.length, error: null } : { data: rows, error: null });
        },
        insert(payload) {
          const row = { id: `${table}-${tables[table].length + 1}`, ...payload };
          tables[table].push(row);
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: row, error: null }),
            }),
          };
        },
        upsert(payload) {
          const rows = Array.isArray(payload) ? payload : [payload];
          let lastRow = null;
          for (const row of rows) {
            const keys = table === "qbo_projects"
              ? ["business_id", "realm_id", "qbo_project_id"]
              : table === "qbo_projects_capabilities"
                ? ["business_id", "realm_id", "qbo_env"]
                : table === "job_external_links"
                  ? ["business_id", "realm_id", "source_system", "source_entity_type", "external_entity_id"]
                  : ["id"];
            const existing = tables[table].find((candidate) => keys.every((key) => candidate[key] === row[key]));
            if (existing) Object.assign(existing, row);
            else tables[table].push({ id: `${table}-${tables[table].length + 1}`, ...row });
            lastRow = existing || tables[table][tables[table].length - 1];
          }
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: lastRow, error: null }),
            }),
            then: (resolve) => resolve({ data: lastRow, error: null }),
          };
        },
        update(payload) {
          const query = {
            eq(key, value) {
              state.filters.push([key, value]);
              return query;
            },
            in(key, values) {
              state.inFilters.push([key, values]);
              return query;
            },
            then(resolve) {
              const rows = applyFilters();
              rows.forEach((row) => Object.assign(row, payload));
              resolve({ data: rows, error: null });
            },
          };
          return query;
        },
      };
      return chain;
    },
  };
  return db;
}

describe("QuickBooks Projects capability and sync", () => {
  test("builds accounting-only scopes unless Projects re-consent is explicit", () => {
    assert.deepEqual(buildQuickBooksOAuthScopes(), [QBO_ACCOUNTING_SCOPE]);
    assert.deepEqual(buildQuickBooksOAuthScopes({ includeProjects: true }), [QBO_ACCOUNTING_SCOPE, QBO_PROJECT_SCOPE]);
    assert.equal(tokenHasScope(`${QBO_ACCOUNTING_SCOPE} ${QBO_PROJECT_SCOPE}`, QBO_PROJECT_SCOPE), true);
  });

  test("parses ProjectsEnabled preference response shapes", () => {
    assert.equal(parseProjectsEnabledPreference({ Preferences: { OtherPrefs: { ProjectsEnabled: true } } }), true);
    assert.equal(parseProjectsEnabledPreference({ Preferences: { OtherPrefs: { NameValue: [{ Name: "ProjectsEnabled", Value: "false" }] } } }), false);
    assert.equal(parseProjectsEnabledPreference({ Preferences: { OtherPrefs: {} } }), null);
  });

  test("determines missing scope and disabled company states without assuming entitlement", () => {
    assert.equal(
      determineProjectsCapabilityStatus({ accountingScopePresent: true, projectScopePresent: false }),
      QBO_PROJECTS_CAPABILITY_STATUSES.SCOPE_NOT_AUTHORIZED
    );
    assert.equal(
      determineProjectsCapabilityStatus({ accountingScopePresent: true, projectScopePresent: true, projectsEnabledPreference: false }),
      QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_BUT_PROJECTS_DISABLED
    );
    assert.equal(
      determineProjectsCapabilityStatus({ accountingScopePresent: true, projectScopePresent: true, projectsEnabledPreference: true }),
      QBO_PROJECTS_CAPABILITY_STATUSES.UNKNOWN
    );
  });

  test("checks capability and persists available_and_enabled only after entitlement succeeds", async () => {
    const db = createFakeDb();
    const result = await checkQboProjectsCapability({
      businessId: "business-1",
      db,
      projectsTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1", scope: `${QBO_ACCOUNTING_SCOPE} ${QBO_PROJECT_SCOPE}` },
        preferences: { Preferences: { OtherPrefs: { ProjectsEnabled: true } } },
        checkEntitlement: async () => ({ ok: true }),
      },
    });

    assert.equal(result.status, QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_AND_ENABLED);
    assert.equal(db.tables.qbo_projects_capabilities[0].project_scope_present, true);
  });

  test("GraphQL client paginates projects with typed request errors", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            company: {
              projects: {
                edges: [{ node: { id: `project-${calls}`, name: `Project ${calls}` } }],
                pageInfo: { hasNextPage: calls === 1, endCursor: calls === 1 ? "next" : null },
              },
            },
          },
        }),
      };
    };
    const client = new QboProjectsGraphqlClient({ accessToken: "token", realmId: "realm-1", fetchImpl, endpoint: "https://example.test/graphql" });
    const first = await client.fetchProjectsPage();
    const second = await client.fetchProjectsPage({ cursor: first.nextCursor });
    assert.deepEqual(first.projects.map((project) => project.id), ["project-1"]);
    assert.equal(second.nextCursor, null);
  });

  test("imports QBO Projects as authoritative job identity and attaches ProjectRef documents", async () => {
    const db = createFakeDb();
    const result = await runQboProjectsSync({
      businessId: "business-1",
      db,
      autoImport: true,
      projectsTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1", scope: `${QBO_ACCOUNTING_SCOPE} ${QBO_PROJECT_SCOPE}` },
        preferences: { Preferences: { OtherPrefs: { ProjectsEnabled: true } } },
        checkEntitlement: async () => ({ ok: true }),
        fetchAllProjects: async () => [{
          id: "project-1",
          name: "Johnson Deck Rebuild",
          parentCustomer: { id: "cust-1", displayName: "Maya Johnson" },
          status: "active",
        }],
      },
    });

    assert.equal(result.counts.imported, 1);
    assert.equal(result.counts.jobsCreatedOrUpdated, 1);
    assert.equal(result.counts.documentsAttached, 1);
    assert.equal(db.tables.job_external_links[0].source_entity_type, "project");
    assert.equal(db.tables.job_external_links[0].realm_id, "realm-1");
    assert.equal(db.tables.job_revenue_documents[0].job_id, db.tables.jobs[0].id);
  });

  test("normalizes archived Projects without deleting historical Bizzi jobs", () => {
    const normalized = normalizeQboProject({
      Id: "project-9",
      DisplayName: "Archived porch",
      Active: false,
      ParentRef: { value: "cust-1" },
      BillAddr: { Line1: "10 Maple", City: "Austin" },
    }, { businessId: "business-1", realmId: "realm-1" });

    assert.equal(normalized.qbo_project_id, "project-9");
    assert.equal(normalized.status, "archived");
    assert.equal(normalized.active, false);
    assert.equal(normalized.billing_address.line1, "10 Maple");
  });

  test("project creation is unavailable without verified mutation transport", async () => {
    const db = createFakeDb();
    const result = await createQuickBooksProjectForJob({
      businessId: "business-1",
      jobId: "job-1",
      db,
      projectsTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1", scope: `${QBO_ACCOUNTING_SCOPE} ${QBO_PROJECT_SCOPE}` },
        preferences: { Preferences: { OtherPrefs: { ProjectsEnabled: true } } },
        checkEntitlement: async () => ({ ok: true }),
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "projects_create_unavailable");
    assert.equal(result.message, "QuickBooks Project creation is not available for this connection.");
  });

  test("Jobs UI explains unavailable Project creation without exposing mutation error", () => {
    const source = readFileSync(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
    assert.match(source, /QuickBooks Project creation is not available for this connection\./);
    assert.doesNotMatch(source, /projects_create_mutation_not_configured/);
    assert.match(source, /checked=\{false\} disabled/);
  });
});
