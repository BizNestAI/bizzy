// File: /src/components/Accounting/AffordabilityInputForm.jsx
import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

/** Canonical frequency values expected by the backend */
const FREQ_OPTIONS = [
  { label: 'One-time',  value: 'one-time' },
  { label: 'Monthly',   value: 'monthly' },
  { label: 'Weekly',    value: 'weekly' },
  { label: 'Bi-weekly', value: 'bi-weekly' },
  { label: 'Quarterly', value: 'quarterly' },
  { label: 'Annual',    value: 'annually' }, // backend also accepts "yearly"
];

function toIsoDateOrToday(v) {
  if (v) return v;
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function monthlyImpact(amount, frequency) {
  const a = Number(amount) || 0;
  const f = String(frequency || 'one-time').toLowerCase();
  switch (f) {
    case 'monthly':     return a;
    case 'weekly':      return (a * 52) / 12;
    case 'bi-weekly':   return (a * 26) / 12;
    case 'biweekly':    return (a * 26) / 12;
    case 'quarterly':   return a / 3;
    case 'annually':
    case 'yearly':      return a / 12;
    case 'one-time':
    default:            return 0; // handled as one-time separately
  }
}

const currency = (n) =>
  typeof n === 'number'
    ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '-';

export default function AffordabilityInputForm({ onSubmit, isLoading = false, disabled = false }) {
  const [expenseName, setExpenseName] = useState('');
  const [amount, setAmount]           = useState('');
  const [frequency, setFrequency]     = useState('one-time'); // canonical value
  const [startDate, setStartDate]     = useState('');
  const [notes, setNotes]             = useState('');

  const [errors, setErrors]           = useState({});

  const monthlyPreview = useMemo(
    () => Math.round(monthlyImpact(amount, frequency)),
    [amount, frequency]
  );

  const oneTimePreview = useMemo(
    () => (String(frequency).toLowerCase() === 'one-time' ? Math.round(Number(amount) || 0) : 0),
    [amount, frequency]
  );

  const validate = () => {
    const e = {};
    if (!expenseName.trim()) e.expenseName = 'Please enter an expense name.';
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) e.amount = 'Please enter a positive number.';
    if (!frequency) e.frequency = 'Please choose a frequency.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    onSubmit({
      expenseName: expenseName.trim(),
      amount: Number(amount),
      frequency,                               // canonical lowercase value
      startDate: toIsoDateOrToday(startDate),  // ISO (YYYY-MM-DD)
      notes: notes?.trim() || '',
    });
  };

  const reset = () => {
    setExpenseName('');
    setAmount('');
    setFrequency('one-time');
    setStartDate('');
    setNotes('');
    setErrors({});
  };

  const allDisabled = isLoading || disabled;

  return (
    <motion.form
      onSubmit={handleSubmit}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-6 rounded-2xl border border-white/10 bg-zinc-900 p-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">💵 Can I Afford This?</h2>
        <div className="text-xs text-white/60">
          {monthlyPreview > 0 && (
            <span className="mr-3 rounded-full bg-white/10 px-2.5 py-1">
              Monthly impact: <span className="font-medium">{currency(monthlyPreview)}</span>
            </span>
          )}
          {oneTimePreview > 0 && (
            <span className="rounded-full bg-white/10 px-2.5 py-1">
              One-time: <span className="font-medium">{currency(oneTimePreview)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Expense Name */}
      <div>
        <label className="mb-1 block text-sm text-white/80">Expense Name *</label>
        <input
          type="text"
          value={expenseName}
          onChange={(e) => setExpenseName(e.target.value)}
          placeholder="e.g., Hire a project manager"
          disabled={allDisabled}
          className={`w-full rounded-lg border bg-zinc-800 px-4 py-2 text-white outline-none transition focus:ring
            ${errors.expenseName ? 'border-rose-400/60 focus:ring-rose-400/40' : 'border-white/15 focus:border-emerald-300/40 focus:ring-emerald-400/20'}`}
        />
        {errors.expenseName && <p className="mt-1 text-xs text-rose-300">{errors.expenseName}</p>}
      </div>

      {/* Amount */}
      <div>
        <label className="mb-1 block text-sm text-white/80">Amount (USD) *</label>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="e.g., 4500"
          disabled={allDisabled}
          className={`w-full rounded-lg border bg-zinc-800 px-4 py-2 text-white outline-none transition focus:ring
            ${errors.amount ? 'border-rose-400/60 focus:ring-rose-400/40' : 'border-white/15 focus:border-emerald-300/40 focus:ring-emerald-400/20'}`}
        />
        {errors.amount && <p className="mt-1 text-xs text-rose-300">{errors.amount}</p>}
      </div>

      {/* Frequency (segmented) */}
      <div>
        <label className="mb-2 block text-sm text-white/80">Frequency *</label>
        <div className="flex flex-wrap gap-2">
          {FREQ_OPTIONS.map((opt) => {
            const active = frequency === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={allDisabled}
                onClick={() => setFrequency(opt.value)}
                className={`rounded-xl border px-3 py-1.5 text-sm transition
                  ${active
                    ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200'
                    : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {errors.frequency && <p className="mt-1 text-xs text-rose-300">{errors.frequency}</p>}
      </div>

      {/* Start Date */}
      <div>
        <label className="mb-1 block text-sm text-white/80">Start Date</label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          disabled={allDisabled}
          className="w-full rounded-lg border border-white/15 bg-zinc-800 px-4 py-2 text-white outline-none transition focus:border-emerald-300/40 focus:ring focus:ring-emerald-400/20"
        />
      </div>

      {/* Notes */}
      <div>
        <label className="mb-1 block text-sm text-white/80">Optional Notes</label>
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g., Planning ahead for a large November job"
          disabled={allDisabled}
          className="w-full rounded-lg border border-white/15 bg-zinc-800 px-4 py-2 text-white outline-none transition focus:border-emerald-300/40 focus:ring focus:ring-emerald-400/20"
        />
      </div>

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={reset}
          disabled={allDisabled}
          className="rounded-xl border border-white/10 px-4 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"
        >
          Reset
        </button>

        <button
          type="submit"
          disabled={allDisabled}
          className="inline-flex items-center justify-center rounded-xl bg-emerald-500/90 px-4 py-2 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {isLoading ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing…</>) : 'Check Affordability'}
        </button>
      </div>

      {/* Tiny helper line */}
      <p className="text-xs text-white/40">
        We’ll assess this against your forecasted cash flow. Frequency is normalized to Bizzy’s backend format.
      </p>
    </motion.form>
  );
}
