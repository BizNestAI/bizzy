const INTENT_ALIASES = {
  lodging: "travel",
  car_rental: "travel",
  parking: "parking_tolls",
  parking_toll: "parking_tolls",
  tolls: "parking_tolls",
  general_supplies: "supplies",
  equipment: "tools",
  subscriptions: "software",
  subscription: "software",
  streaming: "software",
  productivity: "software",
  software_subscription: "software",
  apparel: "clothing",
  ads: "advertising",
  leads: "advertising",
  food_supplies: "materials",
  construction_ops: "software",
  rentals: "equipment_rental",
  vehicle_lease: "vehicle_expense",
  medical: "office_supplies",
  training: "office_supplies",
  postage: "shipping",
  wifi: "internet_services",
  internet: "internet_services",
  telecom: "internet_services",
  utilities_internet: "internet_services",
  electricity: "electric",
  electric_utility: "electric",
  ev_charging: "gas_charging",
  vehicle_charging: "gas_charging",
  business_license: "business_licensing_fees",
  business_licensing: "business_licensing_fees",
  licensing_fees: "business_licensing_fees",
  permits: "business_licensing_fees",
  permit_fees: "business_licensing_fees",
  quickbooks_revenue: "sales",
  invoice_revenue: "sales",
  cashback: "other_income",
  cash_back: "other_income",
  rewards: "other_income",
  credit_card_rewards: "credit_card_rewards",
  bank_deposit_receipt: "sales",
};

export function resolveIntentKey(intent = "") {
  const rawKey = String(intent || "").toLowerCase();
  return INTENT_ALIASES[rawKey] || rawKey;
}

const INTENT_KEYWORDS = {
  airfare: ["airfare", "airline", "airlines", "flight", "flights"],
  transportation: ["transportation", "rideshare", "uber", "lyft", "taxi", "cab", "scooter", "bike share", "lime"],
  meals: ["meals", "meal", "meals and entertainment", "meals entertainment", "dining", "restaurant", "restaurants", "fast food", "convenience store", "coffee", "grocery", "bakery", "smoothie", "grill", "mcdonald", "chick fil a", "chipotle", "cava", "panera", "publix", "whole foods", "lowes foods", "doordash", "uber eats", "crumbl", "short stop", "micro mart", "poppycox", "bonefish"],
  fuel: ["fuel", "gas", "gasoline", "diesel", "gas station", "fuel station", "quiktrip", "quicktrip", "speedway", "sppedway", "circle k", "wawa", "spinx", "sheetz"],
  gas_charging: ["gas charging", "gas and charging", "fuel charging", "charging", "ev charging", "supercharger", "chargeonsite", "vehicle charging"],
  supplies: ["supplies", "supply", "general supplies"],
  materials: ["materials", "material", "job materials", "cogs", "cost of goods", "construction", "supplies and materials", "supplies materials", "hardware", "amazon"],
  tools: ["tools", "tool", "equipment", "equip", "small tools", "tool rental"],
  software: ["software", "subscriptions", "subscription", "saas", "cloud", "streaming", "productivity", "workspace", "atlassian", "apple", "adobe", "openai", "chatgpt", "youtube tv", "youtubetv", "paramount", "zoom", "figma", "instantly", "spotify", "railway", "canva", "supabase"],
  entertainment: ["entertainment", "tickets", "ticket", "movies", "movie", "cinema", "event", "events", "concert", "golf", "arcade", "theater", "theatre", "amc", "prime video", "playstation", "ticketmaster", "fandango", "gametime"],
  clothing: ["clothing", "apparel", "uniforms", "clothes", "wardrobe", "nordstrom", "dillards", "dillard"],
  advertising: ["advertising", "marketing", "ads", "ad", "promotion", "lead", "leads", "yelp", "angi", "homeadvisor", "thumbtack"],
  travel: ["travel", "airfare", "lodging", "hotel", "airline", "flight", "rental car", "uber", "lyft"],
  insurance: ["insurance"],
  equipment_rental: ["equipment rental", "equipment rentals", "rental", "rentals", "tool rental", "truck rental", "jobsite rental"],
  subcontractors: ["subcontractors", "subcontractor", "contract labor", "outside labor"],
  permits_fees: ["permits", "permit", "permit fees", "licenses", "license", "licensing", "inspection fees", "municipal fees"],
  business_licensing_fees: ["business licensing fees", "business licensing", "license fees", "licensing fees", "filing fees", "filings", "secretary of state", "state filing", "registration fees"],
  waste_disposal: ["waste disposal", "dump fees", "dump fee", "landfill", "disposal", "hauling", "trash", "debris removal"],
  uniforms_laundry: ["uniforms", "uniform", "laundry", "workwear", "work clothes"],
  safety_ppe: ["safety", "ppe", "personal protective equipment", "gloves", "hard hats", "respirators"],
  bank_fees: ["bank fees", "bank charges", "bank charges and fees", "service charge", "service fee", "bank charge", "processing fees", "transaction fee", "tran fee", "late fee", "finance charge", "cc fees", "credit card fees", "fees"],
  payment_processing: ["processing", "merchant fees", "payment processing", "stripe", "square", "paypal fees"],
  payroll: ["payroll", "wages"],
  utilities: ["utilities", "telecom", "internet"],
  internet_services: ["wifi", "wi fi", "internet", "internet services", "broadband", "fiber", "telecom"],
  electric: ["electric", "electricity", "electric utility", "power", "energy"],
  vehicle_expense: ["auto", "vehicle", "fleet", "vehicle expense", "vehicle maintenance", "auto repair", "repair", "maintenance", "oil change", "tires", "tire"],
  security: ["security", "alarm", "monitoring"],
  shipping: ["shipping", "postage", "delivery"],
  office_supplies: ["office supplies", "office", "stationery"],
  cleaning: ["cleaning", "janitorial"],
  parking_tolls: ["parking", "park", "lot", "parking lot", "surface lot", "parkmobile", "park mobile", "parking meter", "parking pay", "cdot pay", "toll", "tolls"],
  interest_income: ["interest income", "interest"],
  sales: ["sales", "sales income", "revenue", "income", "service income"],
  other_income: ["other income", "cash back", "cashback", "statement credit", "automatic statement credit", "rewards", "reward income", "credit card rewards"],
  credit_card_rewards: ["credit card rewards", "card rewards", "cash back", "cashback", "reward redemption", "statement credit", "rewards credit"],
};

