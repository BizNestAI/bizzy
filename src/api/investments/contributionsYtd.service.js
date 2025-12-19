import { supabase } from '../../services/supabaseAdmin.js';


export async function upsertContributionsYTD(user_id, rows = []) {
  if (!user_id) throw new Error('missing_user_id');
  const clean = rows
    .map(r => ({
      user_id,
      account_type: normalizeKey(r.account_type),
      year: Number(r.year || new Date().getFullYear()),
      amount: Number(r.amount || 0),
      employee_amount: r.employee_amount != null ? Number(r.employee_amount) : null,
      employer_amount: r.employer_amount != null ? Number(r.employer_amount) : null,
      currency: r.currency || 'USD',
      source: r.source || 'manual',
      provider: r.provider || null,
      provider_account_id: r.provider_account_id || null,
      details: r.details || null,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }))
    .filter(r => r.account_type && r.year && r.amount >= 0);

  if (!clean.length) return { upserted: 0 };

  const { error } = await supabase
    .from('investment_contributions_ytd')
    .upsert(clean, { onConflict: 'user_id,account_type,year' });
  if (error) throw new Error(error.message);
  return { upserted: clean.length };
}

export async function listContributionsYTD(user_id, year) {
  const Y = Number(year || new Date().getFullYear());
  const { data, error } = await supabase
    .from('investment_contributions_ytd')
    .select('*')
    .eq('user_id', user_id)
    .eq('year', Y);
  if (error) throw new Error(error.message);
  return { year: Y, rows: data || [] };
}

function normalizeKey(k) {
  const v = String(k || '').toLowerCase().replace(/\s+|-/g, '_');
  if (v.includes('roth')) return 'roth_ira';
  if (v.includes('traditional')) return 'traditional_ira';
  if (v.includes('sep')) return 'sep_ira';
  if (v.includes('401')) return 'solo_401k';
  if (v.includes('hsa')) return 'hsa';
  return v;
}
