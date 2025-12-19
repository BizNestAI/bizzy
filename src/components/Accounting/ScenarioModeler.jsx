// File: /components/Accounting/ScenarioModeler.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { motion } from 'framer-motion';
import ScenarioComparisonChart from './ScenarioComparisonChart';
import { generateScenarioForecast } from '../../utils/generateScenarioForecast.js';
import {
  saveScenarioToSupabase,
  loadUserScenarios,
  loadScenarioItems,
} from '../../services/accounting/scenarioService.js';

const TYPE_OPTIONS = [
  { value: 'revenue',      label: 'Revenue (+$)' },
  { value: 'revenue_pct',  label: 'Revenue (+%)' },
  { value: 'expense',      label: 'Expense (+$)' },
  { value: 'expense_pct',  label: 'Expense (+%)' },
  { value: 'investment',   label: 'Investment (+$ cash-in)' },
  { value: 'loan',         label: 'Loan (+$ out)' },
  { value: 'one_time',     label: 'One-time expense (+$)' },
];

const MOCK_BASELINE = [
  { month: '2025-08', net_cash: 12000 },
  { month: '2025-09', net_cash: 11500 },
  { month: '2025-10', net_cash: 11000 },
  { month: '2025-11', net_cash: 10500 },
  { month: '2025-12', net_cash: 10000 },
  { month: '2026-01', net_cash:  9500 },
  { month: '2026-02', net_cash:  9000 },
  { month: '2026-03', net_cash:  8500 },
  { month: '2026-04', net_cash:  8000 },
  { month: '2026-05', net_cash:  7500 },
  { month: '2026-06', net_cash:  7000 },
  { month: '2026-07', net_cash:  6500 },
];

/** Ensure baseline rows include revenue/expenses so the util can recompute net/ending cash. */
function prepareBaseline(baseline) {
  const rows = (Array.isArray(baseline) && baseline.length ? baseline : MOCK_BASELINE).map((r) => {
    const month = r.month || r.month_label; // util can convert label → YYYY-MM, but prefer month
    const haveFlows = Number.isFinite(+r.cash_in) || Number.isFinite(+r.cash_out) || Number.isFinite(+r.revenue) || Number.isFinite(+r.expenses);
    if (haveFlows) return { ...r, month };

    // fabricate flows from net_cash so scenario math still works
    const net = Number(r.net_cash) || 0;
    const baseRev = Math.max(0, net) + 10000; // arbitrary cushion so revenue >= 0
    const baseExp = baseRev - net;
    return {
      ...r,
      month,
      revenue: baseRev,
      expenses: baseExp,
    };
  });

  // Ensure month key exists
  return rows.filter((r) => r.month);
}

/** Normalize percent types: UI accepts 10 → 0.10 for *_pct */
function normalizeAmountForType(type, amount) {
  const n = Number(amount) || 0;
  if (type.endsWith('_pct')) {
    // if user typed 10 (meaning 10%), convert to 0.10; if they already typed 0.1, keep it
    return n > 1 ? n / 100 : n;
  }
  return n;
}

