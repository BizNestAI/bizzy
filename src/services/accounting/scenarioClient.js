import { safeFetch } from "../../utils/safeFetch.js";

export async function saveScenarioToSupabase(payload) {
  try {
    const response = await safeFetch("/api/accounting/scenarios/save", {
      method: "POST",
      body: payload,
    });
    return { success: true, scenarioId: response?.scenarioId };
  } catch (err) {
    return { success: false, error: err?.message || "Failed to save scenario" };
  }
}

export async function loadUserScenarios(userId, businessId) {
  try {
    const params = new URLSearchParams({ userId, businessId });
    const response = await safeFetch(`/api/accounting/scenarios/list?${params.toString()}`);
    return { success: true, scenarios: response?.scenarios || [] };
  } catch (err) {
    return { success: false, error: err?.message || "Failed to load scenarios" };
  }
}

export async function loadScenarioItems(scenarioId) {
  try {
    const response = await safeFetch(`/api/accounting/scenarios/${encodeURIComponent(scenarioId)}`);
    return { success: true, items: response?.items || [] };
  } catch (err) {
    return { success: false, error: err?.message || "Failed to load scenario" };
  }
}
