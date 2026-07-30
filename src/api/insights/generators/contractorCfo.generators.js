import {
  runContractorCfoInsightsIfEnabled,
} from '../../../services/insights/contractorCfoTriggerService.js';

export async function generateContractorCfoInsights({
  businessId,
  trigger = 'manual',
  force = false,
  limit,
} = {}) {
  if (!businessId) {
    return { ok: false, skipped: true, reason: 'missing_business_id', inserted: 0 };
  }
  return runContractorCfoInsightsIfEnabled({
    businessId,
    trigger,
    force,
    ...(limit ? { limit } : {}),
  });
}

export default generateContractorCfoInsights;
