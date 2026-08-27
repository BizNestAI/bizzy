import { getQBOClient } from "../../utils/qboClient.js";
import {
  isSupportedManualQboAccountType,
  isValidManualQboAccountSubType,
  normalizeManualQboAccountType,
} from "./qboAccountTypes.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class QboManualAccountCreationError extends Error {
  constructor(error, message, status = 400, details = {}) {
    super(message || error);
    this.name = "QboManualAccountCreationError";
    this.error = error;
    this.status = status;
    this.details = details;
  }
}

export function normalizeQboAccountName(name = "") {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeAccountName(name = "") {
  return String(name || "").replace(/\s+/g, " ").trim();
}

function shapeQboAccount(account = {}, fallback = {}) {
  const id = account.Id || account.id || null;
  return {
    id: id ? String(id) : null,
    name: account.Name || account.name || fallback.name || null,
    type: account.AccountType || account.type || fallback.accountType || null,
    subType: account.AccountSubType || account.subType || fallback.accountSubType || null,
    active: account.Active !== false && account.active !== false,
  };
}

function unwrapCreateResponse(data, fallback) {
  return shapeQboAccount(data?.Account || data?.account || data || {}, fallback);
}

function unwrapQueryAccounts(data) {
  const rows = data?.QueryResponse?.Account || data?.QueryResponse?.account || [];
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.map((account) => shapeQboAccount(account)).filter((account) => account.id && account.name);
}

async function findAccountsByActive(qbo, active) {
  if (!qbo || typeof qbo.findAccounts !== "function") return [];
  const data = await new Promise((resolve, reject) => {
    qbo.findAccounts({ Active: active }, (err, res) => {
      if (err) return reject(err);
      return resolve(res);
    });
  });
  return unwrapQueryAccounts(data);
}

function mapQboConnectionError(err) {
  const code = err?.message || err?.code || "";
  if (
    [
      "quickbooks_not_connected",
      "quickbooks_needs_reconnect",
      "quickbooks_missing_realm_id",
      "qbo_client_unavailable",
      "qbo_client_unavailable:no_active_token_row",
    ].includes(code)
  ) {
    return new QboManualAccountCreationError(
      "quickbooks_reconnect_required",
      "QuickBooks needs to be reconnected before creating an account.",
      409
    );
  }
  return err;
}

function mapQboProviderError(err) {
  const providerMessage = String(err?.Fault?.Error?.[0]?.Message || err?.message || "");
  if (/duplicate|already exists|name.*exist/i.test(providerMessage)) {
    return new QboManualAccountCreationError(
      "qbo_account_already_exists",
      "This account already exists in QuickBooks.",
      409
    );
  }
  return new QboManualAccountCreationError(
    "qbo_account_create_failed",
    "QuickBooks could not create this account. Please try again.",
    502
  );
}

export async function createManualQboAccountForBusiness({
  businessId,
  name,
  accountType,
  accountSubType,
  description = "",
  actor = "user",
  deps = {},
} = {}) {
  void actor;
  if (!businessId || !UUID_RE.test(String(businessId))) {
    throw new QboManualAccountCreationError("missing_business_id", "Business id is required.", 400);
  }

  const cleanName = sanitizeAccountName(name);
  if (!cleanName || cleanName.length > 100) {
    throw new QboManualAccountCreationError("invalid_qbo_account_name", "Enter an account name up to 100 characters.", 400);
  }

  const normalizedType = normalizeManualQboAccountType(accountType);
  if (!normalizedType || !isSupportedManualQboAccountType(normalizedType)) {
    throw new QboManualAccountCreationError(
      "invalid_qbo_account_type",
      "This QuickBooks account type is not available for transaction categorization.",
      400
    );
  }

  const cleanSubType = String(accountSubType || "").trim();
  if (!isValidManualQboAccountSubType(normalizedType, cleanSubType)) {
    throw new QboManualAccountCreationError(
      "invalid_qbo_account_type_detail_type",
      "This QuickBooks account type and detail type cannot be used together.",
      400
    );
  }

  let qbo;
  try {
    qbo = await (deps.getQBOClient || getQBOClient)(businessId);
  } catch (err) {
    throw mapQboConnectionError(err);
  }
  if (!qbo) throw mapQboConnectionError(new Error("qbo_client_unavailable"));

  const targetName = normalizeQboAccountName(cleanName);
  let activeAccounts = [];
  let inactiveAccounts = [];
  try {
    activeAccounts = deps.findAccountsByActive
      ? await deps.findAccountsByActive(qbo, true)
      : await findAccountsByActive(qbo, true);
    inactiveAccounts = deps.findAccountsByActive
      ? await deps.findAccountsByActive(qbo, false)
      : await findAccountsByActive(qbo, false);
  } catch (err) {
    throw mapQboProviderError(err);
  }

  const activeDuplicate = activeAccounts.find((account) => normalizeQboAccountName(account.name) === targetName);
  if (activeDuplicate) {
    throw new QboManualAccountCreationError("qbo_account_already_exists", "This account already exists in QuickBooks.", 409, {
      existing_account: activeDuplicate,
    });
  }

  const inactiveDuplicate = inactiveAccounts.find((account) => normalizeQboAccountName(account.name) === targetName);
  if (inactiveDuplicate) {
    throw new QboManualAccountCreationError(
      "qbo_inactive_account_exists",
      "An inactive QuickBooks account with this name already exists.",
      409,
      { existing_account: inactiveDuplicate }
    );
  }

  const payload = {
    Name: cleanName,
    AccountType: normalizedType,
    AccountSubType: cleanSubType,
  };
  const cleanDescription = sanitizeAccountName(description);
  if (cleanDescription) payload.Description = cleanDescription;

  const createFn = qbo.account && typeof qbo.account.create === "function" ? qbo.account.create : qbo.createAccount;
  if (!createFn) {
    throw new QboManualAccountCreationError("qbo_create_not_supported", "QuickBooks could not create this account. Please try again.", 502);
  }

  try {
    const data = await new Promise((resolve, reject) => {
      createFn.call(qbo, payload, (err, res) => {
        if (err) return reject(err);
        return resolve(res);
      });
    });
    const account = unwrapCreateResponse(data, {
      name: cleanName,
      accountType: normalizedType,
      accountSubType: cleanSubType,
    });
    if (!account.id) {
      throw new QboManualAccountCreationError("qbo_create_missing_id", "QuickBooks could not create this account. Please try again.", 502);
    }
    return { ok: true, account, created: true };
  } catch (err) {
    if (err instanceof QboManualAccountCreationError) throw err;
    throw mapQboProviderError(err);
  }
}

export function qboManualAccountCreationErrorResponse(err) {
  const status = err instanceof QboManualAccountCreationError ? err.status : err?.status || 500;
  return {
    status,
    body: {
      ok: false,
      error: err instanceof QboManualAccountCreationError ? err.error : err?.code || "qbo_account_create_failed",
      message: err?.message || "QuickBooks could not create this account. Please try again.",
      ...(err?.details?.existing_account ? { existing_account: err.details.existing_account } : {}),
    },
  };
}

export default {
  QboManualAccountCreationError,
  createManualQboAccountForBusiness,
  normalizeQboAccountName,
  qboManualAccountCreationErrorResponse,
};
