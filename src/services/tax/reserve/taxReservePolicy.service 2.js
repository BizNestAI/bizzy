// /src/services/tax/reserve/taxReservePolicy.service.js
import { TAX_MEMORY_KEYS } from "../taxMemoryKeys.js";
import { TAX_RESERVE_STRATEGIES, TAX_RESERVE_WARNING_CODES, reserveWarning } from "./taxReserveDomain.js";

const DEFAULT_BUFFER_PERCENT = 0.1;

export function resolveTaxReservePolicy({ profile = null, memories = [], explicitPolicy = null } = {}) {
  const memoryMap = new Map((memories || []).map((memory) => [memory.memory_key || memory.key, memory.value]));
  const metadata = profile?.metadata && typeof profile.metadata === "object" ? profile.metadata : {};
  const warnings = [];
  const assumptions = [];
  const strategy = normalizeStrategy(
    explicitPolicy?.strategy ||
      metadata.reserve_strategy ||
      memoryMap.get("preferred_tax_reserve_strategy") ||
      TAX_RESERVE_STRATEGIES.HIGHER_OF_LIABILITY_OR_SAFE_HARBOR
  );

  const profileBuffer = profile?.reserve_buffer_percent;
  const memoryBuffer = memoryMap.get(TAX_MEMORY_KEYS?.PREFERRED_TAX_RESERVE_BUFFER_PERCENT || "preferred_tax_reserve_buffer_percent");
  const bufferPercent = normalizePercent(explicitPolicy?.bufferPercent ?? explicitPolicy?.buffer_percent ?? profileBuffer ?? memoryBuffer, DEFAULT_BUFFER_PERCENT);
  if (profileBuffer == null && memoryBuffer == null && explicitPolicy?.bufferPercent == null && explicitPolicy?.buffer_percent == null) {
    assumptions.push({
      code: "default_reserve_buffer_percent",
      label: "Default reserve buffer percent",
      value: bufferPercent,
      source: "system",
      confidence: "medium",
      editable: true,
    });
  }

  const liquidityFloor = normalizeMoney(explicitPolicy?.liquidityFloor ?? explicitPolicy?.liquidity_floor ?? metadata.reserve_liquidity_floor, 0);
  if (strategy === TAX_RESERVE_STRATEGIES.SAFE_HARBOR) {
    warnings.push(reserveWarning(
      TAX_RESERVE_WARNING_CODES.SAFE_HARBOR_UNAVAILABLE,
      "Safe-harbor strategy requires verified safe-harbor output; if unavailable, reserve guidance will fall back to remaining liability.",
      "low",
      "verify_tax_rule_config"
    ));
  }

  return {
    strategy,
    bufferPercent,
    liquidityFloor,
    paymentDateBehavior: explicitPolicy?.paymentDateBehavior || metadata.reserve_payment_date_behavior || "next_deadline",
    source: explicitPolicy ? "explicit" : profile?.id ? "tax_profile" : "system_default",
    assumptions,
    warnings,
  };
}

export async function getTaxReservePolicy({ profile = null, memories = [], explicitPolicy = null } = {}) {
  return resolveTaxReservePolicy({ profile, memories, explicitPolicy });
}

function normalizeStrategy(value) {
  const normalized = String(value || TAX_RESERVE_STRATEGIES.HIGHER_OF_LIABILITY_OR_SAFE_HARBOR).trim().toLowerCase();
  if (Object.values(TAX_RESERVE_STRATEGIES).includes(normalized)) return normalized;
  return TAX_RESERVE_STRATEGIES.HIGHER_OF_LIABILITY_OR_SAFE_HARBOR;
}

function normalizePercent(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n > 1 ? n / 100 : n;
}

function normalizeMoney(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100) / 100);
}
