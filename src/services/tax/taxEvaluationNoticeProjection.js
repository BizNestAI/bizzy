export function buildTaxEvaluationNotice(job) {
  if (job?.hasExactMembership !== true) return null;

  const declaredIds = uniqueIds(job.customerNoticeTransactionIds);
  const disclosedIds = uniqueIds((job.customerNoticeItems || [])
    .filter((item) => item?.excludedFromEstimate === true)
    .map((item) => item.transactionId));

  if (!declaredIds.length || !sameIds(declaredIds, disclosedIds)) return null;
  return { count: declaredIds.length, transactionIds: declaredIds };
}

function uniqueIds(ids = []) {
  return [...new Set(ids.filter((id) => id != null && String(id).trim()).map(String))];
}

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}
