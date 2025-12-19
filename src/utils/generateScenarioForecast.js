// File: /utils/generateScenarioForecast.js

/**
 * Generate an adjusted forecast from scenario items.
 *
 * BASELINE SHAPE (each row should have at least some of these):
 * [
 *   {
 *     month: 'YYYY-MM',          // preferred key
 *     month_label?: 'Mon YYYY',  // tolerated (used only for UI)
 *     revenue?: number,
 *     expenses?: number,
 *     cash_in?: number,
 *     cash_out?: number,
 *     net_cash?: number,
 *     ending_cash?: number
 *   },
 *   ...
 * ]
 *
 * SCENARIO ITEM SHAPE:
 * {
 *   type: 'revenue' | 'expense' | 'investment' | 'loan' | 'one_time' |
 *         'revenue_pct' | 'expense_pct',
 *   amount: number,                 // if *_pct, pass e.g. 0.10 for +10%
 *   start_month: 'YYYY-MM',
 *   end_month?: 'YYYY-MM',          // inclusive; if omitted + recurring, applies through horizon
 *   recurring?: boolean,            // default true for all types except 'one_time'
 *   description?: string,
 *   id?: string                     // optional tracking id
 * }
 *
 * OPTIONS (3rd arg):
 * {
 *   startingCash?: number           // if omitted, inferred from first row
 * }
 */

export function generateScenarioForecast(baselineForecast = [], scenarioItems = [], options = {}) {
  const base = Array.isArray(baselineForecast) ? baselineForecast : [];
  const items = Array.isArray(scenarioItems) ? scenarioItems : [];

  // Deep-ish copy without JSON pitfalls (retain only known fields)
  const forecast = base.map((r) => ({
    month: r.month || (r.month_label ? toYm(r.month_label) : undefined),
    month_label: r.month_label,
    revenue: n(r.revenue),
    expenses: n(r.expenses),
    cash_in: n(r.cash_in),
    cash_out: n(r.cash_out),
    net_cash: n(r.net_cash),
    ending_cash: n(r.ending_cash),
    scenario_effects: [] // will be filled with applied items
  })).filter((r) => r.month);

  if (forecast.length === 0) return [];

  // Index helper
  const indexOfMonth = (ym) => forecast.findIndex((r) => r.month === ym);

  // Apply each scenario item
  for (const rawItem of items) {
    const item = sanitizeItem(rawItem);
    if (!item) continue;

    const startIdx = indexOfMonth(item.start_month);
    if (startIdx === -1) continue;

    // Determine end index (inclusive)
    let endIdx = startIdx;
    if (item.recurring) {
      if (item.end_month) {
        const e = indexOfMonth(item.end_month);
        endIdx = e === -1 ? forecast.length - 1 : e;
      } else {
        endIdx = forecast.length - 1;
      }
    }

    // Apply across the span
    for (let i = startIdx; i <= endIdx && i < forecast.length; i++) {
      const row = forecast[i];

      const applyAbs = (key, delta) => {
        row[key] = n(row[key]) + n(delta);
      };

      const applyPct = (key, pct) => {
        row[key] = n(row[key]) + round2(n(row[key]) * n(pct));
      };

      switch (item.type) {
        case 'revenue':
        case 'investment': {
          // treat "investment" as revenue lift for now
          applyAbs('revenue', item.amount);
          applyAbs('cash_in', item.amount);
          break;
        }
        case 'expense':
        case 'loan': {
          applyAbs('expenses', item.amount);
          applyAbs('cash_out', item.amount);
          break;
        }
        case 'one_time': {
          if (i === startIdx) {
            applyAbs('expenses', item.amount);
            applyAbs('cash_out', item.amount);
          }
          break;
        }
        case 'revenue_pct': {
          applyPct('revenue', item.amount);
          applyPct('cash_in', item.amount);
          break;
        }
        case 'expense_pct': {
          applyPct('expenses', item.amount);
          applyPct('cash_out', item.amount);
          break;
        }
        default: {
          // fallback: treat unknown types as expense
          applyAbs('expenses', item.amount);
          applyAbs('cash_out', item.amount);
        }
      }

      // Track effect for UI/audit
      row.scenario_effects.push({
        id: item.id || undefined,
        type: item.type,
        amount: item.amount,
        description: item.description || undefined,
        month: row.month
      });
    }
  }

  // Recompute net_cash using cash_in/out if present, else revenue/expenses
  for (const r of forecast) {
    const hasCash = isFiniteNum(r.cash_in) || isFiniteNum(r.cash_out);
    const inflow = hasCash ? n(r.cash_in) : n(r.revenue);
    const outflow = hasCash ? n(r.cash_out) : n(r.expenses);
    r.net_cash = round0(inflow - outflow);
  }

  // Recompute ending_cash sequentially (infer starting cash if not provided)
  const startCash = inferStartingCash(forecast, options.startingCash);
  let rolling = startCash;
  for (let i = 0; i < forecast.length; i++) {
    rolling += n(forecast[i].net_cash);
    forecast[i].ending_cash = round0(rolling);
  }

  return forecast;
}

/* --------------------- helpers --------------------- */

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function isFiniteNum(v) {
  return Number.isFinite(Number(v));
}
function round0(v) {
  // whole dollars for UI cleanliness; change to round2 if you prefer cents
  return Math.round(Number(v) || 0);
}
function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function sanitizeItem(item = {}) {
  const type = String(item.type || '').toLowerCase();
  const allowed = new Set([
    'revenue', 'expense', 'investment', 'loan', 'one_time',
    'revenue_pct', 'expense_pct'
  ]);
  if (!allowed.has(type)) return null;

  const start_month = toYm(item.start_month);
  if (!start_month) return null;

  const end_month = item.end_month ? toYm(item.end_month) : undefined;

  return {
    id: item.id,
    type,
    amount: n(item.amount),
    start_month,
    end_month,
    recurring: type === 'one_time' ? false : (item.recurring !== false),
    description: item.description || ''
  };
}

// Accept 'YYYY-MM' or 'Mon YYYY' -> return 'YYYY-MM'
function toYm(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (String(d) === 'Invalid Date') return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function inferStartingCash(forecast, explicit) {
  if (isFiniteNum(explicit)) return n(explicit);
  // If first row has ending_cash and net_cash, back out starting cash.
  const first = forecast[0] || {};
  const net = isFiniteNum(first.net_cash)
    ? n(first.net_cash)
    : n(first.cash_in) - n(first.cash_out) || (n(first.revenue) - n(first.expenses));
  if (isFiniteNum(first.ending_cash)) return n(first.ending_cash) - net;
  // Fallback: 0
  return 0;
}
