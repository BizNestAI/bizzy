// Live Bizzi insights now use the global Contractor CFO engine only.
// Legacy module generators remain in the repo for historical/demo compatibility
// but are intentionally not invoked from this live entry point.

import { generateContractorCfoInsights } from './contractorCfo.generators.js';

export async function generateAllInsights({
  businessId,
  trigger = 'manual',
  force = false,
  limit,
} = {}) {
  return generateContractorCfoInsights({
    businessId,
    trigger,
    force,
    limit,
  });
}

export default generateAllInsights;
