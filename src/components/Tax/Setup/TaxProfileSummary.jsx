import React from "react";
import {
  ACCOUNTING_METHOD_OPTIONS,
  FILING_STATUS_OPTIONS,
  SAFE_HARBOR_OPTIONS,
  TAX_PROFILE_FIELDS,
  TAX_PROFILE_SOURCE_LABELS,
  optionLabel,
} from "./taxProfileFields.js";
import { validateTaxSetup } from "./taxSetupValidation.js";

const OPTION_SETS = {
  filing_status: FILING_STATUS_OPTIONS,
  accounting_method: ACCOUNTING_METHOD_OPTIONS,
  safe_harbor_method: SAFE_HARBOR_OPTIONS,
};

export default function TaxProfileSummary({ values, confirmedFields = new Set(), suggestions = {}, memoryValues = {} }) {
  const errors = validateTaxSetup(values);
  const missing = Object.entries(errors);
  const rows = [
    "entity_type", "tax_election", "filing_status", "primary_tax_state", "accounting_method",
    "qbi_eligible", "self_employment_tax_applies", "safe_harbor_method", "prior_year_total_tax",
    "prior_year_agi", "owner_reasonable_salary", "owner_w2_wages_ytd", "federal_withholding_ytd",
    "state_withholding_ytd", "reserve_buffer_percent",
  ].filter((key) => key in TAX_PROFILE_FIELDS);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
        <h3 className="text-sm font-semibold text-white">Confirmed profile values</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {rows.map((key) => (
            <SummaryRow
              key={key}
              label={TAX_PROFILE_FIELDS[key].label}
              value={displayValue(key, values[key])}
              source={confirmedFields.has(key) ? "user" : suggestions[key] ? "system" : "missing"}
            />
          ))}
        </div>
      </div>
      {missing.length ? (
        <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] p-4 text-sm text-amber-50/86">
          <div className="font-semibold text-amber-50">Estimate readiness still needs attention</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {missing.map(([field, message]) => <li key={field}>{message}</li>)}
          </ul>
        </div>
      ) : (
        <div className="rounded-2xl border border-emerald-300/18 bg-emerald-300/[0.07] p-4 text-sm text-emerald-50/84">
          Profile inputs are ready to save. Bizzi will still treat backend validation as authoritative.
        </div>
      )}
      {Object.keys(memoryValues).length ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
          <h3 className="text-sm font-semibold text-white">Optional tax memory</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {Object.entries(memoryValues).map(([key, value]) => (
              <SummaryRow key={key} label={memoryLabel(key)} value={displayMemory(value)} source="user" />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value, source }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white/88">{value || "Missing"}</div>
      <div className="mt-1 text-[11px] text-white/46">{TAX_PROFILE_SOURCE_LABELS[source] || source}</div>
    </div>
  );
}

function displayValue(key, value) {
  if (key === "qbi_eligible" || key === "self_employment_tax_applies") return value === true ? "Yes" : value === false ? "No" : "I'm not sure";
  if (value == null || value === "") return null;
  if (key.endsWith("_ytd") || key.startsWith("prior_year") || key === "owner_reasonable_salary") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value || 0));
  }
  if (key === "reserve_buffer_percent") return `${Number(value)}%`;
  return optionLabel(OPTION_SETS[key], value) || String(value).replaceAll("_", " ");
}

function memoryLabel(key) {
  return String(key).replaceAll("_", " ");
}

function displayMemory(value) {
  if (value == null || value === "") return "Missing";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
