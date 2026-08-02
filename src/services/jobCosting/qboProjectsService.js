import fetch from "node-fetch";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { getLatestQuickBooksTokenRow, withQuickBooksAuth } from "../quickbooksTokenService.js";
import { qbApiBase, qboEnvName, isSandbox } from "../../utils/qboEnv.js";
import { normalizeQboAddress, normalizeQboRef, toDateOnly } from "./qboJobCostingParsers.js";
import { generateJobCandidatesForBusiness } from "./jobIdentityResolver.js";

export const QBO_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_PROJECT_SCOPE = process.env.QB_PROJECTS_SCOPE || "com.intuit.quickbooks.project-management.project";

export const QBO_PROJECTS_CAPABILITY_STATUSES = Object.freeze({
  AVAILABLE_AND_ENABLED: "available_and_enabled",
  AVAILABLE_BUT_PROJECTS_DISABLED: "available_but_projects_disabled",
  SCOPE_NOT_AUTHORIZED: "scope_not_authorized",
  PARTNER_ENTITLEMENT_MISSING: "partner_entitlement_missing",
  UNSUPPORTED_QBO_PLAN: "unsupported_qbo_plan",
  GRAPHQL_UNAVAILABLE: "graphql_unavailable",
  UNKNOWN: "unknown",
  ERROR: "error",
});

const MINOR_VERSION = "75";
const PROJECTS_SOURCE_OF_TRUTH = "qbo_project_authoritative";
const MANUAL_SOURCE_OF_TRUTH = "manual_link_only";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withQboRetry(operation, { attempts = 3, baseDelayMs = 300 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = RETRY_STATUSES.has(Number(error?.status || error?.statusCode));
      if (!retryable || attempt === attempts) break;
      const retryAfter = Number(error?.retryAfterMs || 0);
      await sleep(retryAfter || baseDelayMs * attempt);
    }
  }
  throw lastError;
}

function boolFromEnv(value) {
  return /^(1|true|yes)$/i.test(String(value || ""));
}

function isMissingSchemaError(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code) || /does not exist|schema cache|column/i.test(error?.message || "");
}

export function shouldRequestQboProjectsScope({ explicit = false } = {}) {
  return boolFromEnv(process.env.QB_ENABLE_PROJECTS_SCOPE) && explicit;
}

export function buildQuickBooksOAuthScopes({ includeProjects = false } = {}) {
  const scopeSet = new Set([QBO_ACCOUNTING_SCOPE]);
  if (shouldRequestQboProjectsScope({ explicit: includeProjects })) scopeSet.add(QBO_PROJECT_SCOPE);
  return Array.from(scopeSet);
}

