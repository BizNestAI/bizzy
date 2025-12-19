// File: /src/api/investments/investments.controller.js
import crypto from 'node:crypto';
import { supabase } from '../../services/supabaseAdmin.js';
import { importCsvText, upsertManualPosition } from './positions.service.js';

// In-memory dev demo
let MEMORY_POSITIONS = [
  { id: 'pos_1', symbol: 'VOO', name: 'Vanguard S&P 500 ETF', qty: 200, price: 110 },
  { id: 'pos_2', symbol: 'AAPL', name: 'Apple Inc.',           qty: 150, price: 192.4 },
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nowISO = () => new Date().toISOString();

function getUserId(req) {
  const id = req.ctx?.userId || req.user?.id || req.header('x-user-id') || req.query.user_id || req.body?.user_id;
  if (id) return id;
  if (process.env.MOCK_INVESTMENTS === 'true') return 'demo-user';
  const err = new Error('missing_user_id'); err.status = 401; throw err;
}

/* GET /api/investments/positions */
export async function getPositions(req, res) {
  try {
    const user_id = getUserId(req);

    if (process.env.MOCK_INVESTMENTS === 'true') {
      const rows = MEMORY_POSITIONS.map(p => ({ ...p, value: round2(Number(p.qty) * Number(p.price)) }));
      const total = round2(rows.reduce((s, r) => s + r.value, 0));
      return res.json({ ok: true, status: 'mock', data: { total, positions: rows, source: 'memory-stub' } });
    }

    const { data, error } = await supabase
      .from('investment_positions')
      .select('id, symbol, name, qty, price')
      .eq('user_id', user_id);
    if (error) throw error;
    const rows = (data || []).map(r => {
      const qty = Number(r.qty) || 0;
      const price = Number(r.price) || 0;
      return { ...r, qty, price, value: round2(qty * price) };
    });
    const total = round2(rows.reduce((s, r) => s + r.value, 0));
    return res.json({ ok: true, data: { total, positions: rows, source: 'supabase' } });
  } catch (e) {
    console.error('[investments.controller] getPositions', e);
    res.status(e.status || 500).json({ ok: false, code: 'failed_to_get_positions', message: e.message });
  }
}

/* POST /api/investments/refresh */
export async function refresh(_req, res) {
  try {
    // stub: place to trigger background sync/quotes if needed
    return res.json({ ok: true, started_at: nowISO() });
  } catch (e) {
    console.error('[investments.controller] refresh', e);
    res.status(500).json({ ok: false, code: 'failed_to_start_refresh' });
  }
}

/* POST /api/investments/upload-csv */
export async function uploadCsv(req, res) {
  try {
    const user_id = getUserId(req);
    const csv = (req.body?.csv || '').trim();
    if (!csv) return res.status(400).json({ ok: false, code: 'csv_required' });

    const importedCount = await importCsvText(user_id, csv);
    return res.json({ ok: true, imported: importedCount });
  } catch (e) {
    console.error('[investments.controller] uploadCsv', e);
    res.status(e.status || 500).json({ ok: false, code: 'failed_to_import_csv', message: e.message });
  }
}

/* POST /api/investments/positions/manual */
export async function upsertManual(req, res) {
  try {
    const user_id = getUserId(req);
    const body = { ...req.body, user_id };
    await upsertManualPosition(body);

    // echo a lightweight confirmation for UX
    return res.status(201).json({ ok: true, updated_at: nowISO() });
  } catch (e) {
    console.error('[investments.controller] upsertManual', e);
    res.status(e.status || 500).json({ ok: false, code: 'failed_to_upsert_position', message: e.message });
  }
}
