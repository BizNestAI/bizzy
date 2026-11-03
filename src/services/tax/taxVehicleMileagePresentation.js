import { hasConfirmedVehicleElection, vehicleTaxTreatmentType, vehicleMethodNeedsConfirmation } from './taxVehicleAuthority.js';
import { normalizeQboGlAccountKey } from './taxQboGlNormalizer.js';

// Context uses exactly the server matrix membership. Protection never removes
// members. Refunds retain their signed effect, as in the matrix's book expense.
export function buildGasContext(entries, { taxYear, rates = [], vehicles = [] } = {}) {
  const gas = entries.filter(({ row }) => normalizeQboGlAccountKey(row.qboAccountName || row.source_qbo_account_name || row.raw?.source_qbo_account_name) === 'gas');
  const summarize = members => ({
    transactionCount: members.length,
    transactionIds: members.map(e => e.id).sort(),
    grossExpenseCents: members.reduce((sum, {row}) => sum - Math.round(Number(row.signedAmount ?? row.book_amount ?? -Number(row.amount || 0)) * 100), 0),
  });
  const publicSummary = members => { const value = summarize(members); return { ...value, grossExpenseAmount: value.grossExpenseCents / 100 }; };
  const covered = members => members.filter(({row}) => hasConfirmedVehicleElection(row, 'standard_mileage') && vehicleTaxTreatmentType(row).includes('standard_mileage') && !['needs_review','needs_tax_review'].includes(row.status || row.classification_status));
  const coveredMembers = covered(gas);
  const coveredIds = new Set(coveredMembers.map(e => e.id));
  const pending = gas.filter(e => vehicleMethodNeedsConfirmation(e.row) || !['reviewed','excluded','standard_rule_applied'].includes(e.outcome));
  const pendingIds = new Set(pending.map(e => e.id));
  const periods = rates.map(rate => ({
    effectiveStart: rate.effectiveStart, effectiveEnd: rate.effectiveEnd,
    ...publicSummary(gas.filter(({row}) => row.date >= rate.effectiveStart && row.date <= rate.effectiveEnd)),
  }));
  return { contractVersion: 'matrix-gas-context-v1', taxYear, total: publicSummary(gas), periods,
    coveredByStandardMileage: publicSummary(coveredMembers),
    requiresSeparateConfirmation: publicSummary(pending),
    otherConfirmed: publicSummary(gas.filter(e => !coveredIds.has(e.id) && !pendingIds.has(e.id))),
    byVehicle: Object.fromEntries(vehicles.map(v => { const members = coveredMembers.filter(e => String(e.row.vehicleId) === String(v.id)); return [v.id, publicSummary(members)]; })),
  };
}

// A dated entry entirely within one calendar month is evidence for that month.
// A multi-month total remains annual/period-only; never allocate it using Gas.
export function monthlyMileageAllocation(periods = []) {
  const months = {};
  let unallocatedCents = 0;
  for (const entry of periods) {
    const month = String(entry.periodStart).slice(0, 7);
    const cents = Math.round(Number(entry.deductionAmount ?? entry.amount ?? 0) * 100);
    if (month !== String(entry.periodEnd).slice(0, 7)) { unallocatedCents += cents; continue; }
    const prior = months[month] || { businessMiles: 0, deductionAmount: 0 };
    months[month] = { businessMiles: (Math.round(prior.businessMiles * 100) + Math.round(Number(entry.businessMiles) * 100)) / 100, deductionAmount: (Math.round(prior.deductionAmount * 100) + cents) / 100 };
  }
  const allocatedCents = Object.values(months).reduce((sum, month) => sum + Math.round(month.deductionAmount * 100), 0);
  const hasUnallocatedMiles = periods.some(p => String(p.periodStart).slice(0,7) !== String(p.periodEnd).slice(0,7) && Number(p.businessMiles) > 0);
  return { status: hasUnallocatedMiles ? Object.keys(months).length ? 'partial' : 'unavailable' : 'complete', months,
    allocatedDeductionAmount: allocatedCents / 100, unallocatedDeductionAmount: unallocatedCents / 100 };
}

export function mileageMonthFields(rate) {
  const year = Number(rate.effectiveStart.slice(0,4));
  return Array.from({length:12},(_,index)=>{
    const start = `${year}-${String(index+1).padStart(2,'0')}-01`;
    const end = `${year}-${String(index+1).padStart(2,'0')}-${new Date(Date.UTC(year,index+1,0)).getUTCDate()}`;
    return { periodStart: start, periodEnd: end, key: start.slice(0,7), label: new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US',{month:'long',timeZone:'UTC'}) };
  }).filter(m=>m.periodStart>=rate.effectiveStart && m.periodEnd<=rate.effectiveEnd);
}