export function tokenHasScope(scopeString = "", scope) {
  if (!scope) return false;
  const scopes = String(scopeString || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return scopes.includes(scope);
}

export function parseProjectsEnabledPreference(preferences = {}) {
  const prefs = preferences?.Preferences || preferences || {};
  const otherPrefs = prefs?.OtherPrefs || {};
  if (typeof otherPrefs?.ProjectsEnabled === "boolean") return otherPrefs.ProjectsEnabled;
  if (typeof otherPrefs?.ProjectsEnabled === "string") return /^true$/i.test(otherPrefs.ProjectsEnabled);

  const nameValue = otherPrefs?.NameValue || otherPrefs?.NameValuePair || [];
  const pairs = Array.isArray(nameValue) ? nameValue : [nameValue];
  const match = pairs.find((pair) => /ProjectsEnabled/i.test(String(pair?.Name || pair?.name || "")));
  if (!match) return null;
  const value = match.Value ?? match.value;
  if (typeof value === "boolean") return value;
  if (value == null) return null;
  return /^true$/i.test(String(value));
}

export function mapProjectsGraphqlError(error = {}) {
  const status = Number(error.status || error.statusCode || 0);
  const body = `${error.body || error.message || ""}`.toLowerCase();
  if (status === 402 || /plan|subscription|unsupported/.test(body)) {
    return QBO_PROJECTS_CAPABILITY_STATUSES.UNSUPPORTED_QBO_PLAN;
  }
  if (status === 403 || /entitlement|partner|permission/.test(body)) {
    return QBO_PROJECTS_CAPABILITY_STATUSES.PARTNER_ENTITLEMENT_MISSING;
  }
  if (status === 401 || /scope|authorization|unauthorized/.test(body)) {
    return QBO_PROJECTS_CAPABILITY_STATUSES.SCOPE_NOT_AUTHORIZED;
  }
  if (status === 404 || /graphql|not found|unavailable/.test(body)) {
    return QBO_PROJECTS_CAPABILITY_STATUSES.GRAPHQL_UNAVAILABLE;
  }
  return QBO_PROJECTS_CAPABILITY_STATUSES.ERROR;
}

export function determineProjectsCapabilityStatus({
  accountingScopePresent,
  projectScopePresent,
  projectsEnabledPreference,
  entitlementStatus = null,
  graphqlAvailable = null,
} = {}) {
  if (!accountingScopePresent || !projectScopePresent) return QBO_PROJECTS_CAPABILITY_STATUSES.SCOPE_NOT_AUTHORIZED;
  if (projectsEnabledPreference === false) return QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_BUT_PROJECTS_DISABLED;
  if (entitlementStatus) return entitlementStatus;
  if (graphqlAvailable === true && projectsEnabledPreference !== false) return QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_AND_ENABLED;
  if (graphqlAvailable === false) return QBO_PROJECTS_CAPABILITY_STATUSES.GRAPHQL_UNAVAILABLE;
  return QBO_PROJECTS_CAPABILITY_STATUSES.UNKNOWN;
}

function projectGraphqlUrl() {
  if (process.env.QB_PROJECTS_GRAPHQL_URL) return process.env.QB_PROJECTS_GRAPHQL_URL;
  return isSandbox ? "https://sandbox-quickbooks.api.intuit.com/graphql" : "https://quickbooks.api.intuit.com/graphql";
}

export class QboProjectsGraphqlError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "QboProjectsGraphqlError";
    Object.assign(this, details);
  }
}

export class QboProjectsGraphqlClient {
  constructor({ accessToken, realmId, fetchImpl = fetch, endpoint = projectGraphqlUrl() } = {}) {
    if (!accessToken) throw new Error("accessToken is required");
    if (!realmId) throw new Error("realmId is required");
    this.accessToken = accessToken;
    this.realmId = realmId;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
  }

  async request(query, variables = {}) {
    return withQboRetry(async () => {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Intuit-Realm-Id": this.realmId,
        },
        body: JSON.stringify({ query, variables: { realmId: this.realmId, ...variables } }),
      });
      const text = await response.text();
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (!response.ok || json?.errors?.length) {
        throw new QboProjectsGraphqlError("QuickBooks Projects GraphQL request failed", {
          status: response.status,
          body: text?.slice?.(0, 1000) || "",
          errors: json?.errors || [],
        });
      }
      return json;
    });
  }

  async checkEntitlement() {
    const query = `
      query BizziProjectsCapability($realmId: String!) {
        company(realmId: $realmId) { id }
      }
    `;
    return this.request(query);
  }

  async fetchProjectsPage({ cursor = null, pageSize = 100 } = {}) {
    const query = `
      query BizziProjects($realmId: String!, $first: Int!, $after: String) {
        company(realmId: $realmId) {
          projects(first: $first, after: $after) {
            edges {
              cursor
              node {
                id
                name
                displayName
                fullyQualifiedName
                status
                active
                startDate
                endDate
                syncToken
                updatedAt
                customer { id displayName }
                parentCustomer { id displayName }
                billAddr { line1 line2 city countrySubDivisionCode postalCode country }
                shipAddr { line1 line2 city countrySubDivisionCode postalCode country }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `;
    const json = await this.request(query, { first: pageSize, after: cursor });
    const connection = json?.data?.company?.projects || json?.data?.projects || {};
    return {
      projects: (connection.edges || []).map((edge) => edge.node || edge).filter(Boolean),
      nextCursor: connection.pageInfo?.hasNextPage ? connection.pageInfo?.endCursor || null : null,
    };
  }

  async createProject() {
    throw new QboProjectsGraphqlError("QuickBooks Project creation requires an entitlement-specific GraphQL mutation.", {
      code: "projects_create_mutation_not_configured",
      status: 501,
    });
  }
}

