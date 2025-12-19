// Retirement Simulator — clarified goals, milestones, stress tests, polished UI
// -----------------------------------------------------------------------------
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart as RCLineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Area,
  ReferenceDot,
  ReferenceLine,
} from "recharts";
import {
  LineChart as LineChartIcon,
  AlertTriangle,
  CheckCircle2,
  RefreshCcw,
  Settings2,
  HelpCircle,
  Target,
  TrendingUp,
  ThermometerSun,
  PauseCircle,
} from "lucide-react";
import { supabase } from "../../services/supabaseClient";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";

const NEON = "#C084FC";
const PANEL_BG = "linear-gradient(150deg, rgba(17,20,29,0.98), rgba(9,10,16,0.94))";
const PANEL_BORDER = "rgba(255,255,255,0.08)";
const PANEL_SHADOW = "0 40px 80px rgba(0,0,0,0.55)";
const SECTION_BG = "rgba(255,255,255,0.04)";
const SECTION_BORDER = "rgba(255,255,255,0.08)";
const CHART_BG = "linear-gradient(160deg, rgba(17,19,27,0.95), rgba(8,9,14,0.92))";
const fmt0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtUSD0 = (n) => `$${fmt0.format(Math.round(Number(n || 0)))}`;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/** Build auth + identity headers (Bearer + ids) */
async function buildAuthHeaders(userId) {
  const headers = { "Content-Type": "application/json" };
  let token = null;
  try {
    const { data } = await supabase.auth.getSession();
    token = data?.session?.access_token || null;
  } catch (e) {
    console.warn("[retirement] supabase session fetch failed", e);
  }
  if (!token) {
    token = localStorage.getItem("access_token");
  }
  if (!token) {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (/^sb-.*-auth-token$/.test(key)) {
        try {
          const parsed = JSON.parse(localStorage.getItem(key) || "{}");
          token = parsed?.access_token || parsed?.currentSession?.access_token || parsed?.session?.access_token;
          if (token) break;
        } catch (err) {
          /* ignore */
        }
      }
    }
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  if (userId) headers["x-user-id"] = userId;
  const bizId = localStorage.getItem("business_id") || localStorage.getItem("currentBusinessId");
  if (bizId) headers["x-business-id"] = bizId;
  return headers;
}

