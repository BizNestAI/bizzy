// ============================================================================
// File: /src/api/investments/retirement.service.js
// ============================================================================
import { supabase } from '../../services/supabaseAdmin.js';


/**
 * Calculate a retirement projection by combining synced balances, wealth profile defaults,
 * and user-provided overrides. Returns deterministic results + Monte Carlo probability
 * and percentile bands. Also snapshots one row/month to retirement_projection_history.
 */
export async function calculateRetirementProjection(user_id, overrides = {}) {
  // 1) Load data sources
  const balances = await getLatestBalances(user_id); // { total_balance_usd, accounts: [...] }
  const profile = await getWealthProfile(user_id);   // may be {}

  // 2) Resolve inputs (priority: overrides > profile > sensible defaults)
  const today = new Date();
  const current_age = num(overrides.current_age, profile.current_age, 35);
  const retirement_age = num(overrides.retirement_age, profile.retirement_age, 65);
  const years = Math.max(0, Math.floor(retirement_age - current_age));

  const current_savings = num(overrides.current_savings, balances.total_balance_usd, 0);

  const income_annual = num(overrides.income_annual, profile.income_annual, 120000);
  const contrib_annual = resolveContributionAnnual(overrides, profile, income_annual); // dollars/year

  const exp_return_pct = num(overrides.expected_return_pct, profile.expected_return_pct, 6); // % nominal
  const inflation_pct   = num(overrides.inflation_pct,       profile.inflation_pct,       2.5);
  const contribution_grows_with_inflation = bool(
    overrides.contribution_grows_with_inflation,
    profile.contribution_grows_with_inflation,
    true
  );

  const lifestyle = (overrides.lifestyle || profile.lifestyle || 'comfortable').toLowerCase();
  const target_income_today = resolveLifestyleTargetIncome(
    overrides,
    profile,
    lifestyle,
    income_annual
  ); // $/yr in today's dollars
  const swr_pct = num(overrides.swr_pct, profile.swr_pct, 4); // safe withdrawal rate (4% rule)

  const business_sale_value = num(overrides.business_sale_value, profile.business_sale_value, 0); // dollars
  const business_sale_age   = num(overrides.business_sale_age,   profile.business_sale_age,   retirement_age); // age when cash lands

  const trials = clamp(num(overrides.monte_carlo_trials, undefined, 600), 100, 5000);
  const stdev_pct = num(overrides.return_volatility_pct, profile.return_volatility_pct, 12); // annual %

  // 3) Deterministic annual series
  const series = [];
  const target_series = [];
  let balance = current_savings;
  const r_nominal = exp_return_pct / 100;
  const i_infl = inflation_pct / 100;
  const swr = swr_pct / 100; // e.g., 0.04

  for (let y = 0; y <= years; y++) {
    const age = current_age + y;

    // Determine annual contribution for this year
    const contrib_y = contribution_grows_with_inflation
      ? contrib_annual * Math.pow(1 + i_infl, y)
      : contrib_annual;

    // Apply growth and contribution (end-of-year contribution assumption)
    if (y > 0) {
      balance = balance * (1 + r_nominal) + contrib_y;
    }

    // Inject business sale when age matches
    if (age === business_sale_age && business_sale_value > 0) {
      balance += business_sale_value;
    }

    series.push({ age, balance });

    // Target lifestyle curve expressed as required portfolio balance this year
    const income_this_year_nominal = target_income_today * Math.pow(1 + i_infl, y);
    const target_balance_this_year = swr > 0 ? income_this_year_nominal / swr : null;
    target_series.push({ age, target: target_balance_this_year });
  }

  const projected_balance = series[series.length - 1].balance;
  const target_balance = target_series[target_series.length - 1].target || 0;
  const surplus = projected_balance - target_balance;
  const surplus_pct = target_balance > 0 ? (surplus / target_balance) * 100 : null;

  // 4) Required monthly adjustment to hit target at retirement
  const required_annual_contrib = requiredContributionAnnual({
    goalFV: target_balance,
    presentValue: current_savings,
    years,
    annualReturn: r_nominal,
  });
  const required_monthly_adjustment = (required_annual_contrib - contrib_annual) / 12; // can be negative

  // 5) Years until target reached (if before retirement)
  let years_to_goal = null;
  for (let k = 0; k < series.length; k++) {
    if (series[k].balance >= (target_series[k].target || Infinity)) { years_to_goal = k; break; }
  }

  // 6) Monte Carlo: probability of success + percentile bands per year
  const { probability_of_success, band_series } = monteCarloWithBands({
    current_savings,
    contrib_annual,
    years,
    meanReturn: r_nominal,
    stdev: stdev_pct / 100,
    infl: i_infl,
    contribution_grows_with_inflation,
    target_balance_at_retirement: target_balance,
    business_sale_value,
    business_sale_age,
    current_age,
    trials
  });

  const status = statusFromSurplus(surplus, target_balance);

  const payload = {
    as_of: today.toISOString(),
    inputs: {
      current_age,
      retirement_age,
      current_savings,
      contrib_annual,
      expected_return_pct: exp_return_pct,
      inflation_pct,
      lifestyle,
      target_income_today,
      swr_pct,
      business_sale_value,
      business_sale_age,
      trials,
      stdev_pct
    },
    results: {
      projected_balance,
      target_balance,
      surplus,
      surplus_pct,
      required_monthly_adjustment,
      years_to_goal,
      probability_of_success,
      status
    },
    series,
    target_series,
    band_series
  };

  // 7) Persist a monthly snapshot (idempotent per user_id + YYYY-MM)
  await saveProjectionSnapshot(user_id, payload);

  return payload;
}

