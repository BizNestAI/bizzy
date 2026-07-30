import React from "react";

const MEMORY_FIELDS = [
  {
    key: "vehicle_deduction_method",
    label: "Vehicle deduction method",
    type: "select",
    options: [
      { value: "", label: "Not set" },
      { value: "standard_mileage", label: "Standard mileage" },
      { value: "actual_expense", label: "Actual expense" },
      { value: "undecided", label: "Undecided" },
    ],
  },
  { key: "vehicle_business_use_percent", label: "Vehicle business-use percentage", type: "number", min: 0, max: 100 },
  {
    key: "mileage_tracking_enabled",
    label: "Mileage tracking enabled",
    type: "select",
    options: [
      { value: "", label: "Not set" },
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ],
  },
  {
    key: "home_office_method",
    label: "Home-office method",
    type: "select",
    options: [
      { value: "", label: "Not set" },
      { value: "simplified", label: "Simplified" },
      { value: "actual", label: "Actual" },
      { value: "undecided", label: "Undecided" },
    ],
  },
  { key: "equipment_capitalization_threshold", label: "Equipment capitalization threshold", type: "number", min: 0 },
  {
    key: "de_minimis_safe_harbor_election",
    label: "De minimis safe-harbor election",
    type: "select",
    options: [
      { value: "", label: "Not set" },
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ],
  },
  {
    key: "hsa_eligibility",
    label: "HSA eligibility",
    type: "select",
    options: [
      { value: "", label: "Not set" },
      { value: "eligible", label: "Eligible" },
      { value: "not_eligible", label: "Not eligible" },
      { value: "unknown", label: "I'm not sure" },
    ],
  },
  { key: "retirement_plan_type", label: "Retirement plan type", type: "text" },
  { key: "multi_state_operations", label: "Multi-state operations", type: "text", helpText: "Current estimates may support primary-state tax only." },
  { key: "cpa_notes", label: "CPA notes", type: "textarea", sensitive: true },
];

export default function TaxMemoryFields({ values = {}, onChange, memories = {}, onViewHistory }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 text-sm leading-relaxed text-white/62">
        These fields are optional. Bizzi saves changes as new effective-dated tax memory so history remains available.
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {MEMORY_FIELDS.map((field) => (
          <label key={field.key} className={`rounded-2xl border border-white/10 bg-black/16 p-3 ${field.type === "textarea" ? "sm:col-span-2" : ""}`}>
            <span className="block text-sm font-semibold text-white/84">
              {field.label}
              {field.sensitive ? <span className="ml-2 rounded-full bg-white/8 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-white/46">Sensitive</span> : null}
            </span>
            {renderControl(field, values[field], (value) => onChange?.(field.key, value))}
            {field.helpText ? <span className="mt-1 block text-xs text-amber-100/68">{field.helpText}</span> : null}
            {memories[field.key]?.source ? (
              <span className="mt-1 block text-xs text-white/42">
                Current source: {memories[field.key].source}
                <button type="button" onClick={() => onViewHistory?.(field.key)} className="ml-2 text-emerald-100/80 underline-offset-2 hover:underline">
                  View history
                </button>
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </div>
  );
}

function renderControl(field, value, onChange) {
  const base = "mt-2 w-full rounded-xl border border-white/10 bg-[#0f1115] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-300/35";
  if (field.type === "select") {
    return (
      <select value={serializeSelectValue(value)} onChange={(event) => onChange(deserializeSelectValue(event.target.value))} className={base}>
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  if (field.type === "textarea") {
    return <textarea value={value || ""} onChange={(event) => onChange(event.target.value)} rows={3} className={base} />;
  }
  return (
    <input
      type={field.type}
      min={field.min}
      max={field.max}
      value={value ?? ""}
      onChange={(event) => onChange(field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)}
      className={base}
    />
  );
}

function serializeSelectValue(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return value ?? "";
}

function deserializeSelectValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return value || null;
}
