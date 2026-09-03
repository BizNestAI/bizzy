import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { toDateOnly, toNumber } from "./qboJobCostingParsers.js";

const ACTIVE_CANDIDATE_STATUSES = new Set(["pending"]);
const AUTHORITATIVE_SCORE = 100;

function isMissingSchemaError(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code) || /does not exist|schema cache|column/i.test(error?.message || "");
}

export function normalizeIdentityText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAddressPart(value) {
  return normalizeIdentityText(value).replace(/\b(street|st)\b/g, "st").replace(/\b(avenue|ave)\b/g, "ave");
}

export function normalizeAddressKey(address = null) {
  if (!address || typeof address !== "object") return null;
  const line1 = normalizeAddressPart(address.line1 || address.Line1 || "");
  const city = normalizeAddressPart(address.city || address.City || "");
  const state = normalizeAddressPart(address.state || address.country_subdivision_code || address.CountrySubDivisionCode || "");
  const postal = normalizeAddressPart(address.postal_code || address.PostalCode || "");
  const key = [line1, city, state, postal].filter(Boolean).join("|");
  return key || null;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getRefValue(ref) {
  return ref?.value || ref?.Value || ref?.id || ref?.Id || null;
}

function getRefName(ref) {
  return ref?.name || ref?.Name || null;
}

function getDocumentSourceType(document = {}) {
  return document.source_document_type || document.sourceEntityType || document.type || "";
}

function getDocumentExternalId(document = {}) {
  return document.external_document_id || document.source_entity_id || document.id || null;
}

function normalizeRevenueDocumentType(value = "") {
  const type = String(value || "invoice").trim().toLowerCase();
  if (type.includes("estimate")) return "estimate";
  if (type.includes("sales_receipt") || type.includes("sales receipt")) return "sales_receipt";
  if (type.includes("credit_memo") || type.includes("credit memo")) return "credit_memo";
  if (type.includes("contract")) return "contract";
  return "invoice";
}

function getDocumentCustomerRef(document = {}) {
  const ref = document.customer_ref || document.customerRef || document.CustomerRef || null;
  const value = getRefValue(ref);
  if (!value) return null;
  return { value: String(value), name: getRefName(ref) };
}

function getDocumentProjectRef(document = {}) {
  const ref = document.project_ref || document.projectRef || document.ProjectRef || null;
  const value = getRefValue(ref);
  if (!value) return null;
  return { value: String(value), name: getRefName(ref) };
}

function getServiceAddress(document = {}, qboCustomer = null) {
  return document.shipping_address || document.shippingAddress || document.ShipAddr || qboCustomer?.shipping_address || qboCustomer?.shippingAddress || null;
}

function getDocumentMemo(document = {}) {
  return document.memo || document.customer_memo || document.customerMemo || document.private_note || document.PrivateNote || "";
}

function getLineSummaries(document = {}) {
  return asArray(document.line_summaries || document.lineSummaries || document.Line);
}

function lineDescription(line = {}) {
  return String(line.description || line.Description || line.item_ref?.name || line.ItemRef?.name || "").trim();
}

function lineSummaryText(document = {}) {
  return getLineSummaries(document).map(lineDescription).filter(Boolean).join(" ");
}

function containsAny(value, words) {
  const text = normalizeIdentityText(value);
  return words.some((word) => text.includes(word));
}

export function isRecurringDocument(document = {}) {
  const text = `${getDocumentMemo(document)} ${lineSummaryText(document)} ${document.document_number || ""}`;
  return containsAny(text, ["monthly", "recurring", "maintenance", "subscription", "service plan", "retainer"]);
}

export function isProductOnlyDocument(document = {}) {
  const lines = getLineSummaries(document);
  if (!lines.length) return false;
  const descriptions = lines.map(lineDescription).filter(Boolean);
  if (!descriptions.length) return false;
  const productLike = descriptions.every((description) =>
    containsAny(description, ["material", "materials", "product", "hardware", "supply", "supplies", "part", "parts"]),
  );
  const serviceLike = descriptions.some((description) =>
    containsAny(description, ["labor", "install", "installation", "repair", "remodel", "build", "subcontract", "project"]),
  );
  return productLike && !serviceLike;
}

function statusIsSuppressed(document = {}) {
  const status = normalizeIdentityText(document.status || document.TxnStatus || document.Status || "");
  return status === "voided" || status === "deleted" || status === "inactive";
}

function getCustomerName(document = {}, qboCustomer = null) {
  return (
    qboCustomer?.display_name ||
    qboCustomer?.DisplayName ||
    getDocumentCustomerRef(document)?.name ||
    document.customer_name ||
    document.customerName ||
    null
  );
}

function suggestedJobName(document = {}, qboCustomer = null) {
  const projectRef = getDocumentProjectRef(document);
  if (projectRef?.name) return projectRef.name;
  if (qboCustomer?.is_sub_customer && qboCustomer?.display_name) return qboCustomer.display_name;
  return getCustomerName(document, qboCustomer) || document.document_number || "Untitled job candidate";
}

function getProjectJobNumber(document = {}) {
  return document.project_job_number || document.job_number || document.document_number || null;
}

function confidenceLevel(score, fallback = "manual_review") {
  if (score >= 95) return "authoritative";
  if (score >= 80) return "high";
  if (score >= 55) return "medium";
  if (score > 0) return "low";
  return fallback;
}

function sourceKey(document = {}) {
  return {
    source_system: document.source_system || "quickbooks",
    source_entity_type: getDocumentSourceType(document),
    source_entity_id: String(getDocumentExternalId(document) || ""),
  };
}

function findLink({ externalLinks = [], entityType, externalId, realmId = null }) {
  if (!externalId) return null;
  return externalLinks.find((link) =>
    link.source_system === "quickbooks" &&
    link.source_entity_type === entityType &&
    String(link.external_entity_id) === String(externalId) &&
    (!realmId || !link.realm_id || String(link.realm_id) === String(realmId)) &&
    link.job_id
  );
}

function findMapping({ learnedMappings = [], mappingType, sourceEntityId = null, addressKey = null, realmId = null }) {
  return learnedMappings.find((mapping) =>
    mapping.active !== false &&
    mapping.source_system === "quickbooks" &&
    mapping.mapping_type === mappingType &&
    (!realmId || !mapping.realm_id || String(mapping.realm_id) === String(realmId)) &&
    ((sourceEntityId && String(mapping.source_entity_id) === String(sourceEntityId)) ||
      (addressKey && mapping.normalized_address_key === addressKey)) &&
    mapping.job_id
  );
}

function findLinkedDocumentJob(document = {}, linkedDocuments = [], realmId = null) {
  const linked = asArray(document.linked_txn || document.linkedTxn);
  for (const link of linked) {
    const externalId = link.linked_transaction_id || link.TxnId || link.txnId;
    const type = link.linked_transaction_type || link.TxnType || link.txnType;
    const found = linkedDocuments.find((doc) =>
      doc.job_id &&
      String(doc.external_document_id) === String(externalId) &&
      (!realmId || !doc.realm_id || String(doc.realm_id) === String(realmId)) &&
      (!type || normalizeIdentityText(doc.source_document_type) === normalizeIdentityText(type)),
    );
    if (found?.job_id) return found.job_id;
  }
  return null;
}

function possibleMatchesForDocument(document = {}, jobs = []) {
  const addressKey = normalizeAddressKey(getServiceAddress(document));
  const customer = normalizeIdentityText(document.customer_name || getDocumentCustomerRef(document)?.name || "");
  const name = normalizeIdentityText(suggestedJobName(document));
  return jobs
    .map((job) => {
      const jobAddress = normalizeAddressKey(job.service_address || {
        line1: job.address,
        city: job.city,
        country_subdivision_code: job.state,
        postal_code: job.postal_code,
      });
      const jobCustomer = normalizeIdentityText(job.client_name || job.customer_name || job.customerName || "");
      const jobName = normalizeIdentityText(job.job_name || job.jobName || "");
      let score = 0;
      const reasons = [];
      if (addressKey && jobAddress && addressKey === jobAddress) {
        score += 35;
        reasons.push("service_address_match");
      }
      if (customer && jobCustomer && customer === jobCustomer) {
        score += 20;
        reasons.push("customer_match");
      }
      if (name && jobName && (name.includes(jobName) || jobName.includes(name))) {
        score += 15;
        reasons.push("job_name_similarity");
      }
      return { job_id: job.id, job_name: job.job_name || job.jobName, score, reasons };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export function buildCandidatePayload({ businessId, document = {}, qboCustomer = null, confidenceScore = 50, reasons = [], possibleJobMatches = [] } = {}) {
  const customerRef = getDocumentCustomerRef(document);
  const projectRef = getDocumentProjectRef(document);
  const serviceAddress = getServiceAddress(document, qboCustomer);
  const documentType = getDocumentSourceType(document);
  const externalId = getDocumentExternalId(document);
  const recurring = isRecurringDocument(document);
  const lineSummaries = getLineSummaries(document);
  return {
    business_id: businessId || document.business_id,
    candidate_type: documentType === "estimate" ? "job_from_estimate" : "job_from_document",
    source_system: document.source_system || "quickbooks",
    source_entity_type: documentType,
    source_entity_id: String(externalId),
    realm_id: document.realm_id || qboCustomer?.realm_id || null,
    qbo_env: document.qbo_env || qboCustomer?.qbo_env || null,
    source_customer_id: document.customer_id || qboCustomer?.customer_id || null,
    qbo_customer_id: customerRef?.value || qboCustomer?.qbo_customer_id || null,
    qbo_subcustomer_id: qboCustomer?.is_sub_customer ? qboCustomer.qbo_customer_id : null,
    qbo_project_id: projectRef?.value || null,
    suggested_job_name: suggestedJobName(document, qboCustomer),
    customer_name: getCustomerName(document, qboCustomer),
    project_job_number: getProjectJobNumber(document),
    service_address: serviceAddress,
    invoice_estimate_amount: toNumber(document.total_amount ?? document.TotalAmt, 0),
    document_number: document.document_number || document.DocNumber || null,
    document_date: toDateOnly(document.document_date || document.TxnDate),
    memo: getDocumentMemo(document) || null,
    line_item_summary: lineSummaries,
    recurring_indicator: recurring,
    confidence_score: confidenceScore,
    confidence_level: confidenceLevel(confidenceScore),
    detection_reasons: reasons,
    candidate_status: "pending",
    possible_job_matches: possibleJobMatches,
    source_snapshot: {
      document,
      qbo_customer: qboCustomer,
      normalized_address_key: normalizeAddressKey(serviceAddress),
    },
  };
}

function existingJobDecision(jobId, score, reasons) {
  return {
    decision: "existing_job",
    jobId,
    confidenceScore: score,
    confidenceLevel: confidenceLevel(score),
    reasons,
    possibleJobMatches: [{ job_id: jobId, score, reasons }],
  };
}

export function resolveJobIdentity({
  businessId,
  document = {},
  qboCustomer = null,
  jobs = [],
  externalLinks = [],
  learnedMappings = [],
  linkedDocuments = [],
  userEnabledSubcustomerAutoMap = false,
} = {}) {
  const documentType = getDocumentSourceType(document);
  const totalAmount = toNumber(document.total_amount ?? document.TotalAmt, 0);
  const customerRef = getDocumentCustomerRef(document);
  const projectRef = getDocumentProjectRef(document);
  const realmId = document.realm_id || qboCustomer?.realm_id || null;
  const addressKey = normalizeAddressKey(getServiceAddress(document, qboCustomer));

  if (documentType === "credit_memo") {
    return { decision: "ignored", confidenceScore: 0, confidenceLevel: "ignored", reasons: ["credit_memo_never_creates_job"] };
  }
  if (statusIsSuppressed(document) || totalAmount === 0) {
    return { decision: "ignored", confidenceScore: 0, confidenceLevel: "ignored", reasons: ["voided_deleted_or_zero_document"] };
  }
  if (isProductOnlyDocument(document)) {
    return { decision: "ignored", confidenceScore: 0, confidenceLevel: "ignored", reasons: ["product_only_document"] };
  }

  const projectLink = findLink({ externalLinks, entityType: "project", externalId: projectRef?.value, realmId });
  if (projectLink?.job_id) return existingJobDecision(projectLink.job_id, AUTHORITATIVE_SCORE, ["qbo_project_external_link"]);

  const projectMapping = findMapping({ learnedMappings, mappingType: "qbo_project", sourceEntityId: projectRef?.value, realmId });
  if (projectMapping?.job_id) return existingJobDecision(projectMapping.job_id, AUTHORITATIVE_SCORE, ["qbo_project_user_confirmed_mapping"]);

  const source = sourceKey(document);
  const confirmedDocumentMapping = findMapping({
    learnedMappings,
    mappingType: "invoice_pattern",
    sourceEntityId: `${source.source_entity_type}:${source.source_entity_id}`,
    realmId,
  });
  if (confirmedDocumentMapping?.job_id) {
    return existingJobDecision(confirmedDocumentMapping.job_id, 98, ["exact_user_confirmed_document_mapping"]);
  }

  const subcustomerId = qboCustomer?.is_sub_customer ? qboCustomer.qbo_customer_id : null;
  const subcustomerMapping = findMapping({ learnedMappings, mappingType: "qbo_subcustomer", sourceEntityId: subcustomerId, realmId });
  if (subcustomerMapping?.job_id) return existingJobDecision(subcustomerMapping.job_id, 96, ["qbo_subcustomer_user_confirmed_mapping"]);

  const customerMapping = findMapping({ learnedMappings, mappingType: "qbo_customer", sourceEntityId: customerRef?.value, realmId });
  if (customerMapping?.job_id) return existingJobDecision(customerMapping.job_id, 92, ["qbo_customer_user_confirmed_mapping"]);

  const addressMapping = findMapping({ learnedMappings, mappingType: "address", addressKey, realmId });
  if (addressMapping?.job_id) return existingJobDecision(addressMapping.job_id, 90, ["address_user_confirmed_mapping"]);

  const linkedJobId = findLinkedDocumentJob(document, linkedDocuments, realmId);
  if (linkedJobId) return existingJobDecision(linkedJobId, 92, ["estimate_invoice_linked_to_existing_job"]);

  const repeatedDocs = linkedDocuments.filter((doc) =>
    doc.job_id &&
    doc.customer_id &&
    document.customer_id &&
    String(doc.customer_id) === String(document.customer_id) &&
    normalizeAddressKey(doc.shipping_address || doc.billing_address) === addressKey
  );
  const repeatedJobIds = [...new Set(repeatedDocs.map((doc) => doc.job_id).filter(Boolean))];
  if (repeatedJobIds.length === 1) return existingJobDecision(repeatedJobIds[0], 90, ["repeated_source_documents_linked_to_job"]);

  const possibleJobMatches = possibleMatchesForDocument(document, jobs);
  const reasons = [];
  let score = documentType === "estimate" ? 58 : 62;

  if (projectRef?.value) {
    score = 88;
    reasons.push("qbo_project_ref_requires_project_mapping");
  }
  if (subcustomerId) {
    score = Math.max(score, userEnabledSubcustomerAutoMap ? 86 : 82);
    reasons.push("qbo_subcustomer_potential_job_source");
  }
  if (addressKey && customerRef?.value) {
    score = Math.max(score, 66);
    reasons.push("customer_and_service_address_present");
  }
  if (documentType === "estimate") reasons.push("estimate_can_seed_job_before_invoice");
  if (documentType === "invoice") reasons.push("invoice_without_authoritative_project_identity");
  if (isRecurringDocument(document)) {
    score = Math.min(score, 45);
    reasons.push("recurring_invoice_lowered_confidence");
  }

  const candidatePayload = buildCandidatePayload({
    businessId,
    document,
    qboCustomer,
    confidenceScore: score,
    reasons,
    possibleJobMatches,
  });

  return {
    decision: score >= 55 ? "candidate" : "manual_review",
    confidenceScore: score,
    confidenceLevel: confidenceLevel(score),
    reasons,
    possibleJobMatches,
    candidatePayload,
  };
}

async function safeSelect({ db, table, select = "*", businessId, filters = [] }) {
  let query = db.from(table).select(select).eq("business_id", businessId);
  filters.forEach((filter) => {
    if (filter.op === "eq") query = query.eq(filter.column, filter.value);
    if (filter.op === "in") query = query.in(filter.column, filter.value);
    if (filter.op === "not") query = query.not(filter.column, filter.operator, filter.value);
  });
  const { data, error } = await query;
  if (error && isMissingSchemaError(error)) return [];
  if (error) throw error;
  return data || [];
}

function qboCustomerById(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    if (row.qbo_customer_id) map.set(String(row.qbo_customer_id), row);
  });
  return map;
}

async function upsertCandidate({ db, payload }) {
  const { data, error } = await db
    .from("job_candidates")
    .upsert(payload, { onConflict: "business_id,realm_id,source_system,source_entity_type,source_entity_id" })
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

function realmFilter(realmId) {
  return realmId ? [{ op: "eq", column: "realm_id", value: realmId }] : [];
}

export async function generateJobCandidatesForBusiness({ businessId, realmId = null, db = defaultSupabase, now = new Date() } = {}) {
  if (!businessId) throw new Error("businessId is required");

  const [documents, qboCustomers, jobs, externalLinks, learnedMappings, linkedDocuments] = await Promise.all([
    safeSelect({
      db,
      table: "job_revenue_documents",
      businessId,
      filters: [
        { op: "eq", column: "source_system", value: "quickbooks" },
        { op: "in", column: "source_document_type", value: ["invoice", "estimate"] },
        ...realmFilter(realmId),
      ],
    }),
    safeSelect({ db, table: "qbo_customers", businessId, filters: realmFilter(realmId) }),
    safeSelect({ db, table: "jobs", businessId }),
    safeSelect({ db, table: "job_external_links", businessId, filters: [{ op: "eq", column: "source_system", value: "quickbooks" }, ...realmFilter(realmId)] }),
    safeSelect({ db, table: "job_identity_mappings", businessId, filters: [{ op: "eq", column: "active", value: true }, ...realmFilter(realmId)] }),
    safeSelect({ db, table: "job_revenue_documents", businessId, filters: [{ op: "eq", column: "source_system", value: "quickbooks" }, ...realmFilter(realmId)] }),
  ]);

  const customerMap = qboCustomerById(qboCustomers);
  const result = { ok: true, createdOrUpdated: 0, linkedExisting: 0, ignored: 0, manualReview: 0, candidates: [] };

  for (const document of documents) {
    const customerRef = getDocumentCustomerRef(document);
    const qboCustomer = customerRef?.value ? customerMap.get(String(customerRef.value)) : null;
    const resolution = resolveJobIdentity({
      businessId,
      document,
      qboCustomer,
      jobs,
      externalLinks,
      learnedMappings,
      linkedDocuments,
    });

    if (resolution.decision === "existing_job" && resolution.jobId) {
      let query = db
        .from("job_revenue_documents")
        .update({ job_id: resolution.jobId, updated_at: now.toISOString() })
        .eq("business_id", businessId)
        .eq("source_system", document.source_system)
        .eq("source_document_type", document.source_document_type)
        .eq("external_document_id", document.external_document_id);
      if (document.realm_id) query = query.eq("realm_id", document.realm_id);
      const { error } = await query;
      if (error && !isMissingSchemaError(error)) throw error;
      result.linkedExisting += 1;
      continue;
    }

    if (resolution.decision === "ignored") {
      result.ignored += 1;
      continue;
    }

    if (!resolution.candidatePayload) {
      result.manualReview += 1;
      continue;
    }

    const candidate = await upsertCandidate({
      db,
      payload: {
        ...resolution.candidatePayload,
        updated_at: now.toISOString(),
      },
    });
    if (candidate) result.candidates.push(candidate);
    result.createdOrUpdated += 1;
  }

  return result;
}

export function buildManualJobInsertPayload({ businessId, userId, payload = {} } = {}) {
  return {
    business_id: businessId,
    user_id: userId,
    customer_id: payload.customer_id || payload.customerId || null,
    client_name: payload.client_name || payload.clientName || payload.customer_name || payload.customerName || null,
    job_name: payload.job_name || payload.jobName || payload.name,
    job_number: payload.job_number || payload.jobNumber || null,
    address: payload.address || payload.line1 || null,
    city: payload.city || null,
    state: payload.state || payload.country_subdivision_code || null,
    postal_code: payload.postal_code || payload.postalCode || null,
    status: payload.status || "active",
    start_date: payload.start_date || payload.startDate || null,
    end_date: payload.end_date || payload.endDate || null,
    target_margin: payload.target_margin ?? payload.targetMargin ?? null,
    job_costing_revenue_basis: payload.job_costing_revenue_basis || payload.revenueBasis || null,
    source_type: payload.source_type || payload.sourceType || "manual",
    creation_method: payload.creation_method || payload.creationMethod || "manual_add_job",
    sync_status: payload.sync_status || payload.syncStatus || "not_synced",
    contract_amount: payload.contract_amount ?? payload.contractAmount ?? null,
    updated_at: new Date().toISOString(),
  };
}

export function buildMappingPayloadFromCandidate({ businessId, candidate = {}, jobId, mappingType, now = new Date() } = {}) {
  const addressKey = normalizeAddressKey(candidate.service_address);
  const sourceEntityId =
    mappingType === "qbo_project" ? candidate.qbo_project_id :
    mappingType === "qbo_subcustomer" ? candidate.qbo_subcustomer_id :
    mappingType === "qbo_customer" ? candidate.qbo_customer_id :
    mappingType === "invoice_pattern" ? `${candidate.source_entity_type}:${candidate.source_entity_id}` :
    null;
  return {
    business_id: businessId || candidate.business_id,
    job_id: jobId || candidate.confirmed_job_id,
    source_system: candidate.source_system || "quickbooks",
    realm_id: candidate.realm_id || null,
    qbo_env: candidate.qbo_env || null,
    mapping_type: mappingType,
    source_entity_type: candidate.source_entity_type || null,
    source_entity_id: sourceEntityId,
    qbo_customer_id: candidate.qbo_customer_id || null,
    qbo_subcustomer_id: candidate.qbo_subcustomer_id || null,
    qbo_project_id: candidate.qbo_project_id || null,
    normalized_address_key: mappingType === "address" ? addressKey : null,
    invoice_pattern: mappingType === "invoice_pattern" ? { document_number: candidate.document_number || null } : {},
    confidence_source: "user_confirmed",
    active: true,
    source_snapshot: candidate,
    updated_at: now.toISOString(),
  };
}

async function persistMappingsForCandidate({ db, businessId, candidate, jobId, mappingTypes = [] }) {
  const mappings = mappingTypes
    .map((mappingType) => buildMappingPayloadFromCandidate({ businessId, candidate, jobId, mappingType }))
    .filter((mapping) => mapping.job_id && (mapping.source_entity_id || mapping.normalized_address_key));

  for (const mapping of mappings) {
    let query = db
      .from("job_identity_mappings")
      .select("id")
      .eq("business_id", mapping.business_id)
      .eq("source_system", mapping.source_system)
      .eq("mapping_type", mapping.mapping_type)
      .eq("active", true);
    query = mapping.normalized_address_key
      ? query.eq("normalized_address_key", mapping.normalized_address_key)
      : query.eq("source_entity_id", mapping.source_entity_id);
    if (mapping.realm_id) query = query.eq("realm_id", mapping.realm_id);

    const { data: existing, error: findError } = await query.maybeSingle();
    if (findError && !isMissingSchemaError(findError)) throw findError;
    const write = existing?.id
      ? db.from("job_identity_mappings").update(mapping).eq("id", existing.id)
      : db.from("job_identity_mappings").insert(mapping);
    const { error } = await write;
    if (error && !isMissingSchemaError(error)) throw error;
  }
  return mappings;
}

async function updateCandidateDocumentJob({ db, businessId, candidate, jobId, now = new Date() }) {
  if (!candidate?.source_entity_type || !candidate?.source_entity_id) return;
  const sourceDocumentType = normalizeRevenueDocumentType(candidate.source_entity_type);
  const externalDocumentId = String(candidate.source_entity_id);
  const sourceSystem = candidate.source_system || "quickbooks";
  let query = db
    .from("job_revenue_documents")
    .update({ job_id: jobId, updated_at: now.toISOString() })
    .eq("business_id", businessId)
    .eq("source_system", sourceSystem)
    .eq("source_document_type", sourceDocumentType)
    .eq("external_document_id", externalDocumentId);
  if (candidate.realm_id) query = query.eq("realm_id", candidate.realm_id);
  const { data: updatedRows, error } = await query.select("id");
  if (error && !isMissingSchemaError(error)) throw error;
  if (error || updatedRows?.length) return;

  const amount = Math.abs(toNumber(candidate.invoice_estimate_amount ?? candidate.document_amount ?? candidate.total_amount));
  const documentPayload = {
    business_id: businessId,
    job_id: jobId,
    source_system: sourceSystem,
    source_document_type: sourceDocumentType,
    external_document_id: externalDocumentId,
    document_number: candidate.document_number || candidate.source_document_number || candidate.project_job_number || null,
    document_date: toDateOnly(candidate.invoice_date || candidate.document_date || candidate.source_document_date || candidate.detected_at) || null,
    total_amount: amount,
    open_balance: sourceDocumentType === "invoice" || sourceDocumentType === "estimate" ? amount : 0,
    status: "active",
    currency: candidate.currency || candidate.iso_currency_code || "USD",
    customer_ref: candidate.source_customer_id || candidate.customer_name ? {
      value: candidate.source_customer_id || null,
      name: candidate.customer_name || candidate.source_customer_name || null,
    } : null,
    project_ref: candidate.source_project_id || candidate.suggested_job_name ? {
      value: candidate.source_project_id || null,
      name: candidate.suggested_job_name || null,
    } : null,
    billing_address: candidate.billing_address || null,
    shipping_address: candidate.service_address || candidate.shipping_address || null,
    source_snapshot: {
      source: "job_candidate_approval",
      candidate_id: candidate.id || null,
      candidate_source: candidate.source || null,
    },
    source_updated_at: candidate.source_updated_at || candidate.updated_at || null,
    last_synced_at: now.toISOString(),
    sync_status: "current",
    updated_at: now.toISOString(),
  };
  const { error: insertError } = await db
    .from("job_revenue_documents")
    .upsert(documentPayload, { onConflict: "business_id,source_system,source_document_type,external_document_id" });
  if (insertError && !isMissingSchemaError(insertError)) throw insertError;
}

async function fetchCandidateOrThrow({ db, businessId, candidateId }) {
  const { data, error } = await db
    .from("job_candidates")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const missing = new Error("Job candidate not found.");
    missing.status = 404;
    throw missing;
  }
  return data;
}

export async function approveJobCandidateCreateNew({ businessId, userId, candidateId, jobPayload = {}, mappingTypes = [], db = defaultSupabase } = {}) {
  if (!businessId || !candidateId) throw new Error("businessId and candidateId are required");
  if (!userId) throw new Error("userId is required to create a job");
  const candidate = await fetchCandidateOrThrow({ db, businessId, candidateId });
  const insertPayload = buildManualJobInsertPayload({
    businessId,
    userId,
    payload: {
      customer_id: candidate.source_customer_id,
      client_name: candidate.customer_name,
      job_name: jobPayload.job_name || jobPayload.jobName || candidate.suggested_job_name,
      job_number: jobPayload.job_number || jobPayload.jobNumber || candidate.project_job_number,
      address: candidate.service_address?.line1,
      city: candidate.service_address?.city,
      state: candidate.service_address?.country_subdivision_code,
      postal_code: candidate.service_address?.postal_code,
      source_type: "quickbooks",
      creation_method: "job_candidate",
      ...jobPayload,
    },
  });

  const { data: job, error: jobError } = await db.from("jobs").insert(insertPayload).select("*").maybeSingle();
  if (jobError) throw jobError;
  await updateCandidateDocumentJob({ db, businessId, candidate, jobId: job.id });
  const learnedMappings = await persistMappingsForCandidate({
    db,
    businessId,
    candidate,
    jobId: job.id,
    mappingTypes: mappingTypes.length ? mappingTypes : ["invoice_pattern"],
  });
  const { data: updatedCandidate, error: candidateError } = await db
    .from("job_candidates")
    .update({ candidate_status: "approved_new", confirmed_job_id: job.id })
    .eq("business_id", businessId)
    .eq("id", candidateId)
    .select("*")
    .maybeSingle();
  if (candidateError) throw candidateError;
  return { ok: true, job, candidate: updatedCandidate, learnedMappings };
}

export async function linkJobCandidateToExisting({ businessId, candidateId, jobId, mappingTypes = [], db = defaultSupabase } = {}) {
  if (!businessId || !candidateId || !jobId) throw new Error("businessId, candidateId, and jobId are required");
  const candidate = await fetchCandidateOrThrow({ db, businessId, candidateId });
  await updateCandidateDocumentJob({ db, businessId, candidate, jobId });
  const learnedMappings = await persistMappingsForCandidate({
    db,
    businessId,
    candidate,
    jobId,
    mappingTypes: mappingTypes.length ? mappingTypes : ["invoice_pattern"],
  });
  const { data, error } = await db
    .from("job_candidates")
    .update({ candidate_status: "linked_existing", confirmed_job_id: jobId })
    .eq("business_id", businessId)
    .eq("id", candidateId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return { ok: true, candidate: data, learnedMappings };
}

export async function revertCandidateCreatedJob({ businessId, jobId, db = defaultSupabase } = {}) {
  if (!businessId || !jobId) throw new Error("businessId and jobId are required");

  const { data: job, error: jobError } = await db
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) {
    const missing = new Error("Job was not found.");
    missing.status = 404;
    missing.code = "job_not_found";
    throw missing;
  }

  const { data: candidate, error: candidateError } = await db
    .from("job_candidates")
    .select("*")
    .eq("business_id", businessId)
    .eq("confirmed_job_id", jobId)
    .maybeSingle();
  if (candidateError && !isMissingSchemaError(candidateError)) throw candidateError;

  const creationMethod = String(job.creation_method || "").toLowerCase();
  const sourceType = String(job.source_type || "").toLowerCase();
  const sourceEntityType = String(job.source_entity_type || job.external_source_type || "").toLowerCase();
  const jobLooksSuggested =
    creationMethod === "job_candidate" ||
    sourceType.includes("candidate") ||
    Boolean(job.job_candidate_id || job.candidate_id || job.source_candidate_id) ||
    (
      sourceEntityType &&
      (sourceEntityType.includes("invoice") || sourceEntityType.includes("estimate")) &&
      !sourceType.includes("qbo_project") &&
      !sourceType.includes("subcustomer") &&
      !sourceType.includes("manual")
    );

  if (!candidate?.id && !jobLooksSuggested) {
    const unsupported = new Error("Only jobs created from Suggested Jobs can be moved back to Suggested Jobs.");
    unsupported.status = 400;
    unsupported.code = "job_revert_not_supported";
    throw unsupported;
  }

  const { data: assignmentRows, error: assignmentError } = await db
    .from("job_transaction_assignments")
    .select("id")
    .eq("business_id", businessId)
    .eq("job_id", jobId)
    .limit(1);
  if (assignmentError && !isMissingSchemaError(assignmentError)) throw assignmentError;
  if (assignmentRows?.length) {
    const blocked = new Error("Remove assigned transactions before moving this job back to Suggested Jobs.");
    blocked.status = 409;
    blocked.code = "job_has_assignments";
    throw blocked;
  }

  if (candidate?.id) {
    const { error: restoreError } = await db
      .from("job_candidates")
      .update({ candidate_status: "pending", confirmed_job_id: null })
      .eq("business_id", businessId)
      .eq("id", candidate.id);
    if (restoreError && !isMissingSchemaError(restoreError)) throw restoreError;
  }

  const { error: docError } = await db
    .from("job_revenue_documents")
    .update({ job_id: null, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("job_id", jobId);
  if (docError && !isMissingSchemaError(docError)) throw docError;

  const { error: deleteError } = await db
    .from("jobs")
    .delete()
    .eq("business_id", businessId)
    .eq("id", jobId);
  if (deleteError) throw deleteError;

  return {
    ok: true,
    deleted_job_id: jobId,
    candidate: candidate ? { ...candidate, candidate_status: "pending", confirmed_job_id: null } : null,
  };
}

export function isManualJobRecord(job = {}) {
  const creationMethod = String(job.creation_method || job.creationMethod || "").toLowerCase();
  const sourceType = String(job.source_type || job.sourceType || "").toLowerCase();
  return (
    (creationMethod.includes("manual") || sourceType.includes("manual")) &&
    !creationMethod.includes("candidate") &&
    !sourceType.includes("candidate") &&
    !sourceType.includes("qbo") &&
    !sourceType.includes("quickbooks")
  );
}

export async function deleteManualJob({ businessId, jobId, db = defaultSupabase } = {}) {
  if (!businessId || !jobId) throw new Error("businessId and jobId are required");

  const { data: job, error: jobError } = await db
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job || job.archived_at || String(job.status || "").toLowerCase() === "archived") {
    const missing = new Error("Job was not found.");
    missing.status = 404;
    missing.code = "job_not_found";
    throw missing;
  }

  if (!isManualJobRecord(job)) {
    const unsupported = new Error("Only manually created jobs can be deleted.");
    unsupported.status = 400;
    unsupported.code = "job_delete_not_supported";
    throw unsupported;
  }

  const { data: assignmentRows, error: assignmentError } = await db
    .from("job_transaction_assignments")
    .select("id")
    .eq("business_id", businessId)
    .eq("job_id", jobId)
    .limit(1);
  if (assignmentError && !isMissingSchemaError(assignmentError)) throw assignmentError;
  if (assignmentRows?.length) {
    const blocked = new Error("Remove assigned transactions before deleting this job.");
    blocked.status = 409;
    blocked.code = "job_has_assignments";
    throw blocked;
  }

  const now = new Date().toISOString();
  const { data: archivedJob, error: archiveError } = await db
    .from("jobs")
    .update({ status: "archived", archived_at: now, updated_at: now })
    .eq("business_id", businessId)
    .eq("id", jobId)
    .select("*")
    .maybeSingle();
  if (archiveError) throw archiveError;

  return { ok: true, deleted_job_id: jobId, job: archivedJob || { ...job, status: "archived", archived_at: now } };
}

export async function dismissJobCandidate({ businessId, candidateId, reason = null, db = defaultSupabase } = {}) {
  const { data, error } = await db
    .from("job_candidates")
    .update({ candidate_status: "dismissed", dismissal_reason: reason })
    .eq("business_id", businessId)
    .eq("id", candidateId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return { ok: true, candidate: data };
}

export async function mergeJobCandidates({ businessId, primaryCandidateId, candidateIds = [], db = defaultSupabase } = {}) {
  const ids = [...new Set(candidateIds.filter(Boolean))].filter((id) => id !== primaryCandidateId);
  if (!primaryCandidateId || !ids.length) return { ok: true, merged: 0 };
  const { error } = await db
    .from("job_candidates")
    .update({ candidate_status: "merged" })
    .eq("business_id", businessId)
    .in("id", ids)
    .in("candidate_status", [...ACTIVE_CANDIDATE_STATUSES]);
  if (error) throw error;
  return { ok: true, primaryCandidateId, merged: ids.length };
}

export async function createManualJob({ businessId, userId, jobPayload = {}, customerPayload = null, db = defaultSupabase } = {}) {
  if (!businessId || !userId) throw new Error("businessId and userId are required");
  let customerId = jobPayload.customer_id || jobPayload.customerId || null;
  if (!customerId && customerPayload?.display_name) {
    const { data: customer, error } = await db
      .from("customers")
      .insert({
        business_id: businessId,
        display_name: customerPayload.display_name,
        company_name: customerPayload.company_name || null,
        email: customerPayload.email || null,
        phone: customerPayload.phone || null,
        billing_address: customerPayload.billing_address || null,
        shipping_address: customerPayload.shipping_address || customerPayload.service_address || null,
        service_address: customerPayload.service_address || null,
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    customerId = customer?.id || null;
  }

  const { data: job, error } = await db
    .from("jobs")
    .insert(buildManualJobInsertPayload({ businessId, userId, payload: { ...jobPayload, customer_id: customerId } }))
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return { ok: true, job };
}
