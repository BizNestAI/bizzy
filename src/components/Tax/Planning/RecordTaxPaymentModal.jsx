import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { formatDate, formatMoney, labelize, paymentSourceLabel, paymentStatusLabel, paymentTypeLabel, PAYMENT_SOURCES, PAYMENT_TYPES, US_STATES } from "./taxPlanningDisplay.js";

export default function RecordTaxPaymentModal({
  open,
  year,
  saving,
  existingRows = [],
  historyLoading,
  projectedRemainingLiability = null,
  onClose,
  onSave,
  onVoid,
}) {
  const [form, setForm] = useState(() => initialForm(year));
  const submitIdempotencyKey = useRef(null);
  const errors = useMemo(() => validatePayment(form), [form]);
  const warnings = useMemo(() => paymentWarnings(form, { year, existingRows, projectedRemainingLiability }), [form, year, existingRows, projectedRemainingLiability]);
  const manualRows = useMemo(() => manualPaymentRows(existingRows), [existingRows]);
  const canSave = !Object.keys(errors).length && !saving;
  useEffect(() => {
    if (!open) {
      setForm(initialForm(year));
      submitIdempotencyKey.current = null;
    }
  }, [open, year]);
  if (!open) return null;

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const save = () => {
    if (!canSave) return;
    if (!submitIdempotencyKey.current) submitIdempotencyKey.current = createPaymentIdempotencyKey();
    onSave?.({
      jurisdiction: form.jurisdiction,
      stateCode: form.jurisdiction === "state" ? form.stateCode : null,
      paymentType: form.paymentType,
      paymentDate: form.paymentDate,
      amount: Number(form.amount),
      taxYear: Number(form.taxYear),
      year: Number(form.taxYear),
      source: form.source,
      status: "posted",
      idempotencyKey: submitIdempotencyKey.current,
      metadata: {
        quarter: form.quarter || null,
        taxType: form.taxType || null,
        confirmationNumber: form.confirmationNumber || null,
        notes: form.notes || null,
      },
    });
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center px-4 py-8" role="dialog" aria-modal="true" aria-labelledby="record-tax-payment-title">
      <button type="button" aria-label="Close record payment modal" className="absolute inset-0 bg-black/62" onClick={onClose} />
      <section className="relative flex max-h-[min(760px,calc(100vh-96px))] w-full max-w-[720px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080b0f] text-white shadow-[0_24px_90px_rgba(0,0,0,0.68)]">
        <header className="border-b border-white/10 px-4 py-3.5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Tax payment</div>
              <h2 id="record-tax-payment-title" className="mt-1 text-lg font-semibold">Record payment</h2>
          <p className="mt-1 text-xs text-white/54">This records tax payment history only. Bizzi does not move money.</p>
          <div className="mt-2 inline-flex rounded-full border border-emerald-200/18 bg-emerald-300/[0.08] px-2.5 py-1 text-[11px] font-semibold text-emerald-50">
            Status: Confirmed from manual entry
          </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field label="Jurisdiction" error={errors.jurisdiction}>
              <select value={form.jurisdiction} onChange={(event) => update("jurisdiction", event.target.value)} className={inputClass()}>
                <option value="federal">Federal</option>
                <option value="state">State</option>
                <option value="local">Local/county</option>
                <option value="entity_pte">Entity/PTE</option>
                <option value="other">Other supported jurisdiction</option>
              </select>
            </Field>
            {form.jurisdiction === "state" ? (
              <Field label="State" error={errors.stateCode}>
                <select value={form.stateCode} onChange={(event) => update("stateCode", event.target.value)} className={inputClass()}>
                  <option value="">Select state</option>
                  {US_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
                </select>
              </Field>
            ) : null}
            <Field label="Payment type" error={errors.paymentType}>
              <select value={form.paymentType} onChange={(event) => update("paymentType", event.target.value)} className={inputClass()}>
                {PAYMENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Tax type">
              <input value={form.taxType} onChange={(event) => update("taxType", event.target.value)} placeholder="Income tax, PTET, entity tax..." className={inputClass()} />
            </Field>
            <Field label="Payment date" error={errors.paymentDate}>
              <input type="date" value={form.paymentDate} onChange={(event) => update("paymentDate", event.target.value)} className={inputClass()} />
            </Field>
            <Field label="Amount" error={errors.amount}>
              <input type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => update("amount", event.target.value)} className={inputClass()} />
            </Field>
            <Field label="Tax year" error={errors.taxYear}>
              <input type="number" min="2000" max="2100" value={form.taxYear} onChange={(event) => update("taxYear", event.target.value)} className={inputClass()} />
            </Field>
            <Field label="Quarter / period" error={errors.quarter}>
              <select value={form.quarter} onChange={(event) => update("quarter", event.target.value)} className={inputClass()}>
                <option value="">Not applicable</option>
                <option value="Q1">Q1</option>
                <option value="Q2">Q2</option>
                <option value="Q3">Q3</option>
                <option value="Q4">Q4</option>
                <option value="extension">Extension</option>
                <option value="annual">Annual</option>
              </select>
            </Field>
            <Field label="Source">
              <select value={form.source} onChange={(event) => update("source", event.target.value)} className={inputClass()}>
                {PAYMENT_SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Confirmation / reference number">
              <input value={form.confirmationNumber} onChange={(event) => update("confirmationNumber", event.target.value)} className={inputClass()} />
            </Field>
            <label className="block sm:col-span-2">
              <span className="text-[11px] font-semibold text-white/70">Notes</span>
              <textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} rows={2} className={inputClass()} />
            </label>
          </div>

          <section id="tax-payment-history" className="mt-4 rounded-[16px] border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/42">Payment history</div>
                <h3 className="mt-1 text-sm font-semibold text-white">Manually logged payments</h3>
                <p className="mt-1 text-xs leading-relaxed text-white/50">
                  Confirmed compatible records reduce remaining liability and update reserve planning after the tax overview refreshes.
                </p>
              </div>
              {historyLoading ? <span className="shrink-0 text-xs text-white/44">Loading...</span> : null}
            </div>

            <div className="mt-3 space-y-2">
              {manualRows.length ? manualRows.map((row) => (
                <div key={row.id || `${row.paymentDate}-${row.amount}-${row.paymentType}`} className="rounded-[14px] border border-white/[0.07] bg-black/[0.16] px-3 py-2.5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white/86">
                        {formatMoney(row.amount)} · {paymentTypeLabel(row.paymentType)}
                      </div>
                      <div className="mt-1 text-xs text-white/52">
                        {formatDate(row.paymentDate)} · {labelize(row.jurisdiction)}{row.stateCode ? ` ${row.stateCode}` : ""} · {row.metadata?.quarter || row.quarter || "No period"}
                      </div>
                      <div className="mt-1 text-xs text-white/42">
                        {paymentSourceLabel(row.source)} · {paymentStatusLabel(row.status)}
                      </div>
                      {row.metadata?.notes || row.notes ? (
                        <div className="mt-1.5 text-xs leading-relaxed text-white/52">{row.metadata?.notes || row.notes}</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={!row.id || row.status === "void"}
                      onClick={() => onVoid?.(row)}
                      className="self-start rounded-full border border-white/10 bg-black/18 px-2.5 py-1 text-xs font-semibold text-white/58 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Void
                    </button>
                  </div>
                </div>
              )) : (
                <div className="rounded-[14px] border border-white/[0.07] bg-black/[0.16] px-3 py-4 text-center text-xs text-white/52">
                  No manually logged tax payments yet.
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="border-t border-white/10 px-4 py-3">
          {warnings.length ? (
            <div className="mb-3 space-y-2">
              {warnings.map((warning) => (
                <div key={warning} className="flex gap-2 rounded-[14px] border border-amber-300/18 bg-amber-300/[0.07] px-3 py-2 text-xs leading-relaxed text-amber-50/86">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-full border border-white/10 bg-black/18 px-3 py-1.5 text-xs font-semibold text-white/64 hover:bg-white/10 hover:text-white">Cancel</button>
            <button type="button" disabled={!canSave} onClick={save} className="rounded-full bg-emerald-300 px-4 py-1.5 text-xs font-semibold text-[#06100c] hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? "Saving..." : "Record payment"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function manualPaymentRows(rows = []) {
  return (rows || []).filter((row) => {
    const source = String(row.source || "").toLowerCase();
    return !source || source === "manual" || source === "manually_entered";
  });
}

function createPaymentIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `tax-payment:${crypto.randomUUID()}`;
  return `tax-payment:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function initialForm(year) {
  return {
    jurisdiction: "federal",
    stateCode: "",
    paymentType: "estimated_payment",
    taxType: "",
    paymentDate: new Date().toISOString().slice(0, 10),
    amount: "",
    taxYear: year || new Date().getFullYear(),
    quarter: "",
    source: "manual",
    confirmationNumber: "",
    notes: "",
  };
}

function validatePayment(form) {
  const errors = {};
  if (!["federal", "state", "local", "entity_pte", "other"].includes(form.jurisdiction)) errors.jurisdiction = "Choose a supported jurisdiction.";
  if (form.jurisdiction === "state" && !form.stateCode) errors.stateCode = "State is required for state payments.";
  if (!PAYMENT_TYPES.some(([value]) => value === form.paymentType)) errors.paymentType = "Choose a supported payment type.";
  if (!form.paymentDate || Number.isNaN(new Date(form.paymentDate).getTime())) errors.paymentDate = "Enter a valid date.";
  if (!Number.isFinite(Number(form.amount)) || Number(form.amount) <= 0) errors.amount = "Amount must be greater than zero.";
  if (!Number.isInteger(Number(form.taxYear)) || Number(form.taxYear) < 2000 || Number(form.taxYear) > 2100) errors.taxYear = "Enter a valid tax year.";
  if (form.paymentType === "estimated_payment" && !form.quarter) errors.quarter = "Choose the estimate period.";
  return errors;
}

function paymentWarnings(form, { year, existingRows, projectedRemainingLiability }) {
  const warnings = [];
  const amount = Number(form.amount);
  if (Number(form.taxYear) !== Number(year)) {
    warnings.push("This payment is for a different tax year and will not reduce the current-year liability unless recorded as a valid carry-forward credit.");
  }
  if (form.paymentType === "balance_due_payment" && Number(form.taxYear) !== Number(year)) {
    warnings.push("A prior-year balance-due payment is kept in history but does not reduce current-year projected liability.");
  }
  if (["local", "entity_pte", "other"].includes(form.jurisdiction)) {
    warnings.push("This jurisdiction is saved for history, but Bizzi will not apply it to federal or state remaining liability until a compatible component is supported.");
  }
  if (Number.isFinite(amount) && projectedRemainingLiability != null && amount > Number(projectedRemainingLiability)) {
    warnings.push("This payment is larger than the current projected remaining liability. Bizzi will preserve any projected overpayment instead of discarding it.");
  }
  const duplicate = existingRows.some((row) => (
    String(row.status || "posted").toLowerCase() !== "void" &&
    Number(row.amount) === amount &&
    String(row.paymentDate || row.payment_date).slice(0, 10) === form.paymentDate &&
    String(row.jurisdiction) === form.jurisdiction &&
    String(row.stateCode || row.state_code || "") === (form.jurisdiction === "state" ? form.stateCode : "") &&
    String(row.paymentType || row.payment_type) === form.paymentType
  ));
  if (duplicate) warnings.push("A similar tax payment already exists. Saving this record may create a pending-review duplicate.");
  return warnings;
}

function Field({ label, error, children }) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-white/70">{label}</span>
      <div className="mt-1">{children}</div>
      {error ? <div className="mt-1 text-xs text-rose-100">{error}</div> : null}
    </label>
  );
}

function inputClass() {
  return "w-full rounded-[11px] border border-white/10 bg-[#0f1115] px-3 py-1.5 text-xs text-white outline-none focus:ring-2 focus:ring-emerald-300/35";
}
