import { supabase } from '../../services/supabaseAdmin.js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function resolveTableName(table) {
  if (!table) throw new Error('Table reference is required');
  if (typeof table === 'string') return table;
  if (typeof table === 'object') {
    if (typeof table.table === 'string') return table.table;
    if (typeof table.name === 'string') return table.name;
    if (typeof table.tableName === 'string') return table.tableName;
  }
  const fallback = String(table);
  if (!fallback || fallback === '[object Object]') {
    throw new Error(`Invalid table reference: ${JSON.stringify(table)}`);
  }
  return fallback;
}

// Convenience wrappers – swap to your own query layer if needed
export const db = {
  async insert(table, payload) {
    const tbl = resolveTableName(table);
    const { data, error } = await supabase.from(tbl).insert(payload).select().single();
    if (error) throw error;
    return data;
  },
  async update(table, id, patch) {
    const tbl = resolveTableName(table);
    const { data, error } = await supabase.from(tbl).update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },
  async delete(table, id) {
    const tbl = resolveTableName(table);
    const { error } = await supabase.from(tbl).delete().eq('id', id);
    if (error) throw error;
  },
  async findById(table, id) {
    const tbl = resolveTableName(table);
    const { data, error } = await supabase.from(tbl).select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  },
  async query(table, match, order = null, limit = null) {
    const tbl = resolveTableName(table);
    let q = supabase.from(tbl).select('*', { count: 'exact' });
    Object.entries(match || {}).forEach(([k, v]) => {
      if (v == null) return;
      if (Array.isArray(v)) q = q.in(k, v);
      else if (k.endsWith('_gte')) q = q.gte(k.replace('_gte', ''), v);
      else if (k.endsWith('_lte')) q = q.lte(k.replace('_lte', ''), v);
      else q = q.eq(k, v);
    });
    if (order) q = q.order(order.column || order, { ascending: !!order.ascending });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },
};
