// File: /services/scenarioService.js
import { supabase } from '../supabaseAdmin.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Save a scenario and its items.
 * If a scenario with the same name exists for the user+business, a new
 * scenario row is still created (immutable history). Use updateScenario()
 * if you want to overwrite in place.
 */
export async function saveScenarioToSupabase(payload) {
  const { user_id, business_id, scenario_name, scenario_items } = payload || {};

  if (!user_id || !business_id || !scenario_name || !Array.isArray(scenario_items) || scenario_items.length === 0) {
    return { success: false, error: 'Missing required scenario data' };
  }

  const scenario_id = uuidv4();
  const now = new Date().toISOString();

  // 1) Insert scenario shell
  const { error: insertScenarioError } = await supabase.from('scenarios').insert({
    id: scenario_id,
    user_id,
    business_id,
    scenario_name,
    created_at: now,
    updated_at: now,
  });

  if (insertScenarioError) {
    return { success: false, error: insertScenarioError.message };
  }

  // 2) Insert items (sanitize + attach scenario_id)
  const items = scenario_items
    .filter(Boolean)
    .map((it, idx) => ({
      id: it.id || uuidv4(),
      scenario_id,
      type: String(it.type || 'expense').toLowerCase(),
      amount: toNum(it.amount),
      start_month: toYm(it.start_month),
      end_month: it.end_month ? toYm(it.end_month) : null,
      recurring: it.type === 'one_time' ? false : (it.recurring !== false),
      description: it.description || '',
      sort_order: idx,
      created_at: now,
      updated_at: now,
    }))
    .filter((it) => it.start_month); // drop invalid

  if (items.length === 0) {
    // Compensate: delete the empty scenario row
    await supabase.from('scenarios').delete().eq('id', scenario_id);
    return { success: false, error: 'Scenario has no valid items' };
  }

  const { error: insertItemsError } = await supabase.from('scenario_items').insert(items);

  if (insertItemsError) {
    // Best-effort rollback of the scenario shell to avoid orphans
    await supabase.from('scenarios').delete().eq('id', scenario_id);
    return { success: false, error: insertItemsError.message };
  }

  return { success: true, scenarioId: scenario_id };
}

/**
 * Overwrite an existing scenario: updates name and replaces all items.
 */
export async function updateScenario({ scenario_id, user_id, business_id, scenario_name, scenario_items }) {
  if (!scenario_id || !user_id || !business_id || !Array.isArray(scenario_items)) {
    return { success: false, error: 'Missing required scenario data' };
  }
  const now = new Date().toISOString();

  // 1) Update scenario row
  const { error: upErr } = await supabase
    .from('scenarios')
    .update({ scenario_name, updated_at: now })
    .eq('id', scenario_id)
    .eq('user_id', user_id)
    .eq('business_id', business_id);

  if (upErr) return { success: false, error: upErr.message };

  // 2) Replace items atomically (best-effort)
  const del = await supabase.from('scenario_items').delete().eq('scenario_id', scenario_id);
  if (del.error) return { success: false, error: del.error.message };

  const items = scenario_items
    .filter(Boolean)
    .map((it, idx) => ({
      id: it.id || uuidv4(),
      scenario_id,
      type: String(it.type || 'expense').toLowerCase(),
      amount: toNum(it.amount),
      start_month: toYm(it.start_month),
      end_month: it.end_month ? toYm(it.end_month) : null,
      recurring: it.type === 'one_time' ? false : (it.recurring !== false),
      description: it.description || '',
      sort_order: idx,
      created_at: now,
      updated_at: now,
    }))
    .filter((it) => it.start_month);

  if (items.length === 0) return { success: false, error: 'Scenario has no valid items' };

  const ins = await supabase.from('scenario_items').insert(items);
  if (ins.error) return { success: false, error: ins.error.message };

  return { success: true, scenarioId: scenario_id };
}

/**
 * Load list of saved scenarios for the current user/business.
 */
export async function loadUserScenarios(user_id, business_id) {
  const { data, error } = await supabase
    .from('scenarios')
    .select('id, scenario_name, created_at, updated_at')
    .eq('user_id', user_id)
    .eq('business_id', business_id)
    .order('updated_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, scenarios: data || [] };
}

/**
 * Load scenario items for a given scenario ID.
 */
export async function loadScenarioItems(scenario_id) {
  const { data, error } = await supabase
    .from('scenario_items')
    .select('*')
    .eq('scenario_id', scenario_id)
    .order('sort_order', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, items: data || [] };
}

/**
 * Convenience: load scenario + items together.
 */
export async function loadScenarioWithItems(scenario_id) {
  const head = await supabase.from('scenarios').select('*').eq('id', scenario_id).single();
  if (head.error) return { success: false, error: head.error.message };
  const items = await loadScenarioItems(scenario_id);
  if (!items.success) return items;
  return { success: true, scenario: head.data, items: items.items };
}

/**
 * Delete a scenario and its items.
 */
export async function deleteScenario(scenario_id, user_id) {
  if (!scenario_id || !user_id) return { success: false, error: 'Missing id' };
  const delItems = await supabase.from('scenario_items').delete().eq('scenario_id', scenario_id);
  if (delItems.error) return { success: false, error: delItems.error.message };
  const delHead = await supabase.from('scenarios').delete().eq('id', scenario_id).eq('user_id', user_id);
  if (delHead.error) return { success: false, error: delHead.error.message };
  return { success: true };
}

/* --------------------- helpers --------------------- */

function toNum(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function toYm(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (String(d) === 'Invalid Date') return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
