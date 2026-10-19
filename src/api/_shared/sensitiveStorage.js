const BUSINESS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SENSITIVE_BUCKETS = Object.freeze({
  ACCOUNTING_DOCUMENTS: 'bizzy-docs',
  FINANCIAL_REPORTS: 'financial-reports',
});

export class SensitiveStorageError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'SensitiveStorageError';
    this.code = code;
    this.status = status;
  }
}

export function canonicalBusinessId(req) {
  const businessId = req?.tenantContext?.businessId || req?.business?.id || req?.auth?.businessId || null;
  if (!BUSINESS_UUID_RE.test(String(businessId || ''))) {
    throw new SensitiveStorageError('missing_or_invalid_business_id', 400);
  }
  return String(businessId);
}

export function rejectConflictingBusinessId(req, canonicalId) {
  const supplied = [
    req?.body?.business_id,
    req?.body?.businessId,
    req?.query?.business_id,
    req?.query?.businessId,
    req?.headers?.['x-business-id'],
  ].filter((value) => value != null && String(value).trim());
  if (supplied.some((value) => String(value).trim() !== canonicalId)) {
    throw new SensitiveStorageError('business_context_mismatch', 400);
  }
}

export function assertSensitiveObject({ businessId, expectedBucket, persistedBucket, objectPath }) {
  if (!BUSINESS_UUID_RE.test(String(businessId || ''))) {
    throw new SensitiveStorageError('missing_or_invalid_business_id', 400);
  }
  if (!Object.values(SENSITIVE_BUCKETS).includes(expectedBucket)) {
    throw new SensitiveStorageError('invalid_storage_contract', 500);
  }
  if (persistedBucket && persistedBucket !== expectedBucket) {
    throw new SensitiveStorageError('invalid_storage_contract', 409);
  }
  if (typeof objectPath !== 'string' || !objectPath.startsWith(`${businessId}/`)) {
    throw new SensitiveStorageError('invalid_storage_contract', 409);
  }
  return { bucket: expectedBucket, objectPath };
}

export function isStorageObjectMissing(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  return status === 404 || /not[ -]?found|does not exist|no such object/.test(message);
}
