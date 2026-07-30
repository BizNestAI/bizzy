const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function cleanText(value, fallback = "") {
  return String(value || fallback).trim();
}

function formatMoney(value) {
  return currencyFormatter.format(Number(value || 0));
}

function getJobName(job = {}) {
  return cleanText(job.name || job.job_name || job.project_name || job.display_name || job.id, "this job");
}

function getCustomerName(job = {}, businessProfile = {}) {
  return cleanText(
    job.customer_name ||
      job.client_name ||
      job.customer ||
      job.parent_customer_name ||
      businessProfile.customer_name,
    "there"
  );
}

function calculateMarginPercent(changeOrder = {}) {
  const revenue = Number(changeOrder.approved_price ?? changeOrder.proposed_price ?? changeOrder.recommended_price ?? 0);
  const cost = Number(changeOrder.estimated_cost || 0);
  if (!Number.isFinite(revenue) || revenue <= 0) return 0;
  return Math.round(((revenue - cost) / revenue) * 1000) / 10;
}

export function buildChangeOrderDraft({ job = {}, changeOrder = {}, businessProfile = {} } = {}) {
  const description = cleanText(changeOrder.description, "the additional work described");
  const jobName = getJobName(job);
  const customer = getCustomerName(job, businessProfile);
  const proposedPrice = Number(changeOrder.approved_price ?? changeOrder.proposed_price ?? changeOrder.recommended_price ?? 0);
  const estimatedCost = Number(changeOrder.estimated_cost || 0);
  const marginPercent = calculateMarginPercent(changeOrder);

  const draftScopeSummary = `Additional work requested: ${description}`;
  const draftClientMessage = `Hi ${customer}, we identified additional work outside the original scope for ${jobName}. The estimated cost for this change is ${formatMoney(proposedPrice)}. This includes ${description}. Please reply with approval before we proceed.`;
  const internalSummary = `This change order adds ${formatMoney(estimatedCost)} cost and ${formatMoney(proposedPrice)} revenue, estimated margin ${marginPercent}%.`;

  return {
    draft_scope_summary: draftScopeSummary,
    draft_client_message: draftClientMessage,
    internal_summary: internalSummary,
  };
}

export default buildChangeOrderDraft;
