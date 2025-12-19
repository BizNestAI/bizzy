// ============================================================================
// File: /src/api/investments/contributionLimits.service.js
// Purpose: Compute per-account annual contribution limits, YTD usage, remaining,
//          pace status, and suggested monthly amounts. Upserts a "latest" view.
// ============================================================================

import { supabase } from '../../services/supabaseAdmin.js';



// --- IRS limits (update as needed). Values are contribution caps, not deductibility. ---
const IRS_LIMITS = {
  2024: {
    ira_base: 7000,
    ira_catchup: 1000,
    solo401k_employee: 23000,
    solo401k_catchup: 7500,
    solo401k_overall: 69000, // employee + employer
    sep_overall: 69000,      // or 25% of comp (approx)
    hsa_self: 4150,
    hsa_family: 8300,
    hsa_catchup: 1000
  },
  2025: {
    // ⚠️ Update when official. Using 2024 as placeholders so code keeps working.
    ira_base: 7000,
    ira_catchup: 1000,
    solo401k_employee: 23000,
    solo401k_catchup: 7500,
    solo401k_overall: 69000,
    sep_overall: 69000,
    hsa_self: 4150,
    hsa_family: 8300,
    hsa_catchup: 1000
  }
};

// Roth IRA income phase-out (very rough guardrails; update from Tax module if available)
const ROTH_PHASEOUT_2024 = {
  single: { start: 146000, end: 161000 },
  married: { start: 230000, end: 240000 },
};

// Utility
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const usd = (n) => Math.round(Number(n || 0));

// Public API
export async function getContributionLimits(user_id, { year, force = false } = {}) {
  if (!user_id) throw new Error('missing_user_id');
  const now = new Date();
  const Y = Number(year || now.getUTCFullYear());
  const monthIdx = now.getUTCMonth();                   // 0..11
  const monthsLeft = 12 - monthIdx;                     // include current month
  const limits = IRS_LIMITS[Y] || IRS_LIMITS[2024];

  // 0) Return cached "latest" for this year unless force
  if (!force) {
    const cached = await readLatest(user_id, Y);
    if (cached.length) return { year: Y, accounts: cached };
  }

  // 1) Gather inputs
  const [profile, taxProfile, contribYTDMap] = await Promise.all([
    getWealthProfile(user_id),
    getTaxProfile(user_id),
    getContribYTDMap(user_id, Y)
  ]);

  // Eligibility / profile hints
  const age = Number(profile?.age || 35);
  const is50Plus = age >= 50;
  const entityType = String(profile?.entity_type || '').toLowerCase(); // e.g., sole_prop, llc_scorp, etc.
  const comp = Number(profile?.owner_compensation || profile?.income_annual || 0); // for SEP 25% approx.

  const filing = normalizeFilingStatus(taxProfile?.filing_status);
  const magi = Number(taxProfile?.magi || taxProfile?.agi || profile?.income_annual || 0);
  const hdhp = !!taxProfile?.hsa_eligible; // HDHP indicator
  const hsaCoverage = (taxProfile?.hsa_coverage || 'self').toLowerCase(); // 'self'|'family'

  // 2) Calculate per account
  const out = [];

  // Roth IRA (eligibility check; limit reduction in phase-out is linear approx)
  {
    const phase = ROTH_PHASEOUT_2024[filing] || ROTH_PHASEOUT_2024.single;
    let allowed = limits.ira_base + (is50Plus ? limits.ira_catchup : 0);
    let statusNote;

    if (magi >= phase.end) {
      allowed = 0;
      statusNote = 'Ineligible due to income (Roth IRA). Consider Backdoor Roth.';
    } else if (magi >= phase.start) {
      // simple linear reduction
      const frac = (phase.end - magi) / Math.max(1, (phase.end - phase.start));
      allowed = Math.max(0, Math.round(allowed * frac));
      statusNote = 'Partial eligibility due to income phase-out.';
    }

    const contributed = usd(contribYTDMap.get('roth_ira'));
    out.push(buildAccountRow({
      kind: 'Roth IRA',
      allowedLimit: allowed,
      contributed,
      monthsLeft,
      monthIdx,
      year: Y,
      note: statusNote
    }));
  }

  // Traditional IRA (deductibility depends on income & coverage; we track contribution limit only)
  {
    const allowed = limits.ira_base + (is50Plus ? limits.ira_catchup : 0);
    const contributed = usd(contribYTDMap.get('traditional_ira'));
    out.push(buildAccountRow({
      kind: 'Traditional IRA',
      allowedLimit: allowed,
      contributed,
      monthsLeft,
      monthIdx,
      year: Y
    }));
  }

  // Solo 401(k) — track employee deferral here; overall cap noted.
  {
    const employeeCap = limits.solo401k_employee + (is50Plus ? limits.solo401k_catchup : 0);
    const contributed = usd(contribYTDMap.get('solo_401k')); // employee deferrals YTD
    const row = buildAccountRow({
      kind: 'Solo 401(k)',
      allowedLimit: employeeCap,
      contributed,
      monthsLeft,
      monthIdx,
      year: Y
    });
    row.notes = `Overall plan cap ${fmtUSD(limits.solo401k_overall)} including employer profit share.`;
    out.push(row);
  }

  // SEP IRA — overall limit min(SEP overall, 25% of compensation)
  {
    const cap25 = Math.floor(comp * 0.25);
    const allowed = Math.min(limits.sep_overall, cap25 || limits.sep_overall);
    const contributed = usd(contribYTDMap.get('sep_ira'));
    const eligible = isSepEligible(entityType);
    const row = buildAccountRow({
      kind: 'SEP IRA',
      allowedLimit: eligible ? allowed : 0,
      contributed,
      monthsLeft,
      monthIdx,
      year: Y
    });
    if (!eligible) row.notes = 'Not eligible for SEP based on entity type.';
    out.push(row);
  }

  // HSA — requires HDHP; coverage self vs family affects limit
  {
    const base = hsaCoverage === 'family' ? limits.hsa_family : limits.hsa_self;
    const allowed = (hdhp ? base + (is50Plus ? limits.hsa_catchup : 0) : 0);
    const contributed = usd(contribYTDMap.get('hsa'));
    const row = buildAccountRow({
      kind: 'HSA',
      allowedLimit: allowed,
      contributed,
      monthsLeft,
      monthIdx,
      year: Y
    });
    if (!hdhp) row.notes = 'HSA not available without HDHP coverage.';
    out.push(row);
  }

  // 3) Persist "latest" rows for this year
  await upsertLatest(user_id, out);

  return { year: Y, accounts: out };
}

