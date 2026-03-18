const INTENT_ALIASES = {
  airfare: "travel",
  lodging: "travel",
  car_rental: "travel",
  transportation: "vehicle_expense",
  rideshare: "vehicle_expense",
  parking: "parking_tolls",
  tolls: "parking_tolls",
  general_supplies: "materials",
  equipment: "tools",
  subscriptions: "software",
  ads: "advertising",
  leads: "advertising",
  food_supplies: "materials",
  construction_ops: "software",
  vehicle_lease: "vehicle_expense",
  medical: "office_supplies",
  training: "office_supplies",
  postage: "shipping",
};

const INTENT_KEYWORDS = {
  meals: ["meals", "meal", "meals and entertainment", "meals entertainment", "dining", "restaurant", "restaurants", "coffee"],
  fuel: ["fuel", "gas", "gasoline", "diesel"],
  materials: ["materials", "material", "supplies", "supply", "job materials", "cogs", "cost of goods", "construction", "general supplies", "supplies and materials", "hardware"],
  tools: ["tools", "tool", "equipment", "equip", "small tools", "rental", "tool rental"],
  software: ["software", "subscriptions", "saas", "cloud", "licensing"],
  advertising: ["advertising", "marketing", "ads", "ad", "promotion", "lead", "leads", "yelp", "angi", "homeadvisor", "thumbtack"],
  travel: ["travel", "airfare", "lodging", "hotel", "airline", "flight", "rental car", "uber", "lyft"],
  insurance: ["insurance"],
  rentals: ["rental", "rentals", "equipment rental"],
  bank_fees: ["bank fees", "service charge", "service fee", "bank charge", "processing fees"],
  payment_processing: ["processing", "merchant fees", "payment processing", "stripe", "square", "paypal fees"],
  payroll: ["payroll", "wages"],
  utilities: ["utilities", "telecom", "internet"],
  vehicle_expense: ["auto", "vehicle", "fleet", "transportation", "rideshare", "parking", "toll", "lease"],
  security: ["security", "alarm", "monitoring"],
  shipping: ["shipping", "postage", "delivery"],
  office_supplies: ["office supplies", "office", "stationery"],
  cleaning: ["cleaning", "janitorial"],
  parking_tolls: ["parking", "toll", "tolls"],
  interest_income: ["interest income", "interest"],
};

function normalizeCoaName(name = "") {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s = "") {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreAccount(intentKey, keywords, acct) {
  const name = acct._normName;
  if (!name) return { score: -Infinity, reason: null };
  let score = 0;
  let reason = null;
  let matchedCount = 0;

  keywords.forEach((kw) => {
    const k = kw.toLowerCase();
    if (!k) return;
    const lenBonus = k.length / 10;
    const exactRe = new RegExp(`\\b${escapeRegExp(k)}\\b`, "i");
    let matched = false;
    if (exactRe.test(name)) {
      score += 100 + lenBonus;
      reason = "keyword_exact";
      matched = true;
    } else if (name.startsWith(k)) {
      score += 60 + lenBonus;
      reason = reason || "keyword_startswith";
      matched = true;
    } else if (name.includes(k)) {
      score += 30 + lenBonus;
      reason = reason || "keyword_contains";
      matched = true;
    }
    if (matched) matchedCount += 1;
  });

  if (matchedCount > 1) {
    score += 10 * (matchedCount - 1);
  }

  // intent vs account type weighting
  const acctType = normalizeCoaName(acct.type || acct.AccountType || "");
  const expenseIntents = new Set([
    "meals",
    "fuel",
    "materials",
    "tools",
    "software",
    "advertising",
    "travel",
    "insurance",
    "rentals",
    "bank_fees",
    "payment_processing",
    "payroll",
    "utilities",
    "vehicle_expense",
    "security",
    "shipping",
    "office_supplies",
    "cleaning",
    "parking_tolls",
  ]);

  if (intentKey === "interest_income") {
    if (acctType.includes("income")) score += 20;
    if (acctType.includes("expense") || acctType.includes("cost")) score -= 50;
  } else if (expenseIntents.has(intentKey)) {
    if (acctType.includes("income")) score -= 50;
    if (acctType.includes("expense") || acctType.includes("cost of goods") || acctType.includes("cogs")) score += 10;
  }

  return { score, reason };
}

export function mapIntentToCoa({ businessId, intent, coaAccounts }) {
  void businessId; // reserved for future business-specific weighting
  if (!intent || !coaAccounts?.length) return null;
  const rawKey = intent.toLowerCase();
  const intentKey = INTENT_ALIASES[rawKey] || rawKey;
  const keywords = INTENT_KEYWORDS[intentKey];
  if (!keywords) {
    if (process.env.NODE_ENV !== "production") {
      console.info("[intentToCoaMapper] unknown_intent", { raw_intent: rawKey, resolved_intent: intentKey });
    }
    return null;
  }

  let best = null;
  let bestScore = -Infinity;

  const normalized = coaAccounts.map((a) => ({
    ...a,
    _normName: normalizeCoaName(a.name || a.Name || ""),
  }));

  for (const acct of normalized) {
    const { score, reason } = scoreAccount(intentKey, keywords, acct);
    if (score > bestScore) {
      bestScore = score;
      best = { acct, reason: reason || "scored_best" };
    }
  }

  if (!best || bestScore < 40) return null; // avoid weak accidental matches

  return {
    qbo_account_id: best.acct.id || best.acct.Id || null,
    qbo_account_name: best.acct.name || best.acct.Name || null,
    match_reason: best.reason || "scored_best",
  };
}

// Scoring logic:
// - keyword exact (word boundary): +100
// - keyword startsWith: +60
// - keyword contains: +30
// - length bonus: +len(keyword)/10
// - multi-keyword hit bonus: +10 per additional hit
// - account type weighting: expense intents penalize income accounts, reward expense/COGS; interest_income prefers income.

export default { mapIntentToCoa };