/* --------------------------------- Helpers -------------------------------- */
function num(...vals){
  for (const v of vals){
    if (v === 0) return 0; // allow 0
    if (v !== undefined && v !== null && !Number.isNaN(Number(v))) return Number(v);
  }
  return undefined; // fall-through
}
function bool(...vals){
  for (const v of vals){ if (typeof v === 'boolean') return v; }
  return undefined;
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function statusFromSurplus(surplus, target){
  if (!target || target <= 0) return 'unknown';
  const pct = surplus / target;
  if (pct >= 0.05) return 'surplus';
  if (pct >= -0.05) return 'at_risk';
  return 'shortfall';
}

function resolveContributionAnnual(overrides, profile, income_annual){
  // Options: monthly_contribution, annual_contribution, or % of income
  const m = num(overrides.monthly_contribution, profile.monthly_contribution);
  if (m !== undefined) return m * 12;
  const a = num(overrides.annual_contribution, profile.annual_contribution);
  if (a !== undefined) return a;
  const pct = num(overrides.contribution_pct_of_income, profile.contribution_pct_of_income);
  if (pct !== undefined) return (pct / 100) * income_annual;
  return 12000; // default $1k/mo
}

function resolveLifestyleTargetIncome(overrides, profile, lifestyle, income_annual){
  // If explicit amount is provided, use it
  const explicit = num(overrides.target_income_today, profile.target_income_today);
  if (explicit !== undefined) return explicit;

  // Otherwise, map lifestyle to % of current income
  const map = {
    basic: 0.6,
    comfortable: 0.8,
    wealthy: 1.2,
  };
  const pct = map[lifestyle] ?? 0.8;
  return income_annual * pct;
}

function requiredContributionAnnual({ goalFV, presentValue, years, annualReturn }){
  if (!goalFV || years <= 0) return 0;
  const r = annualReturn;
  const pvPart = (presentValue || 0) * Math.pow(1 + r, years);
  const numer = (goalFV - pvPart) * r;
  const denom = Math.pow(1 + r, years) - 1;
  if (r === 0 || denom === 0) return (goalFV - pvPart) / Math.max(1, years); // linear
  return numer / denom;
}

/**
 * Monte Carlo simulation returning:
 * - probability_of_success (share of trials meeting/exceeding target at retirement)
 * - band_series: [{ age, p10, p50, p90 }] percentile bands for each year
 */
function monteCarloWithBands(opts){
  const {
    current_savings, contrib_annual, years, meanReturn, stdev, infl,
    contribution_grows_with_inflation, target_balance_at_retirement,
    business_sale_value, business_sale_age, current_age, trials
  } = opts;

  if (years <= 0) return { probability_of_success: null, band_series: [] };

  // Collect balances per year across trials
  const perYear = Array.from({ length: years + 1 }, () => []);
  let success = 0;

  for (let t = 0; t < trials; t++) {
    let bal = current_savings;
    perYear[0].push(bal);

    for (let y = 1; y <= years; y++) {
      const age = current_age + y;
      const r = randNorm(meanReturn, stdev);
      const c = contribution_grows_with_inflation
        ? contrib_annual * Math.pow(1 + infl, y - 1)
        : contrib_annual;

      // grow then contribute
      bal = bal * (1 + r) + c;

      if (age === business_sale_age && business_sale_value > 0) {
        bal += business_sale_value;
      }

      perYear[y].push(bal);
    }

    // Evaluate success at retirement
    if (perYear[years][perYear[years].length - 1] >= target_balance_at_retirement) {
      success++;
    }
  }

  const band_series = perYear.map((arr, idx) => ({
    age: current_age + idx,
    p10: quantile(arr, 0.10),
    p50: quantile(arr, 0.50),
    p90: quantile(arr, 0.90),
  }));

  const probability_of_success = success / trials;
  return { probability_of_success, band_series };
}

// Percentile helper
function quantile(arr, q){
  if (!arr?.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base + 1] !== undefined) return s[base] + rest * (s[base + 1] - s[base]);
  return s[base];
}

