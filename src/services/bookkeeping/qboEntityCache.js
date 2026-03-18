import { getQBOClient } from "../../utils/qboClient.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

function normalizeName(name = "") {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTokens(name = "") {
  return normalizeName(name)
    .split(" ")
    .filter(Boolean);
}

function mapEntities(list = [], entityType = null) {
  return (list || [])
    .filter(Boolean)
    .map((ent) => {
      const displayName =
        ent.DisplayName ||
        ent.CompanyName ||
        ent.FamilyName ||
        ent.GivenName ||
        ent.Name ||
        null;
      const norm = normalizeName(displayName || "");
      return {
        id: ent.Id || ent.id || null,
        displayName,
        normalized: norm,
        tokens: toTokens(displayName || ""),
        entityType: entityType || null,
      };
    })
    .filter((e) => e.id && e.displayName);
}

async function fetchVendors(qbo) {
  if (!qbo) return [];
  try {
    const res = await new Promise((resolve, reject) => {
      qbo.findVendors({ Active: true }, (err, data) => {
        if (err) return reject(err);
        return resolve(data);
      });
    });
    const vendors = Array.isArray(res?.QueryResponse?.Vendor)
      ? res.QueryResponse.Vendor
      : [];
    return mapEntities(vendors, "vendor");
  } catch (err) {
    console.warn("[qboEntityCache] vendor fetch failed", err?.message || err);
    return [];
  }
}

async function fetchCustomers(qbo) {
  if (!qbo) return [];
  try {
    const res = await new Promise((resolve, reject) => {
      qbo.findCustomers({ Active: true }, (err, data) => {
        if (err) return reject(err);
        return resolve(data);
      });
    });
    const customers = Array.isArray(res?.QueryResponse?.Customer)
      ? res.QueryResponse.Customer
      : [];
    return mapEntities(customers, "customer");
  } catch (err) {
    console.warn("[qboEntityCache] customer fetch failed", err?.message || err);
    return [];
  }
}

function isFresh(entry) {
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

export async function getQboEntityCache(businessId) {
  const cached = cache.get(businessId);
  if (isFresh(cached)) return cached.payload;

  const qbo = await getQBOClient(businessId);
  if (!qbo) {
    const payload = { vendors: [], customers: [] };
    cache.set(businessId, { fetchedAt: Date.now(), payload });
    return payload;
  }

  const [vendors, customers] = await Promise.all([
    fetchVendors(qbo),
    fetchCustomers(qbo),
  ]);
  const payload = { vendors, customers };
  cache.set(businessId, { fetchedAt: Date.now(), payload });
  return payload;
}

export function normalizeCandidate(name = "") {
  return normalizeName(name);
}

export function tokenOverlapScore(candidateTokens = [], targetTokens = []) {
  if (!candidateTokens.length || !targetTokens.length) return 0;
  const targetSet = new Set(targetTokens);
  const intersect = candidateTokens.filter((t) => targetSet.has(t));
  const denom = Math.max(candidateTokens.length, targetTokens.length);
  return denom ? intersect.length / denom : 0;
}