function useDebounced(value, delay = 450) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export default function RetirementSimulator({ userId, onAskBizzy, className = "" }) {
  const [inputs, setInputs] = useState({
    current_age: 35,
    retirement_age: 65,
    annual_contribution: 12000,
    expected_return_pct: 6,
    inflation_pct: 2.5,
    lifestyle: "comfortable",
    target_income_today: 60000, // <— default target income for clarity
    business_sale_value: 0,
    business_sale_age: 60,
    contribution_grows_with_inflation: true,
    return_volatility_pct: 12,
    monte_carlo_trials: 600,
  });

  // Stress tests (client-side approximations)
  const [stress, setStress] = useState({
    marketShock: false,      // reduce exp. return by ~2.5% (proxy for a shock)
    highInflation: false,    // set inflation to >=5%
    pauseContrib12m: false,  // temporarily set contributions to 0 (approx.)
  });
  const [auxTab, setAuxTab] = useState("stress");

  const [results, setResults] = useState(null);
  const [series, setSeries] = useState([]);
  const [targetSeries, setTargetSeries] = useState([]);
  const [bandSeries, setBandSeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const firstHydrate = useRef(true);
  const abortRef = useRef(null);
  const isDemo = shouldUseDemoData();
  const demoRetirement = useMemo(
    () => (isDemo ? getDemoData()?.investments?.retirement || null : null),
    [isDemo]
  );

  // Build the “effective” payload sent to the API with stress adjustments
  const effectiveInputs = useMemo(() => {
    const out = { ...inputs };

    if (stress.marketShock) {
      out.expected_return_pct = Math.max(-3, (inputs.expected_return_pct ?? 6) - 2.5);
    }
    if (stress.highInflation) {
      out.inflation_pct = Math.max(5, (inputs.inflation_pct ?? 2.5));
    }
    if (stress.pauseContrib12m) {
      // Service doesn’t support time-varying flows; approx by cutting to 0 for now
      out.annual_contribution = 0;
    }
    return out;
  }, [inputs, stress]);

  const debouncedInputs = useDebounced(effectiveInputs, 450);

  useEffect(() => {
    if (isDemo) {
      setLoading(false);
      setError(null);
      if (firstHydrate.current && demoRetirement) {
        firstHydrate.current = false;
        setInputs((prev) => ({ ...prev, ...pickEditableInputs(demoRetirement.inputs || {}) }));
        setResults(demoRetirement.results || null);
        setSeries(demoRetirement.series || []);
        setTargetSeries(demoRetirement.targetSeries || []);
        setBandSeries(demoRetirement.bandSeries || []);
      } else {
        const fallback = buildLocalProjection(debouncedInputs);
        setResults(fallback.results);
        setSeries(fallback.series);
        setTargetSeries(fallback.targetSeries);
        setBandSeries(fallback.bandSeries);
      }
      return () => {};
    }

    (async () => {
      setLoading(true);
      setError(null);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const headers = await buildAuthHeaders(userId);
        const res = await fetch("/api/investments/retirement-projection", {
          method: "POST",
          headers,
          credentials: "omit",
          body: JSON.stringify(debouncedInputs),
          signal: controller.signal,
        });
        if (res.status === 401) {
          throw new Error("unauthorized");
        }
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "projection_failed");

        if (firstHydrate.current && json?.inputs) {
          firstHydrate.current = false;
          setInputs((prev) => ({ ...prev, ...pickEditableInputs(json.inputs) }));
        }
        setResults(json?.results || null);
        setSeries(json?.series || []);
        setTargetSeries(json?.target_series || []);
        setBandSeries(json?.band_series || []);
      } catch (e) {
        if (e.name === "AbortError") return;
        if (e.message === "unauthorized") {
          console.warn("[retirement] unauthorized, using local projection");
          const fallback = buildLocalProjection(debouncedInputs);
          setResults(fallback.results);
          setSeries(fallback.series);
          setTargetSeries(fallback.targetSeries);
          setBandSeries(fallback.bandSeries);
          setError(null);
        } else {
          setError(e.message || "Failed to run projection");
          const fallback = buildLocalProjection(debouncedInputs);
          setSeries((prev) => (fallback.series.length ? fallback.series : prev));
          setTargetSeries((prev) => (fallback.targetSeries.length ? fallback.targetSeries : prev));
          setBandSeries((prev) => (fallback.bandSeries.length ? fallback.bandSeries : prev));
          setResults((prev) => prev || fallback.results);
        }
      } finally {
        setLoading(false);
      }
    })();

    return () => abortRef.current?.abort();
  }, [debouncedInputs, userId, isDemo, demoRetirement]);

  // Merge series for the chart
  const combinedData = useMemo(() => {
    const byAge = new Map();
    for (const p of series) byAge.set(p.age, { age: p.age, balance: p.balance });
    for (const t of targetSeries)
      byAge.set(t.age, { ...(byAge.get(t.age) || { age: t.age }), target: t.target });
    for (const b of bandSeries)
      byAge.set(b.age, { ...(byAge.get(b.age) || { age: b.age }), p10: b.p10, p50: b.p50, p90: b.p90 });
    return Array.from(byAge.values()).sort((a, b) => a.age - b.age);
  }, [series, targetSeries, bandSeries]);

  // Milestones: first age that crosses target and $1M mark
  const milestones = useMemo(() => {
    if (!combinedData?.length) return null;
    let crossTargetAge = null;
    let crossMillionAge = null;
    for (let i = 0; i < combinedData.length; i++) {
      const row = combinedData[i];
      if (row.balance != null && row.target != null && crossTargetAge == null && row.balance >= row.target) {
        crossTargetAge = row.age;
      }
      if (row.balance != null && crossMillionAge == null && row.balance >= 1_000_000) {
        crossMillionAge = row.age;
      }
      if (crossTargetAge && crossMillionAge) break;
    }
    return { crossTargetAge, crossMillionAge };
  }, [combinedData]);

  const statusColor =
    results?.status === "surplus"
      ? "text-emerald-400"
      : results?.status === "at_risk"
      ? "text-amber-300"
      : results?.status === "shortfall"
      ? "text-rose-400"
      : "text-white/80";

  return (
    <div
      className={`rounded-[36px] border p-4 sm:p-6 backdrop-blur-sm ${className}`}
      style={{ background: PANEL_BG, borderColor: PANEL_BORDER, boxShadow: PANEL_SHADOW }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <LineChartIcon size={18} className="text-white/70" />
          <h3 className="text-base sm:text-lg font-medium text-white/90">
            Retirement Trajectory Simulator
          </h3>
        </div>
        <button
          onClick={() => setInputs((p) => ({ ...p }))}
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-white/80 outline-none focus:ring-2 focus:ring-[#C084FC]/30"
          aria-label="Run simulation"
        >
          <RefreshCcw size={14} className={loading ? "animate-spin" : ""} />
          Run
        </button>
      </div>

      <div className="space-y-5">
        {/* KPIs + chart */}
        <SectionCard>
          <div
            className="mt-4 rounded-[24px] border px-4 py-3.5"
            style={{ background: CHART_BG, borderColor: "rgba(255,255,255,0.08)" }}
          >
            <div className="flex flex-wrap items-center gap-4 text-[11px] text-white/70">
              {[{ label: "Projection", color: NEON }, { label: "Target", color: "#8AB4FF" }, { label: "p10 / p90 band", color: "#94a3b8" }].map((chip) => (
                <div key={chip.label} className="flex items-center gap-2">
                  <span className="h-2 w-5 rounded-full" style={{ background: chip.color, opacity: chip.label.includes("band") ? 0.35 : 1 }} />
                  {chip.label}
                </div>
              ))}
            </div>
            <div className="mt-4 h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <RCLineChart data={combinedData} margin={{ left: 0, right: 20, top: 8, bottom: 8 }}>
                  <defs>
                    <linearGradient id="balanceArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={NEON} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={NEON} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis
                    dataKey="age"
                    stroke="rgba(255,255,255,0.65)"
                    tick={{ fontSize: 12 }}
                    label={{ value: "Age", position: "insideBottom", offset: -5, fill: "rgba(255,255,255,0.6)", fontSize: 12 }}
                  />
                  <YAxis
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                    stroke="rgba(255,255,255,0.65)"
                    tick={{ fontSize: 12 }}
                    label={{ value: "Balance ($)", angle: -90, position: "insideLeft", offset: 10, fill: "rgba(255,255,255,0.6)", fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{ background: "rgba(7,9,14,0.95)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14 }}
                    formatter={(val, name) => [fmtUSD0(val), name === "balance" ? "Projection" : name === "target" ? "Target" : name.toUpperCase()]}
                  />
                  {inputs?.retirement_age && (
                    <ReferenceLine
                      x={inputs.retirement_age}
                      stroke="rgba(255,255,255,0.25)"
                      strokeDasharray="4 4"
                      label={{ value: `Retire ${inputs.retirement_age}`, position: "top", fill: "#FFFFFF", fontSize: 11 }}
                    />
                  )}
                  <Area type="monotone" dataKey="p90" stroke="none" fill="url(#balanceArea)" name="p90 (optimistic)" />
                  <Line type="monotone" dataKey="p10" name="p10 (conservative)" stroke="#94a3b8" strokeDasharray="5 5" dot={false} />
                  <Line type="monotone" dataKey="balance" name="Projection" stroke={NEON} strokeWidth={2.4} dot={false} />
                  <Line type="monotone" dataKey="target" name="Target" stroke="#8AB4FF" strokeDasharray="6 4" strokeWidth={2} dot={false} />
                  {combinedData.length > 0 && (
                    <ReferenceDot
                      x={combinedData[combinedData.length - 1].age}
                      y={combinedData[combinedData.length - 1].balance}
                      r={4}
                      fill={NEON}
                      stroke="white"
                      strokeWidth={1}
                    />
                  )}
                </RCLineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <QuickPrompt
                label="What if I retire at 60?"
                onClick={() => {
                  setInputs((p) => ({ ...p, retirement_age: 60 }));
                  onAskBizzy?.("What if I retire at 60? Please explain the impact.");
                }}
              />
              <QuickPrompt
                label="Max my Solo 401(k) next year"
                onClick={() => {
                  setInputs((p) => ({ ...p, annual_contribution: Math.max(19500, p.annual_contribution || 0) }));
                  onAskBizzy?.("If I max my Solo 401(k) next year, what changes?");
                }}
              />
              <QuickPrompt
                label="Sell business for $500k"
                onClick={() => {
                  setInputs((p) => ({ ...p, business_sale_value: 500000, business_sale_age: Math.max(p.current_age + 5, 55) }));
                  onAskBizzy?.("How much sooner could I retire if I sold my business for $500k?");
                }}
              />
            </div>
          </div>

          <div className="mt-4">
            {loading ? (
              <div className="animate-pulse h-18 rounded-xl bg-white/5" />
            ) : error ? (
              <div className="text-rose-400 text-sm">{error}</div>
            ) : results ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <ResultTile title="Projected Balance" value={fmtUSD0(results.projected_balance)} tone={statusColor} />
                <ResultTile
                  title={results.surplus >= 0 ? "Surplus vs Goal" : "Shortfall vs Goal"}
                  value={`${results.surplus >= 0 ? "+" : ""}${fmtUSD0(results.surplus)}`}
                  sub={results.surplus_pct != null ? `${results.surplus_pct.toFixed(1)}%` : ""}
                />
                <ResultTile
                  title="Required Monthly Adj."
                  value={`${results.required_monthly_adjustment >= 0 ? "+" : ""}${fmtUSD0(results.required_monthly_adjustment)}`}
                  sub="per month to hit goal"
                />
                <ResultTile
                  title="Success Probability"
                  value={results.probability_of_success != null ? `${Math.round(results.probability_of_success * 100)}%` : "—"}
                />
              </div>
            ) : (
              <div className="text-sm text-white/60">No results yet.</div>
            )}
          </div>

          {milestones && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <Milestone
                icon={<TrendingUp size={16} className="text-emerald-300" />}
                title="Cross $1M"
                value={milestones.crossMillionAge ? `Age ${milestones.crossMillionAge}` : "Not reached"}
                tone={milestones.crossMillionAge ? "good" : "neutral"}
              />
              <Milestone
                icon={<Target size={16} className="text-sky-300" />}
                title="Meet retirement target"
                value={milestones.crossTargetAge ? `Age ${milestones.crossTargetAge}` : "Not reached"}
                tone={milestones.crossTargetAge ? "good" : "neutral"}
              />
            </div>
          )}
        </SectionCard>

        {/* Inputs + scenario controls */}
        <div className="space-y-5">
          <SectionCard title="Inputs">
            <InputGroup label="Current age">
              <NumInput
                value={inputs.current_age}
                min={18}
                max={75}
                onChange={(v) => setInputs((p) => ({ ...p, current_age: clamp(v, 18, 75) }))}
              />
            </InputGroup>

            <InputGroup label="Planned retirement age">
              <RangeWithNumber
                min={45}
                max={75}
                step={1}
                value={inputs.retirement_age}
                onChange={(v) => setInputs((p) => ({ ...p, retirement_age: v }))}
              />
            </InputGroup>

            <InputGroup label="Target retirement income (today’s $)">
              <CurrencyInput
                value={inputs.target_income_today ?? 0}
                onChange={(v) => setInputs((p) => ({ ...p, target_income_today: Math.max(0, v) }))}
                placeholder="$60,000"
              />
            </InputGroup>

            <InputGroup label="Annual contribution">
              <CurrencyInput
                value={inputs.annual_contribution}
                onChange={(v) => setInputs((p) => ({ ...p, annual_contribution: Math.max(0, v) }))}
                hint="Sum across all accounts; grows with inflation if enabled"
              />
            </InputGroup>

            <div className="grid grid-cols-2 gap-3">
              <InputGroup label="Expected return (nominal)">
                <PercentInput
                  value={inputs.expected_return_pct}
                  onChange={(v) => setInputs((p) => ({ ...p, expected_return_pct: clamp(v, -5, 15) }))}
                />
              </InputGroup>
              <InputGroup label="Inflation">
                <PercentInput
                  value={inputs.inflation_pct}
                  onChange={(v) => setInputs((p) => ({ ...p, inflation_pct: clamp(v, 0, 8) }))}
                />
              </InputGroup>
            </div>

            <InputGroup label="Contributions grow with inflation">
              <Toggle
                value={!!inputs.contribution_grows_with_inflation}
                onChange={(v) => setInputs((p) => ({ ...p, contribution_grows_with_inflation: v }))}
              />
            </InputGroup>

            <InputGroup label="Lifestyle target">
              <Select
                value={inputs.lifestyle}
                onChange={(v) => setInputs((p) => ({ ...p, lifestyle: v }))}
                options={[{ v: "basic", t: "Basic" }, { v: "comfortable", t: "Comfortable" }, { v: "wealthy", t: "Wealthy" }]}
              />
            </InputGroup>

            <InputGroup label="Optional business sale (one-time)">
              <div className="grid grid-cols-2 gap-2">
                <CurrencyInput
                  value={inputs.business_sale_value}
                  onChange={(v) => setInputs((p) => ({ ...p, business_sale_value: Math.max(0, v) }))}
                  placeholder="$0"
                />
                <NumInput
                  value={inputs.business_sale_age}
                  onChange={(v) => setInputs((p) => ({ ...p, business_sale_age: v }))}
                />
              </div>
            </InputGroup>
          </SectionCard>

          <SectionCard title="Scenario controls">
            <AuxTabs value={auxTab} onChange={setAuxTab} tabs={[{ id: "stress", label: "Stress Testing" }, { id: "advanced", label: "Advanced" }]} />
            {auxTab === "stress" ? (
              <div className="pt-3">
                <StressToggle
                  icon={<AlertTriangle size={14} className="text-rose-300" />}
                  title="Market shock"
                  sub="Simulate a near-term downturn"
                  value={stress.marketShock}
                  onChange={(v) => setStress((s) => ({ ...s, marketShock: v }))}
                  badge="-2.5% return"
                />
                <StressToggle
                  icon={<ThermometerSun size={14} className="text-amber-300" />}
                  title="High inflation"
                  sub="Persistent inflation environment"
                  value={stress.highInflation}
                  onChange={(v) => setStress((s) => ({ ...s, highInflation: v }))}
                  badge="≥5% inflation"
                />
                <StressToggle
                  icon={<PauseCircle size={14} className="text-white/70" />}
                  title="Pause contributions (12m)"
                  sub="Temporary contribution break"
                  value={stress.pauseContrib12m}
                  onChange={(v) => setStress((s) => ({ ...s, pauseContrib12m: v }))}
                  badge="12m"
                />
                <div className="text-[11px] text-white/45 mt-2">
                  These approximations adjust inputs before running the projection. For fine-grained, 1-year shocks we’ll need a multi-period engine.
                </div>
              </div>
            ) : (
              <div className="pt-3 grid grid-cols-2 gap-3">
                <InputMini label="Volatility (stdev)" suffix="%">
                  <NumInput
                    value={inputs.return_volatility_pct}
                    onChange={(v) => setInputs((p) => ({ ...p, return_volatility_pct: clamp(v, 0, 50) }))}
                  />
                </InputMini>
                <InputMini label="Trials">
                  <NumInput
                    value={inputs.monte_carlo_trials}
                    onChange={(v) => setInputs((p) => ({ ...p, monte_carlo_trials: clamp(v, 100, 5000) }))}
                  />
                </InputMini>
                <div className="col-span-2 text-[11px] text-white/45">
                  Higher volatility widens the p10/p90 cone; more trials tighten the Monte Carlo accuracy.
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

/* ------------------ UI helpers ------------------ */
function SectionCard({ title, children }) {
  return (
    <div
      className="rounded-2xl border p-3 sm:p-4"
      style={{ borderColor: SECTION_BORDER, background: SECTION_BG, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.02)" }}
    >
      {title && <div className="text-xs uppercase tracking-[0.35em] text-white/55 mb-3">{title}</div>}
      {children}
    </div>
  );
}

function InputGroup({ label, children }) {
  return (
    <div className="mb-3">
      <div className="text-xs text-white/70 mb-1">{label}</div>
      {children}
    </div>
  );
}
function InputMini({ label, suffix, children }) {
  return (
    <div>
      <div className="text-[11px] text-white/60 mb-1 flex items-center gap-1">
        {label} {suffix && <span className="opacity-60">{suffix}</span>}
      </div>
      {children}
    </div>
  );
}
function StressToggle({ title, sub, value, onChange, icon, badge }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`w-full text-left rounded-xl border px-3 py-2 mb-2 transition ${
        value ? "border-[#C084FC] bg-[#C084FC]/10" : "border-white/10 bg-white/[0.04] hover:bg-white/[0.06]"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <div className="text-sm text-white/90">{title}</div>
            <div className="text-[11px] text-white/55">{sub}</div>
          </div>
        </div>
        <div className={`text-[10px] px-2 py-0.5 rounded-full ${value ? "bg-[#C084FC]/30 text-white/90" : "bg-white/10 text-white/70"}`}>
          {badge}
        </div>
      </div>
    </button>
  );
}

function AuxTabs({ value, onChange, tabs }) {
  return (
    <div className="inline-flex items-center rounded-full border border-white/10 bg-white/5 p-0.5">
      {tabs.map((tab) => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange?.(tab.id)}
            className={`px-3 py-1 text-xs font-medium rounded-full transition ${
              active ? "bg-[#C084FC]/20 text-white" : "text-white/60"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function buildLocalProjection(inputs) {
  const startAge = Number(inputs.current_age || 35);
  const retireAge = Number(inputs.retirement_age || 65);
  const endAge = retireAge + 15;
  const annualContribution = Number(inputs.annual_contribution || 12000);
  const expectedReturn = Number(inputs.expected_return_pct ?? 6) / 100;
  const inflation = Number(inputs.inflation_pct ?? 2.5) / 100;
  const realReturn = (1 + expectedReturn) / (1 + inflation) - 1;
  const volatility = Number(inputs.return_volatility_pct ?? 12) / 100;
  const targetIncome = Number(inputs.target_income_today || 60000);
  const nestEggTarget = targetIncome * 25;
  let balance = Number(inputs.current_savings || 150000);
  let p10 = balance;
  let p90 = balance;
  const series = [];
  const targetSeries = [];
  const bandSeries = [];

  for (let age = startAge; age <= endAge; age += 1) {
    if (age > startAge) {
      balance = balance * (1 + realReturn) + annualContribution;
      p10 = p10 * (1 + (realReturn - volatility / 2)) + annualContribution;
      p90 = p90 * (1 + (realReturn + volatility / 2)) + annualContribution;
    }
    series.push({ age, balance });
    const target = age < retireAge
      ? (nestEggTarget * (age - startAge)) / Math.max(1, retireAge - startAge)
      : nestEggTarget;
    targetSeries.push({ age, target });
    bandSeries.push({ age, p10, p50: balance, p90 });
  }

  const projectedBalance = balance;
  const surplus = projectedBalance - nestEggTarget;
  const surplusPct = nestEggTarget ? (surplus / nestEggTarget) * 100 : 0;
  const probability = Math.max(0, Math.min(1, 0.55 + surplusPct / 400));

  return {
    series,
    targetSeries,
    bandSeries,
    results: {
      projected_balance: projectedBalance,
      surplus,
      surplus_pct: surplusPct,
      required_monthly_adjustment: -surplus / Math.max(1, (retireAge - startAge) * 12),
      probability_of_success: probability,
      status: surplus >= 0 ? "surplus" : "shortfall",
    },
  };
}
function Milestone({ icon, title, value, tone = "neutral" }) {
  const toneClass =
    tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-white/70";
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3 flex items-center gap-2">
      <div className={toneClass}>{icon}</div>
      <div className="flex-1">
        <div className="text-sm text-white/90">{title}</div>
        <div className="text-[12px] text-white/60">{value}</div>
      </div>
    </div>
  );
}
function NumInput({ value, onChange, min, max, placeholder }) {
  return (
    <input
      type="number"
      inputMode="numeric"
      value={value ?? ""}
      placeholder={placeholder}
      className="w-full text-sm px-3 py-2 rounded-xl bg-white/5 border border-white/10 outline-none focus:ring-2 focus:ring-[#C084FC]/40 focus:border-[#C084FC]/60"
      min={min}
      max={max}
      onChange={(e) => onChange?.(Number(e.target.value))}
      aria-label="Number input"
    />
  );
}
function CurrencyInput({ value, onChange, placeholder, hint }) {
  return (
    <div>
      <div className="flex items-center">
        <span className="px-2 py-2 rounded-l-xl border border-white/10 bg-white/5 text-white/70">$</span>
        <input
          type="number"
          inputMode="decimal"
          value={value ?? ""}
          placeholder={placeholder}
          className="w-full text-sm px-3 py-2 rounded-r-xl bg-white/5 border border-white/10 border-l-0 outline-none focus:ring-2 focus:ring-[#C084FC]/40 focus:border-[#C084FC]/60"
          onChange={(e) => onChange?.(Number(e.target.value))}
          aria-label="Currency input"
        />
      </div>
      {hint && <div className="mt-1 text-[11px] text-white/50">{hint}</div>}
    </div>
  );
}
function PercentInput({ value, onChange }) {
  return (
    <div className="flex items-center">
      <input
        type="number"
        inputMode="decimal"
        value={value ?? ""}
        className="w-full text-sm px-3 py-2 rounded-l-xl bg-white/5 border border-white/10 outline-none focus:ring-2 focus:ring-[#C084FC]/40 focus:border-[#C084FC]/60"
        onChange={(e) => onChange?.(Number(e.target.value))}
        aria-label="Percent input"
      />
      <span className="px-2 py-2 rounded-r-xl border border-white/10 bg-white/5 text-white/70">%</span>
    </div>
  );
}
function RangeWithNumber({ value, onChange, min = 0, max = 100, step = 1 }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        className="flex-1 accent-[#C084FC]"
        onChange={(e) => onChange?.(Number(e.target.value))}
        aria-label="Range input"
      />
      <input
        type="number"
        className="w-16 text-sm px-2 py-1 rounded-md bg-white/5 border border-white/10 text-center"
        value={value}
        onChange={(e) => onChange?.(Number(e.target.value))}
        aria-label="Number input"
      />
    </div>
  );
}
function Toggle({ value, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange?.(!value)}
      className={`inline-flex items-center w-11 h-6 rounded-full border border-white/10 transition-colors ${
        value ? "bg-[#C084FC]/40" : "bg-white/10"
      }`}
      aria-pressed={value}
      aria-label="Toggle"
    >
      <span
        className={`inline-block w-5 h-5 transform rounded-full bg-white/90 transition-transform ${
          value ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  );
}
function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      className="w-full text-sm px-3 py-2 rounded-xl bg-white/5 border border-white/10 outline-none focus:ring-2 focus:ring-[#C084FC]/40 focus:border-[#C084FC]/60"
      aria-label="Select"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.t}
        </option>
      ))}
    </select>
  );
}
function SectionTitle({ title }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-medium text-white/90">{title}</h3>
    </div>
  );
}
function ResultTile({ title, value, sub, tone }) {
  return (
    <div className="rounded-xl border border-white/12 bg-white/[0.03] p-3 backdrop-blur-sm">
      <div className="text-[10px] uppercase tracking-[0.2em] text-white/45 mb-1">{title}</div>
      <div className={`text-base font-semibold ${tone || "text-white"}`}>{value}</div>
      {sub && <div className="text-[11px] text-white/55 mt-0.5">{sub}</div>}
    </div>
  );
}
function QuickPrompt({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-xs px-3 py-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-[#C084FC] flex items-center gap-1"
    >
      <HelpCircle size={14} className="opacity-70" /> {label}
    </button>
  );
}
function pickEditableInputs(apiInputs) {
  const allow = [
    "current_age",
    "retirement_age",
    "current_savings",
    "annual_contribution",
    "monthly_contribution",
    "expected_return_pct",
    "inflation_pct",
    "lifestyle",
    "target_income_today",
    "business_sale_value",
    "business_sale_age",
    "contribution_grows_with_inflation",
    "return_volatility_pct",
    "monte_carlo_trials",
  ];
  const out = {};
  for (const k of allow) if (apiInputs[k] !== undefined) out[k] = apiInputs[k];
  if (apiInputs.contrib_annual != null && out.annual_contribution == null)
    out.annual_contribution = apiInputs.contrib_annual;
  return out;
}