// Box-Muller transform for normal distribution
function randNorm(mean, stdev){
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + z * stdev;
}

/* ----------------------------- Data Fetchers ----------------------------- */
async function getLatestBalances(user_id){
  // Aggregate from investment_balances_latest
  const { data, error } = await supabase
    .from('investment_balances_latest')
    .select('balance_usd, ytd_gain_usd, user_id')
    .eq('user_id', user_id);
  if (error) { console.warn('[projection] balances err:', error.message); }

  const total = (data || []).reduce((a, r) => a + (Number(r.balance_usd) || 0), 0);
  const ytd = (data || []).reduce((a, r) => a + (Number(r.ytd_gain_usd) || 0), 0);
  return { total_balance_usd: total, ytd_gain_usd: ytd, accounts: data || [] };
}

async function getWealthProfile(user_id){
  // Optional: table from Prompt #2. If missing, return {}
  try {
    const { data, error } = await supabase
      .from('wealth_profile')
      .select('*')
      .eq('user_id', user_id)
      .limit(1)
      .maybeSingle();
    if (error) { console.warn('[projection] wealth_profile err:', error.message); return {}; }
    return data || {};
  } catch (e) {
    console.warn('[projection] wealth_profile missing');
    return {};
  }
}

/* ---------------------------- Persist Snapshot --------------------------- */
async function saveProjectionSnapshot(user_id, payload){
  try{
    const d = new Date(payload.as_of || new Date());
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; // YYYY-MM
    const row = {
      user_id,
      month_ym: ym,
      inputs_json: payload.inputs,
      results_json: payload.results,
      series_json: payload.series,
      target_series_json: payload.target_series,
      band_series_json: payload.band_series,
      created_at: new Date().toISOString(),
    };
    // upsert by (user_id, month_ym)
    const { error } = await supabase
      .from('retirement_projection_history')
      .upsert(row, { onConflict: 'user_id,month_ym' });
    if (error) console.warn('[projection] snapshot upsert error:', error.message);
  }catch(e){
    console.warn('[projection] snapshot failed:', e.message);
  }
}