// ---------- helpers to build rows & status ----------
function buildAccountRow({ kind, allowedLimit, contributed, monthsLeft, monthIdx, year, note }) {
  const limit_total = usd(allowedLimit || 0);
  const contributed_ytd = usd(contributed || 0);
  const remaining = Math.max(0, limit_total - contributed_ytd);
  const percent_used = limit_total > 0 ? clamp((contributed_ytd / limit_total) * 100, 0, 999) : 0;

  // Pace vs calendar (on-track if at least ~90% of linear pace)
  const monthsElapsed = monthIdx + 1; // include current month
  const targetByNow = limit_total * (monthsElapsed / 12);
  const pacePct = targetByNow > 0 ? contributed_ytd / targetByNow : 1;

  let status = 'green';
  if (contributed_ytd > limit_total) status = 'over';
  else if (pacePct >= 0.9) status = 'green';
  else if (pacePct >= 0.5) status = 'yellow';
  else status = 'red';

  const suggested_monthly = monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining;

  const row = {
    account_type: kind,
    limit_total,
    contributed_ytd,
    remaining,
    percent_used: Math.round(percent_used),
    suggested_monthly,
    status,         // 'green' | 'yellow' | 'red' | 'over' | 'ineligible'
    year,
  };
  if (note) row.notes = note;
  if (limit_total === 0) row.status = 'ineligible';
  if (remaining === 0 && limit_total > 0) row.status = 'green';
  return row;
}

function normalizeFilingStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v.includes('married')) return 'married';
  return 'single';
}

function isSepEligible(entityType) {
  // Very relaxed heuristic; refine with tax module
  // Most self-employed entities can sponsor SEP. Disallow obvious W2-only.
  if (!entityType) return true;
  const deny = ['w2', 'employee'];
  return !deny.some((d) => entityType.includes(d));
}

function fmtUSD(n) { return `$${Math.round(Number(n || 0)).toLocaleString()}`; }

// ---------- Supabase read/write ----------
async function readLatest(user_id, year) {
  const { data, error } = await supabase
    .from('contribution_limits_latest')
    .select('account_type, limit_total, contributed_ytd, remaining, percent_used, suggested_monthly, status, year, notes')
    .eq('user_id', user_id)
    .eq('year', year);

  if (error) {
    console.warn('[contrib-limits] readLatest error:', error.message);
    return [];
  }
  return data || [];
}

async function upsertLatest(user_id, rows) {
  const payload = rows.map((r) => ({
    user_id,
    ...r,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  }));
  const { error } = await supabase
    .from('contribution_limits_latest')
    .upsert(payload, { onConflict: 'user_id,account_type,year' });
  if (error) console.warn('[contrib-limits] upsertLatest error:', error.message);
}

// ---------- inputs: profile / tax / contributions ----------
async function getWealthProfile(user_id) {
  const { data, error } = await supabase
    .from('wealth_profile')
    .select('*')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) {
    console.warn('[contrib-limits] wealth_profile error:', error.message);
    return {};
  }
  return data || {};
}

async function getTaxProfile(user_id) {
  try {
    const { data, error } = await supabase
      .from('tax_profile')
      .select('*')
      .eq('user_id', user_id)
      .maybeSingle();
    if (error) return {};
    return data || {};
  } catch {
    return {};
  }
}

/**
 * Attempts to build a map of YTD contribution dollars by account type.
 * Looks for any available source; falls back to 0 if not found.
 * Preferred tables/columns (use whatever you have):
 * - investment_contributions_ytd: [{account_type, amount, year}]
 * - investment_balances_latest:   {contributions_ytd_json: { roth_ira: 4500, ... }}
 */
async function getContribYTDMap(user_id, year) {
  const map = new Map([
    ['roth_ira', 0],
    ['traditional_ira', 0],
    ['sep_ira', 0],
    ['solo_401k', 0],
    ['hsa', 0],
  ]);

  // 1) explicit YTD table if present
  try {
    const { data, error } = await supabase
      .from('investment_contributions_ytd')
      .select('account_type, amount, year')
      .eq('user_id', user_id)
      .eq('year', year);
    if (!error && Array.isArray(data)) {
      for (const r of data) {
        const k = normalizeKey(r.account_type);
        if (map.has(k)) map.set(k, Number(r.amount || 0));
      }
    }
  } catch {}

  // 2) balances latest JSON (merged across rows)
  try {
    const { data, error } = await supabase
      .from('investment_balances_latest')
      .select('contributions_ytd_json')
      .eq('user_id', user_id);
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const j = row?.contributions_ytd_json || {};
        for (const [k, v] of Object.entries(j)) {
          const kk = normalizeKey(k);
          if (map.has(kk)) map.set(kk, (map.get(kk) || 0) + Number(v || 0));
        }
      }
    }
  } catch {}

  return map;
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
