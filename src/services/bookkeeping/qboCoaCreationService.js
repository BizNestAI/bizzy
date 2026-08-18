import { getCanonicalAccountForIntent, isApprovedEquivalentName, normalizeCanonicalName } from "./canonicalCoaRegistry.js";
import { resolveCanonicalQboAccount } from "./canonicalQboAccountResolver.js";

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
    "equipment_rental",
    "permits_fees",
    "waste_disposal",
    "uniforms_laundry",
    "safety_ppe",
    "utilities",
    "office_supplies",
    "supplies",
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

export async function createQboCoaAccountIfNeeded({ businessId, candidateName, intent, source = "suggest", createdBy = "bizzi", meta = {} }) {
  void createdBy;
  const canonical = getCanonicalAccountForIntent(intent);
  if (!canonical) {
    return { ok: false, created: false, reason: "unknown_canonical_account", message: "No approved Bizzi canonical account exists for this intent." };
  }
  const candidateNorm = normalizeCanonicalName(candidateName);
  const preferredNorm = normalizeCanonicalName(canonical.preferred_account_name);
  if (candidateNorm && candidateNorm !== preferredNorm && !isApprovedEquivalentName(canonical.canonical_account_key, candidateName)) {
    return { ok: false, created: false, reason: "candidate_not_canonical", message: "Requested account name is not an approved canonical account or equivalent." };
  }
  const resolved = await resolveCanonicalQboAccount({
    businessId,
    intent,
    transactionId: meta?.transaction_id || null,
    source,
  });
  if (!resolved?.ok || !resolved?.account?.id) {
    return {
      ok: false,
      created: false,
      reason: resolved?.reason || "canonical_resolution_failed",
      message: "Canonical account requires review before creation or mapping.",
    };
  }
  return {
    ok: true,
    created: resolved.created === true,
    account: resolved.account,
    logged: true,
    match_reason: resolved.status,
    canonical_account_key: resolved.canonical?.canonical_account_key || canonical.canonical_account_key,
  };
}

export default {
  normalizeCoaName,
  looksLikeVendorName,
  chooseAccountTypeFromIntent,
  findExistingCoaMatch,
  createQboCoaAccountIfNeeded,
};