const ScenarioModeler = ({ baselineForecast = [], userId, businessId }) => {
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioItems, setScenarioItems] = useState([]);
  const [scenarioForecast, setScenarioForecast] = useState([]);
  const [savedScenarios, setSavedScenarios] = useState([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState('');

  const basePrepared = useMemo(() => prepareBaseline(baselineForecast), [baselineForecast]);

  // Recompute preview whenever items change
  useEffect(() => {
    if (scenarioItems.length) {
      const adjusted = generateScenarioForecast(
        basePrepared,
        scenarioItems.map((it) => ({
          ...it,
          amount: normalizeAmountForType(it.type, it.amount),
        }))
      );
      setScenarioForecast(adjusted);
    } else {
      setScenarioForecast([]);
    }
  }, [scenarioItems, basePrepared]);

  // Load scenario list
  useEffect(() => {
    async function fetchScenarios() {
      if (!userId || !businessId) return;
      const result = await loadUserScenarios(userId, businessId);
      if (result.success) setSavedScenarios(result.scenarios || []);
    }
    fetchScenarios();
  }, [userId, businessId]);

  const handleLoadScenario = async (scenarioId) => {
    setSelectedScenarioId(scenarioId);
    if (!scenarioId) return;
    const selected = savedScenarios.find((s) => s.id === scenarioId);
    const { success, items, error } = await loadScenarioItems(scenarioId);
    if (!success) {
      console.error('Load scenario items failed:', error);
      return;
    }
    // Keep their amounts as stored; UI will show % as 100 * decimal
    const itemsWithUiAmounts = items.map((item) => ({
      ...item,
      id: uuidv4(),
      amount:
        String(item.type).endsWith('_pct') && Number(item.amount) <= 1
          ? Number(item.amount) * 100
          : item.amount,
    }));
    setScenarioName(selected?.scenario_name || '');
    setScenarioItems(itemsWithUiAmounts);
  };

  const addNewItem = () => {
    setScenarioItems((prev) => [
      ...prev,
      {
        id: uuidv4(),
        type: 'expense',
        amount: '',          // number or percent (see UI hint)
        start_month: basePrepared[0]?.month || '',
        end_month: '',
        recurring: true,
        description: '',
      },
    ]);
  };

  const updateItem = (id, field, value) => {
    setScenarioItems((items) => items.map((it) => (it.id === id ? { ...it, [field]: value } : it)));
  };

  const removeItem = (id) => setScenarioItems((items) => items.filter((it) => it.id !== id));

  const handleSave = async () => {
    if (!scenarioName || scenarioItems.length === 0 || !userId || !businessId) return;

    const payload = {
      user_id: userId,
      business_id: businessId,
      scenario_name: scenarioName.trim(),
      scenario_items: scenarioItems.map(({ id, ...rest }) => ({
        ...rest,
        amount: normalizeAmountForType(rest.type, rest.amount),
      })),
    };

    const result = await saveScenarioToSupabase(payload);
    if (result.success) {
      alert('✅ Scenario saved!');
      // refresh list
      const refreshed = await loadUserScenarios(userId, businessId);
      if (refreshed.success) setSavedScenarios(refreshed.scenarios || []);
    } else {
      console.error('❌ Save failed:', result.error);
      alert('Failed to save scenario.');
    }
  };

  return (
    <motion.div
      className="space-y-6 rounded-xl border border-white/10 bg-zinc-900 p-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div>
        <h2 className="text-xl font-semibold text-white">📈 Scenario Modeling Tool</h2>
        <p className="text-sm text-white/70">
          Simulate revenue adjustments, hiring plans, or investments and see the impact on your forecast.
        </p>
      </div>

      {/* Name + Load */}
      <div className="flex flex-col gap-3 md:flex-row">
        <div className="flex-1">
          <label className="text-sm text-white/80">Scenario Name</label>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-white/10 bg-zinc-800 px-3 py-2 text-white"
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            placeholder="e.g., Lean Winter Mode"
          />
        </div>
        <div className="flex-1">
          <label className="text-sm text-white/80">Load Saved Scenario</label>
          <select
            value={selectedScenarioId}
            onChange={(e) => handleLoadScenario(e.target.value)}
            className="mt-1 w-full rounded-md border border-white/10 bg-zinc-800 px-3 py-2 text-white"
          >
            <option value="">-- Select a scenario --</option>
            {(savedScenarios || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.scenario_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Items */}
      {scenarioItems.map((item) => {
        const isPct = String(item.type).endsWith('_pct');
        return (
          <div key={item.id} className="space-y-3 rounded-md border border-white/10 bg-zinc-800 p-4">
            <div className="flex flex-col gap-3 md:flex-row">
              <select
                value={item.type}
                onChange={(e) => updateItem(item.id, 'type', e.target.value)}
                className="rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-white"
              >
                {TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <div className="flex-1">
                <label className="mb-1 block text-xs text-white/60">
                  Amount {isPct ? '(%)' : '($)'} {isPct ? '— enter 10 for +10%' : ''}
                </label>
                <input
                  type="number"
                  step={isPct ? '0.1' : '1'}
                  placeholder={isPct ? 'e.g., 10' : 'e.g., 1500'}
                  value={item.amount}
                  onChange={(e) => updateItem(item.id, 'amount', e.target.value)}
                  className="w-full rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-white/60">Start month</label>
                <input
                  type="month"
                  value={item.start_month || ''}
                  onChange={(e) => updateItem(item.id, 'start_month', e.target.value)}
                  className="rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-white/60">End month (optional)</label>
                <input
                  type="month"
                  value={item.end_month || ''}
                  onChange={(e) => updateItem(item.id, 'end_month', e.target.value)}
                  className="rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-white"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <input
                type="text"
                placeholder="Description"
                value={item.description || ''}
                onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                className="w-full rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-white"
              />
              <div className="ml-4 flex items-center gap-2">
                <label className="text-sm text-white/80">Recurring</label>
                <input
                  type="checkbox"
                  checked={Boolean(item.recurring)}
                  onChange={(e) => updateItem(item.id, 'recurring', e.target.checked)}
                />
                <button
                  onClick={() => removeItem(item.id)}
                  className="ml-4 text-rose-400 hover:underline"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={addNewItem}
          className="rounded-md bg-blue-500 px-4 py-2 font-semibold text-white hover:bg-blue-600"
        >
          + Add Item
        </button>

        <button
          onClick={handleSave}
          disabled={!scenarioName || scenarioItems.length === 0}
          className="rounded-md bg-emerald-500 px-4 py-2 font-semibold text-black hover:bg-emerald-400 disabled:opacity-50"
        >
          💾 Save Scenario
        </button>
      </div>

      {/* Preview */}
      {scenarioForecast.length > 0 && (
        <>
          <ScenarioComparisonChart
            baselineData={basePrepared}
            scenarioData={scenarioForecast}
          />
          {baselineForecast.length === 0 && (
            <p className="mt-1 text-sm text-amber-300">Showing mock baseline — connect accounting to preview with live data.</p>
          )}
        </>
      )}
    </motion.div>
  );
};

export default ScenarioModeler;