const RELATED_INTENT_KEYS = {
  airfare: ["travel"],
  transportation: ["vehicle_expense", "travel", "parking_tolls"],
  travel: ["vehicle_expense", "parking_tolls"],
  vehicle_expense: ["travel", "fuel", "parking_tolls"],
  gas_charging: ["fuel", "vehicle_expense"],
  parking_tolls: ["transportation", "vehicle_expense", "travel"],
  materials: ["tools"],
  supplies: ["office_supplies", "materials"],
  tools: ["materials"],
  equipment_rental: ["tools", "materials"],
  permits_fees: ["business_licensing_fees", "office_supplies"],
  business_licensing_fees: ["permits_fees"],
  waste_disposal: ["materials"],
  uniforms_laundry: ["supplies", "office_supplies"],
  safety_ppe: ["supplies", "tools"],
  meals: ["travel"],
  fuel: ["vehicle_expense", "travel"],
  office_supplies: ["materials"],
  software: ["office_supplies"],
  clothing: ["uniforms_laundry", "supplies"],
  other_income: ["interest_income"],
  credit_card_rewards: ["other_income"],
  utilities: ["internet_services", "electric"],
  internet_services: ["utilities"],
  electric: ["utilities"],
  shipping: ["materials"],
};

const STRICT_PRIMARY_ONLY_INTENTS = new Set([
  "airfare",
  "transportation",
  "supplies",
  "materials",
  "equipment_rental",
  "subcontractors",
  "permits_fees",
  "business_licensing_fees",
  "waste_disposal",
  "uniforms_laundry",
  "safety_ppe",
  "gas_charging",
  "fuel",
  "meals",
  "parking_tolls",
  "software",
  "entertainment",
  "clothing",
  "other_income",
  "credit_card_rewards",
  "internet_services",
  "electric",
]);

const CANONICAL_ONLY_INTENTS = new Set([
  "transportation",
  "parking_tolls",
]);