async function fetchPreferences({ realmId, accessToken, fetchImpl = fetch }) {
  const url = `${qbApiBase}/v3/company/${realmId}/preferences?minorversion=${MINOR_VERSION}`;
  return withQboRetry(async () => {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      const error = new Error(`QuickBooks Preferences request failed ${response.status}: ${text}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return json;
  });
}

async function upsertCapability({ db, businessId, realmId, payload }) {
  const { data, error } = await db
    .from("qbo_projects_capabilities")
    .upsert(
      {
        business_id: businessId,
        realm_id: realmId,
        qbo_env: qboEnvName,
        ...payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "business_id,realm_id,qbo_env" }
    )
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function checkQboProjectsCapability({
  businessId,
  db = defaultSupabase,
  fetchImpl = fetch,
  projectsTransport = null,
  now = new Date(),
} = {}) {
  if (!businessId) throw new Error("businessId is required");
  const token = projectsTransport?.tokenRow || await getLatestQuickBooksTokenRow(businessId);
  if (!token?.realm_id && !projectsTransport?.realmId) {
    return {
      ok: false,
      status: QBO_PROJECTS_CAPABILITY_STATUSES.UNKNOWN,
      error: "quickbooks_connection_missing",
    };
  }

  const realmId = projectsTransport?.realmId || token.realm_id;
  const scopeString = projectsTransport?.scope || token?.scope || "";
  const accountingScopePresent = tokenHasScope(scopeString, QBO_ACCOUNTING_SCOPE);
  const projectScopePresent = tokenHasScope(scopeString, QBO_PROJECT_SCOPE);
  let projectsEnabledPreference = null;
  let entitlementResponse = {};
  let errorResponse = {};
  let status = determineProjectsCapabilityStatus({ accountingScopePresent, projectScopePresent });

  const runner = async (accessToken, context = {}) => {
    const activeRealmId = projectsTransport?.realmId || context.realmId || realmId;
    if (accountingScopePresent) {
      try {
        const preferences = projectsTransport?.preferences || await fetchPreferences({ realmId: activeRealmId, accessToken, fetchImpl });
        projectsEnabledPreference = parseProjectsEnabledPreference(preferences);
      } catch (error) {
        errorResponse.preferences = { status: error.status || null, message: error.message };
      }
    }

    if (!projectScopePresent) {
      status = determineProjectsCapabilityStatus({ accountingScopePresent, projectScopePresent, projectsEnabledPreference });
    } else if (projectsEnabledPreference === false) {
      status = QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_BUT_PROJECTS_DISABLED;
    } else {
      try {
        const entitlement = projectsTransport?.checkEntitlement
          ? await projectsTransport.checkEntitlement({ realmId: activeRealmId, accessToken })
          : await new QboProjectsGraphqlClient({ accessToken, realmId: activeRealmId, fetchImpl }).checkEntitlement();
        entitlementResponse = entitlement || { ok: true };
        status = determineProjectsCapabilityStatus({
          accountingScopePresent,
          projectScopePresent,
          projectsEnabledPreference,
          graphqlAvailable: true,
        });
      } catch (error) {
        errorResponse.graphql = {
          status: error.status || null,
          code: error.code || null,
          message: error.message,
          body: error.body || null,
        };
        status = mapProjectsGraphqlError(error);
      }
    }

    const row = await upsertCapability({
      db,
      businessId,
      realmId: activeRealmId,
      payload: {
        status,
        checked_at: now.toISOString(),
        accounting_scope_present: accountingScopePresent,
        project_scope_present: projectScopePresent,
        projects_enabled_preference: projectsEnabledPreference,
        entitlement_response: entitlementResponse,
        error_response: errorResponse,
      },
    });

    return {
      ok: status !== QBO_PROJECTS_CAPABILITY_STATUSES.ERROR,
      status,
      capability: row,
      accountingScopePresent,
      projectScopePresent,
      projectsEnabledPreference,
      entitlementResponse,
      errorResponse,
    };
  };

  if (projectsTransport) {
    return runner(projectsTransport.accessToken || token?.access_token || "test-token", { realmId });
  }
  return withQuickBooksAuth(businessId, runner);
}

async function getCustomerIdForQboCustomer({ db, businessId, realmId, qboCustomerId }) {
  if (!qboCustomerId) return null;
  const { data, error } = await db
    .from("qbo_customers")
    .select("customer_id")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_customer_id", String(qboCustomerId))
    .maybeSingle();
  if (error) throw error;
  return data?.customer_id || null;
}

async function getJobIdForProject({ db, businessId, realmId, qboProjectId }) {
  const { data, error } = await db
    .from("job_external_links")
    .select("job_id")
    .eq("business_id", businessId)
    .eq("source_system", "quickbooks")
    .eq("source_entity_type", "project")
    .eq("realm_id", realmId)
    .eq("external_entity_id", String(qboProjectId))
    .maybeSingle();
  if (error) throw error;
  return data?.job_id || null;
}

async function findBusinessOwnerUserId({ db, businessId }) {
  const { data, error } = await db
    .from("business_profiles")
    .select("user_id")
    .eq("id", businessId)
    .maybeSingle();
  if (error) return null;
  return data?.user_id || null;
}

export function normalizeQboProject(project = {}, { businessId, realmId, customerId = null, jobId = null, now = new Date() } = {}) {
  const parentCustomerRef = normalizeQboRef(project.ParentRef || project.parentCustomer || project.CustomerRef || project.customer);
  const displayName = project.DisplayName || project.displayName || project.Name || project.name || null;
  const projectName = project.ProjectName || project.projectName || project.Name || project.name || displayName;
  return {
    business_id: businessId,
    job_id: jobId,
    customer_id: customerId,
    realm_id: realmId,
    qbo_env: qboEnvName,
    qbo_project_id: String(project.Id || project.id),
    qbo_parent_customer_id: parentCustomerRef?.value || null,
    display_name: displayName,
    fully_qualified_name: project.FullyQualifiedName || project.fullyQualifiedName || displayName,
    project_name: projectName,
    status: project.Status || project.status || (project.Active === false || project.active === false ? "archived" : "active"),
    active: project.Active ?? project.active ?? true,
    start_date: toDateOnly(project.StartDate || project.startDate),
    end_date: toDateOnly(project.EndDate || project.endDate),
    billing_address: normalizeQboAddress(project.BillAddr || project.billAddr),
    shipping_address: normalizeQboAddress(project.ShipAddr || project.shipAddr),
    sync_token: project.SyncToken || project.syncToken || null,
    source_updated_at: project.MetaData?.LastUpdatedTime || project.updatedAt || null,
    last_synced_at: now.toISOString(),
    sync_status: "synced",
    source_snapshot: project,
  };
}

async function upsertQboProject({ db, projectPayload }) {
  const { data, error } = await db
    .from("qbo_projects")
    .upsert(projectPayload, { onConflict: "business_id,realm_id,qbo_project_id" })
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createOrUpdateJobFromProject({ db, businessId, realmId, project, customerId, userId, now }) {
  const qboProjectId = String(project.Id || project.id);
  let jobId = await getJobIdForProject({ db, businessId, realmId, qboProjectId });
  const normalized = normalizeQboProject(project, { businessId, realmId, customerId, jobId, now });

  if (jobId) {
    const { error } = await db
      .from("jobs")
      .update({
        customer_id: customerId,
        client_name: project.parentCustomer?.displayName || project.CustomerRef?.name || project.CustomerRef?.value || null,
        job_name: normalized.project_name,
        start_date: normalized.start_date,
        end_date: normalized.end_date,
        status: normalized.active === false ? "completed" : "active",
        source_type: "quickbooks",
        creation_method: "qbo_project_import",
        sync_status: "synced",
        source_of_truth: PROJECTS_SOURCE_OF_TRUTH,
        updated_at: now.toISOString(),
      })
      .eq("id", jobId);
    if (error) throw error;
  } else {
    if (!userId) return { jobId: null, skipped: "business_owner_missing" };
    const { data, error } = await db
      .from("jobs")
      .insert({
        user_id: userId,
        business_id: businessId,
        customer_id: customerId,
        client_name: project.parentCustomer?.displayName || project.CustomerRef?.name || null,
        job_name: normalized.project_name || normalized.display_name || `QuickBooks Project ${qboProjectId}`,
        start_date: normalized.start_date,
        end_date: normalized.end_date,
        status: normalized.active === false ? "completed" : "active",
        source_type: "quickbooks",
        creation_method: "qbo_project_import",
        sync_status: "synced",
        source_of_truth: PROJECTS_SOURCE_OF_TRUTH,
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    jobId = data?.id || null;
  }

  if (jobId) {
    const { error: linkError } = await db
      .from("job_external_links")
      .upsert(
        {
          business_id: businessId,
          job_id: jobId,
          source_system: "quickbooks",
          source_entity_type: "project",
          external_entity_id: qboProjectId,
          external_parent_id: normalized.qbo_parent_customer_id,
          realm_id: realmId,
          sync_token: normalized.sync_token,
          source_updated_at: normalized.source_updated_at,
          last_synced_at: now.toISOString(),
          sync_status: "synced",
          source_snapshot: project,
        },
        { onConflict: "business_id,realm_id,source_system,source_entity_type,external_entity_id" }
      );
    if (linkError) throw linkError;
  }

  return { jobId };
}

async function attachProjectDocuments({ db, businessId, realmId, projectId, jobId }) {
  if (!jobId || !projectId) return 0;
  let query = db
    .from("job_revenue_documents")
    .select("id, project_ref")
    .eq("business_id", businessId)
    .eq("source_system", "quickbooks")
    .is("job_id", null);
  if (realmId) query = query.eq("realm_id", realmId);
  const { data, error } = await query;
  if (error) throw error;
  const ids = (data || []).filter((doc) => String(doc.project_ref?.value || "") === String(projectId)).map((doc) => doc.id);
  if (!ids.length) return 0;
  const { error: updateError } = await db.from("job_revenue_documents").update({ job_id: jobId }).in("id", ids);
  if (updateError) throw updateError;
  return ids.length;
}

async function fetchProjectsFromTransport({ projectsTransport, accessToken, realmId, fetchImpl }) {
  if (projectsTransport?.fetchAllProjects) return projectsTransport.fetchAllProjects({ realmId, accessToken });
  const client = projectsTransport?.client || new QboProjectsGraphqlClient({ accessToken, realmId, fetchImpl });
  const projects = [];
  let cursor = null;
  do {
    const page = await client.fetchProjectsPage({ cursor, pageSize: 100 });
    projects.push(...(page.projects || []));
    cursor = page.nextCursor || null;
  } while (cursor);
  return projects;
}

export async function runQboProjectsSync({
  businessId,
  db = defaultSupabase,
  fetchImpl = fetch,
  projectsTransport = null,
  autoImport = null,
  userId = null,
  now = new Date(),
} = {}) {
  if (!businessId) throw new Error("businessId is required");
  const capability = await checkQboProjectsCapability({ businessId, db, fetchImpl, projectsTransport, now });
  const status = capability.status;
  if (status !== QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_AND_ENABLED) {
    return {
      ok: false,
      skipped: true,
      status,
      message: "QuickBooks Projects sync is unavailable for this connection.",
      capability,
    };
  }

  const runner = async (accessToken, context = {}) => {
    const realmId = projectsTransport?.realmId || context.realmId || capability.capability?.realm_id;
    const capabilityRow = capability.capability || {};
    const shouldAutoImport = autoImport ?? Boolean(capabilityRow.auto_import_enabled);
    const ownerUserId = userId || await findBusinessOwnerUserId({ db, businessId });
    const projects = await fetchProjectsFromTransport({ projectsTransport, accessToken, realmId, fetchImpl });
    const counts = { fetched: projects.length, imported: 0, jobsCreatedOrUpdated: 0, documentsAttached: 0, failed: 0 };
    const failures = [];

    for (const project of projects) {
      try {
        const projectId = String(project.Id || project.id);
        const parentRef = normalizeQboRef(project.ParentRef || project.parentCustomer || project.CustomerRef || project.customer);
        const customerId = await getCustomerIdForQboCustomer({ db, businessId, realmId, qboCustomerId: parentRef?.value });
        let jobId = await getJobIdForProject({ db, businessId, realmId, qboProjectId: projectId });
        if (shouldAutoImport || jobId) {
          const importedJob = await createOrUpdateJobFromProject({ db, businessId, realmId, project, customerId, userId: ownerUserId, now });
          jobId = importedJob.jobId || jobId;
          if (jobId) counts.jobsCreatedOrUpdated += 1;
        }
        const projectPayload = normalizeQboProject(project, { businessId, realmId, customerId, jobId, now });
        await upsertQboProject({ db, projectPayload });
        counts.imported += 1;
        counts.documentsAttached += await attachProjectDocuments({ db, businessId, realmId, projectId, jobId });

        if (jobId) {
          let candidateQuery = db
            .from("job_candidates")
            .update({ candidate_status: "linked_existing", confirmed_job_id: jobId, updated_at: now.toISOString() })
            .eq("business_id", businessId)
            .eq("qbo_project_id", projectId)
            .in("candidate_status", ["pending", "approved_new"]);
          if (realmId) candidateQuery = candidateQuery.eq("realm_id", realmId);
          await candidateQuery;
        }
      } catch (error) {
        counts.failed += 1;
        failures.push({ project_id: String(project.Id || project.id || ""), error: error.message });
      }
    }

    await upsertCapability({
      db,
      businessId,
      realmId,
      payload: {
        status: QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_AND_ENABLED,
        last_successful_project_sync: now.toISOString(),
      },
    });

    let candidates = null;
    try {
      candidates = await generateJobCandidatesForBusiness({ businessId, realmId, db, now });
    } catch (error) {
      failures.push({ entity: "JobCandidate", error: error.message });
    }

    return {
      ok: counts.failed === 0,
      businessId,
      realmId,
      counts,
      failures,
      jobCandidates: candidates,
    };
  };

  if (projectsTransport) return runner(projectsTransport.accessToken || "test-token", { realmId: projectsTransport.realmId });
  return withQuickBooksAuth(businessId, runner);
}

export async function createQuickBooksProjectForJob({
  businessId,
  jobId,
  customerPayload = {},
  projectPayload = {},
  db = defaultSupabase,
  fetchImpl = fetch,
  projectsTransport = null,
  now = new Date(),
} = {}) {
  if (!businessId) throw new Error("businessId is required");
  if (!jobId) throw new Error("jobId is required");
  if (!projectsTransport?.createProject) {
    return {
      ok: false,
      status: QBO_PROJECTS_CAPABILITY_STATUSES.GRAPHQL_UNAVAILABLE,
      code: "projects_create_unavailable",
      message: "QuickBooks Project creation is not available for this connection.",
    };
  }
  const capability = await checkQboProjectsCapability({ businessId, db, fetchImpl, projectsTransport, now });
  if (capability.status !== QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_AND_ENABLED) {
    return {
      ok: false,
      status: capability.status,
      message: "QuickBooks Projects is not available for this connection. The job remains Bizzi-only.",
    };
  }

  const runner = async (accessToken, context = {}) => {
    const realmId = projectsTransport?.realmId || context.realmId || capability.capability?.realm_id;
    const customer = projectsTransport?.findOrCreateCustomer
      ? await projectsTransport.findOrCreateCustomer({ realmId, accessToken, customerPayload })
      : null;
    if (!customer) {
      throw new QboProjectsGraphqlError("QBO customer creation is not configured for this Projects entitlement.", {
        code: "qbo_customer_create_not_configured",
        status: 501,
      });
    }
    const project = await projectsTransport.createProject({ realmId, accessToken, customer, projectPayload });

    const qboProjectId = String(project.Id || project.id);
    const normalized = normalizeQboProject(project, { businessId, realmId, jobId, now });
    await upsertQboProject({ db, projectPayload: normalized });
    const { error: linkError } = await db
      .from("job_external_links")
      .upsert(
        {
          business_id: businessId,
          job_id: jobId,
          source_system: "quickbooks",
          source_entity_type: "project",
          external_entity_id: qboProjectId,
          external_parent_id: String(customer.Id || customer.id || ""),
          realm_id: realmId,
          sync_token: normalized.sync_token,
          source_updated_at: normalized.source_updated_at,
          last_synced_at: now.toISOString(),
          sync_status: "synced",
          source_snapshot: project,
        },
        { onConflict: "business_id,realm_id,source_system,source_entity_type,external_entity_id" }
      );
    if (linkError) throw linkError;

    const { error: jobError } = await db
      .from("jobs")
      .update({
        source_type: "quickbooks",
        sync_status: "synced",
        source_of_truth: PROJECTS_SOURCE_OF_TRUTH,
        updated_at: now.toISOString(),
      })
      .eq("id", jobId);
    if (jobError) throw jobError;

    return { ok: true, realmId, qboProjectId, project };
  };

  if (projectsTransport) return runner(projectsTransport.accessToken || "test-token", { realmId: projectsTransport.realmId });
  return withQuickBooksAuth(businessId, runner);
}

export async function getQboProjectsDiagnostics({ businessId, db = defaultSupabase } = {}) {
  if (!businessId) throw new Error("businessId is required");
  const [capability, projects] = await Promise.all([
    db.from("qbo_projects_capabilities").select("*").eq("business_id", businessId).order("checked_at", { ascending: false }).limit(1),
    db.from("qbo_projects").select("id", { count: "exact", head: true }).eq("business_id", businessId),
  ]);
  const capabilityError = capability.error;
  const projectsError = projects.error;
  if (capabilityError && !isMissingSchemaError(capabilityError)) throw capabilityError;
  if (projectsError && !isMissingSchemaError(projectsError)) throw projectsError;
  return {
    ok: true,
    capability: capabilityError ? null : capability.data?.[0] || null,
    counts: {
      qboProjects: projectsError ? 0 : projects.count || 0,
    },
    blockers: {
      dashboardScopeRequired: !boolFromEnv(process.env.QB_ENABLE_PROJECTS_SCOPE),
      graphqlEndpointConfigured: Boolean(process.env.QB_PROJECTS_GRAPHQL_URL),
      entitlementMustBeConfirmedByIntuit: true,
    },
    limitations: {
      graphqlProjectsIntegrationEnabled: capability.data?.[0]?.status === QBO_PROJECTS_CAPABILITY_STATUSES.AVAILABLE_AND_ENABLED,
      customerAndDocumentCandidateFallbacksRemainAvailable: true,
      noSilentCustomerAsProjectFallback: true,
      defaultSourceOfTruth: MANUAL_SOURCE_OF_TRUTH,
    },
  };
}
