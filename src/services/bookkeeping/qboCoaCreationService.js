import { supabase } from "../supabaseAdmin.js";
import { getQBOClient } from "../../utils/qboClient.js";
import { fetchChartOfAccounts } from "./qboAccounts.js";

const devLog = (tag, payload) => {
  if (process.env.NODE_ENV !== "production") {
    console.info("[qboCoaCreate]", tag, payload);
  }
};

export function normalizeCoaName(name = "") {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeVendorName(name = "") {
  const n = normalizeCoaName(name);
  if (!n) return true;
  const riskyTokens = ["uber", "lyft", "doordash", "starbucks", "mcdonald", "walgreens", "walmart", "target", "pos", "store"];
  if (riskyTokens.some((t) => n.includes(t))) return true;
  if (/\d/.test(n) && /(st|ave|rd|road|hwy|suite|store)/.test(n)) return true;
  return false;
}

export function chooseAccountTypeFromIntent(intent) {
  if (!intent) return null;
  const key = intent.toLowerCase();
  const cogsIntents = new Set([
    "subcontractor_costs",
    "subcontractors",
    "labor_direct",
    "materials_direct",
    "cogs",
    "cost_of_goods",
  ]);
  const expenseIntents = new Set([
    "materials",
    "tools",
    "software",
    "advertising",
    "fuel",
    "meals",
    "insurance",
    "rentals",
    "utilities",
    "office_supplies",
    "cleaning",
    "parking_tolls",
    "shipping",
    "payment_processing",
    "bank_fees",
    "interest_expense",
    "travel",
    "airfare",
    "lodging",
    "transportation",
    "rideshare",
    "general_supplies",
    "subscriptions",
    "construction_ops",
  ]);
  if (cogsIntents.has(key)) return { accountType: "Cost of Goods Sold", confidence: "high" };
  if (expenseIntents.has(key)) return { accountType: "Expense", confidence: "medium" };
  if (key === "interest_income") return { accountType: "Income", confidence: "medium" };
  return null;
}

export function findExistingCoaMatch(coaAccounts = [], candidateName = "") {
  const normCand = normalizeCoaName(candidateName);
  if (!normCand) return null;
  const candTokens = normCand.split(" ").filter(Boolean);
  let best = { score: 0, data: null };

  coaAccounts.forEach((acct) => {
    const norm = normalizeCoaName(acct.name || acct.Name || "");
    if (!norm) return;
    const acctTokens = norm.split(" ").filter(Boolean);
    let score = 0;
    let match_reason = null;

    if (norm === normCand) {
      score = 100;
      match_reason = "exact";
    } else if (norm.includes(normCand) || normCand.includes(norm)) {
      score = 80;
      match_reason = "contains";
    } else {
      const common = candTokens.filter((t) => acctTokens.includes(t));
      const overlap =
        common.length && Math.max(candTokens.length, acctTokens.length)
          ? (common.length / Math.max(candTokens.length, acctTokens.length)) * 60
          : 0;
      if (overlap > 0) {
        score = overlap;
        match_reason = "token_overlap";
      }
    }

    if (score > best.score) {
      best = {
        score,
        data: {
          id: acct.id || acct.Id,
          name: acct.name || acct.Name,
          type: acct.type || acct.AccountType,
          match_reason,
          match_score: score,
        },
      };
    }
  });

  if (best.score >= 70 && best.data) return best.data;
  return null;
}

function isNameClean(name) {
  if (!name || name.length < 3 || name.length > 50) return false;
  if (!/^[a-z0-9\s&-]+$/i.test(name)) return false;
  const normalized = normalizeCoaName(name);
  if ((normalized.match(/\d/g) || []).length >= Math.max(2, normalized.length * 0.4)) return false;
  const badTokens = ["trip", "#", "store", "pos", "debit", "credit", "payment", "invoice", "order", "ach", "sq *"];
  if (badTokens.some((t) => normalized.includes(normalizeCoaName(t)))) return false;
  if (looksLikeVendorName(name)) return false;
  return true;
}

async function logCreation({ businessId, account, accountType, createdBy = "bizzi", source = "suggest", meta = {} }) {
  try {
    await supabase.from("qbo_coa_creations").upsert(
      {
        business_id: businessId,
        qbo_account_id: account?.id || account?.Id,
        qbo_account_name: account?.name || account?.Name,
        account_type: accountType,
        created_by: createdBy || "bizzi",
        source: source || "suggest",
        meta,
      },
      { onConflict: "business_id,qbo_account_id" }
    );
    return true;
  } catch (err) {
    devLog("log_failed", { message: err?.message });
    return false;
  }
}

async function createQboAccount(businessId, payload) {
  const qbo = await getQBOClient(businessId);
  if (!qbo) throw new Error("qbo_client_unavailable");
  const fn = qbo.account && typeof qbo.account.create === "function" ? qbo.account.create : qbo.createAccount;
  if (!fn) throw new Error("qbo_create_not_supported");
  const attemptCreate = (body) =>
    new Promise((resolve, reject) => {
      fn.call(qbo, body, (err, data) => {
        if (err) return reject(err);
        const acct = data?.Account || data?.account || data || null;
        if (!acct?.Id && !acct?.id) return reject(new Error("qbo_create_missing_id"));
        resolve({
          id: acct.Id || acct.id,
          name: acct.Name || body.Name,
          type: acct.AccountType || body.AccountType,
        });
      });
    });

  try {
    return await attemptCreate(payload);
  } catch (err) {
    if ((payload?.AccountType || payload?.accountType) === "Cost of Goods Sold") {
      const retryPayload = { ...payload, AccountType: "CostOfGoodsSold" };
      devLog("retry_cogs_alias", {});
      return await attemptCreate(retryPayload);
    }
    throw err;
  }
}

export async function createQboCoaAccountIfNeeded({ businessId, candidateName, intent, source = "suggest", createdBy = "bizzi", meta = {} }) {
  const coa = await fetchChartOfAccounts(businessId, { includeSubaccounts: true });
  const existing = findExistingCoaMatch(coa, candidateName);
  if (existing) {
    devLog("duplicate_block", { candidateName, existing: existing.name, reason: existing.match_reason });
    return { ok: true, created: false, account: existing, match_reason: existing.match_reason };
  }

  if (!isNameClean(candidateName)) {
    devLog("name_rejected", { candidateName });
    return { ok: false, created: false, reason: "unclean_name", message: "Account name looks too specific (vendor-like)." };
  }

  const typeChoice = chooseAccountTypeFromIntent(intent);
  if (!typeChoice) {
    devLog("type_uncertain", { intent });
    return { ok: false, created: false, reason: "uncertain_type", message: "Bizzi isn't confident what account type this should be." };
  }

  const payload = {
    Name: candidateName.trim(),
    AccountType: typeChoice.accountType,
  };

  let createdAccount = null;
  try {
    createdAccount = await createQboAccount(businessId, payload);
  } catch (err) {
    devLog("create_failed", { message: err?.message, payload });
    return {
      ok: false,
      created: false,
      reason: err?.message || "qbo_create_failed",
      message: "QuickBooks rejected the account creation request.",
    };
  }

  const logged = await logCreation({
    businessId,
    account: createdAccount,
    accountType: createdAccount?.type || typeChoice.accountType,
    createdBy,
    source,
    meta: {
      ...meta,
      reason: meta?.reason || null,
      intent,
    },
  });

  return {
    ok: true,
    created: true,
    account: createdAccount,
    logged,
  };
}

export default {
  normalizeCoaName,
  looksLikeVendorName,
  chooseAccountTypeFromIntent,
  findExistingCoaMatch,
  createQboCoaAccountIfNeeded,
};