function normalizeCoaName(name = "") {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exactCanonicalAccountForIntent(intentKey, accounts = []) {
  if (intentKey === "transportation") {
    return accounts.find((acct) => acct._normName === "transportation") || null;
  }
  if (intentKey === "parking_tolls") {
    return accounts.find((acct) =>
      ["parking and tolls", "parking tolls", "parking"].includes(acct._normName)
    ) || null;
  }
  if (intentKey === "credit_card_rewards") {
    return accounts.find((acct) =>
      ["credit card rewards", "card rewards", "cash back rewards", "cashback rewards", "rewards income"].includes(acct._normName)
    ) || null;
  }
  return null;
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

  if (name === intentKey.replace(/_/g, " ")) {
    score += 100;
    reason = "intent_exact_account";
  }

  keywords.forEach((kw) => {
    const k = kw.toLowerCase();
    if (!k) return;
    const lenBonus = k.length / 10;
    const exactRe = new RegExp(`\\b${escapeRegExp(k)}\\b`, "i");
    let matched = false;
    if (name === k) {
      score += 150 + lenBonus;
      reason = "keyword_exact_account";
      matched = true;
    } else if (exactRe.test(name)) {
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
  const cogsIntents = new Set([
    "subcontractors",
  ]);
  const expenseIntents = new Set([
    "airfare",
    "transportation",
    "meals",
    "fuel",
    "gas_charging",
    "supplies",
    "materials",
    "tools",
    "software",
    "entertainment",
    "clothing",
    "advertising",
    "travel",
    "insurance",
    "equipment_rental",
    "permits_fees",
    "business_licensing_fees",
    "waste_disposal",
    "uniforms_laundry",
    "safety_ppe",
    "bank_fees",
    "payment_processing",
    "payroll",
    "utilities",
    "internet_services",
    "electric",
    "vehicle_expense",
    "security",
    "shipping",
    "office_supplies",
    "cleaning",
    "parking_tolls",
  ]);

  if (cogsIntents.has(intentKey)) {
    if (acctType.includes("cost of goods") || acctType.includes("cogs")) score += 20;
    if (acctType.includes("income")) score -= 50;
  } else if (intentKey === "interest_income" || intentKey === "sales" || intentKey === "other_income" || intentKey === "credit_card_rewards") {
    if (acctType.includes("income")) score += 20;
    if (acctType.includes("expense") || acctType.includes("cost")) score -= 50;
  } else if (expenseIntents.has(intentKey)) {
    if (acctType.includes("income")) score -= 50;
    if (acctType.includes("expense") || acctType.includes("cost of goods") || acctType.includes("cogs")) score += 10;
  }

  return { score, reason };
}

function buildIntentCandidates(intentKey, { allowRelatedForStrict = false } = {}) {
  const candidates = [{ key: intentKey, penalty: 0, source: "primary" }];
  if (STRICT_PRIMARY_ONLY_INTENTS.has(intentKey) && allowRelatedForStrict !== true) return candidates;
  const related = RELATED_INTENT_KEYS[intentKey] || [];
  related.forEach((key, index) => {
    if (!INTENT_KEYWORDS[key]) return;
    candidates.push({
      key,
      penalty: 18 + index * 4,
      source: "related",
    });
  });
  return candidates;
}

export function mapIntentToCoa({ businessId, intent, coaAccounts, allowSemanticFallbackForCanonicalOnly = false }) {
  void businessId; // reserved for future business-specific weighting
  if (!intent || !coaAccounts?.length) return null;
  const rawKey = intent.toLowerCase();
  const intentKey = resolveIntentKey(rawKey);
  if (!INTENT_KEYWORDS[intentKey]) {
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

  const exactCanonical = exactCanonicalAccountForIntent(intentKey, normalized);
  if (exactCanonical) {
    return {
      qbo_account_id: exactCanonical.id || exactCanonical.Id || null,
      qbo_account_name: exactCanonical.name || exactCanonical.Name || null,
      matched_intent: intentKey,
      match_source: "primary",
      score: 250,
      match_reason: "canonical_exact_account",
    };
  }

  if (CANONICAL_ONLY_INTENTS.has(intentKey) && allowSemanticFallbackForCanonicalOnly !== true) return null;

  for (const acct of normalized) {
    for (const candidate of buildIntentCandidates(intentKey, {
      allowRelatedForStrict: allowSemanticFallbackForCanonicalOnly === true,
    })) {
      const keywords = INTENT_KEYWORDS[candidate.key];
      if (!keywords?.length) continue;
      const { score, reason } = scoreAccount(candidate.key, keywords, acct);
      const adjustedScore = score - candidate.penalty;
      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        best = {
          acct,
          reason: reason || "scored_best",
          matched_intent: candidate.key,
          match_source: candidate.source,
        };
      }
    }
  }

  if (!best || bestScore < 32) return null; // avoid weak accidental matches

  return {
    qbo_account_id: best.acct.id || best.acct.Id || null,
    qbo_account_name: best.acct.name || best.acct.Name || null,
    matched_intent: best.matched_intent,
    match_source: best.match_source,
    score: bestScore,
    match_reason:
      best.match_source === "related"
        ? `${best.reason || "scored_best"}:${best.matched_intent}`
        : best.reason || "scored_best",
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
