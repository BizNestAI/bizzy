import { supabase } from "../supabaseAdmin.js";

function normalizeTokens(str = "") {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function bigramSimilarity(a = "", b = "") {
  const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const makeBigrams = (s) => {
    const grams = new Set();
    for (let i = 0; i < s.length - 1; i += 1) {
      grams.add(s.slice(i, i + 2));
    }
    return grams;
  };
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const ga = makeBigrams(na);
  const gb = makeBigrams(nb);
  const intersection = Array.from(ga).filter((g) => gb.has(g)).length;
  const denom = Math.max(ga.size, gb.size, 1);
  return intersection / denom;
}

export async function getQboAccountForPlaidAccount(businessId, plaidAccountId) {
  if (!businessId || !plaidAccountId) return null;
  const { data, error } = await supabase
    .from("plaid_qbo_account_mappings")
    .select("qbo_account_id,qbo_account_name,qbo_account_type")
    .eq("business_id", businessId)
    .eq("plaid_account_id", plaidAccountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    qbo_account_id: data.qbo_account_id,
    qbo_account_name: data.qbo_account_name,
    qbo_account_type: data.qbo_account_type,
  };
}

export function suggestQboAccountForPlaidAccount(plaidAccount = {}, qboAccounts = []) {
  if (!plaidAccount || !Array.isArray(qboAccounts) || qboAccounts.length === 0) return null;
  const last4 = (plaidAccount.mask || "").slice(-4);
  const plaidNames = [plaidAccount.name, plaidAccount.official_name].filter(Boolean);
  const plaidTokens = new Set(plaidNames.flatMap((n) => normalizeTokens(n)));

  const scored = (qboAccounts || []).map((acct) => {
    const name = acct?.name || "";
    const normName = name.toLowerCase();
    const tokens = normalizeTokens(name);
    const overlap = tokens.filter((t) => plaidTokens.has(t)).length;
    const similarity = bigramSimilarity(plaidNames.join(" "), name);

    if (last4 && normName.includes(last4)) {
      return { acct, confidence: "high", score: 100 };
    }
    if (overlap > 0) {
      return { acct, confidence: "medium", score: 50 + overlap };
    }
    if (similarity >= 0.35) {
      return { acct, confidence: "low", score: 10 + similarity };
    }
    return { acct, confidence: null, score: 0 };
  });

  const best = scored
    .filter((c) => c.confidence)
    .sort((a, b) => {
      const rank = { high: 3, medium: 2, low: 1 };
      if (rank[b.confidence] !== rank[a.confidence]) {
        return rank[b.confidence] - rank[a.confidence];
      }
      return b.score - a.score;
    })[0];

  if (!best) return null;
  return {
    qbo_account_id: best.acct?.id || null,
    qbo_account_name: best.acct?.name || null,
    qbo_account_type: best.acct?.type || null,
    confidence: best.confidence,
  };
}

export default {
  getQboAccountForPlaidAccount,
  suggestQboAccountForPlaidAccount,
};
