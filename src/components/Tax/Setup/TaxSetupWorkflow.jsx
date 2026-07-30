import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Loader2, X } from "lucide-react";
import useTaxProfile from "../../../hooks/tax/useTaxProfile.js";
import {
  ACCOUNTING_METHOD_OPTIONS,
  ENTITY_OPTIONS,
  FILING_STATUS_OPTIONS,
  LLC_ELECTION_OPTIONS,
  SAFE_HARBOR_OPTIONS,
  TRI_STATE_OPTIONS,
  US_STATE_OPTIONS,
  isSCorp,
} from "./taxProfileFields.js";
import TaxSetupProgress from "./TaxSetupProgress.jsx";
import TaxSetupStepShell from "./TaxSetupStepShell.jsx";
import TaxProfileSummary from "./TaxProfileSummary.jsx";
import TaxMemoryFields from "./TaxMemoryFields.jsx";
import { nextStepId, previousStepId, stepIndex } from "./taxSetupSteps.js";
import { buildMemoryPayloads, buildTaxProfilePatch, validateTaxSetup } from "./taxSetupValidation.js";
import { saveTaxSetupData } from "./taxSetupSave.js";

const EMPTY_VALUES = {
  entity_type: "",
  tax_election: "",
  filing_status: "",
  primary_tax_state: "",
  accounting_method: "",
  qbi_eligible: null,
  self_employment_tax_applies: null,
  safe_harbor_method: "",
  prior_year_total_tax: "",
  prior_year_agi: "",
  owner_reasonable_salary: "",
  owner_w2_wages_ytd: "",
  federal_withholding_ytd: "",
  state_withholding_ytd: "",
  health_insurance_deduction_ytd: "",
  retirement_contributions_ytd: "",
  hsa_contributions_ytd: "",
  reserve_buffer_percent: "",
};

export default function TaxSetupWorkflow({
  open,
  onClose,
  businessId,
  year,
  currentBusiness,
  overview,
  initialStepId = "business_structure",
  onSaved,
  onSaveAndCalculate,
}) {
  const taxProfile = useTaxProfile({ businessId, year, enabled: open && Boolean(businessId) });
  const [stepId, setStepId] = useState(initialStepId);
  const [values, setValues] = useState(EMPTY_VALUES);
  const [confirmedFields, setConfirmedFields] = useState(new Set());
  const [memoryValues, setMemoryValues] = useState({});
  const [changedMemoryKeys, setChangedMemoryKeys] = useState(new Set());
  const [activeMemories, setActiveMemories] = useState({});
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const profileEnvelope = taxProfile.data || {};
  const profile = taxProfile.profile || overview?.profile || null;
  const suggestions = useMemo(() => buildSuggestions({ profileEnvelope, profile, currentBusiness }), [profileEnvelope, profile, currentBusiness]);

  useEffect(() => {
    if (!open) return;
    setStepId(initialStepId || "business_structure");
  }, [open, initialStepId]);

  useEffect(() => {
    if (!open) return;
    setValues(profileToValues(profile));
    setConfirmedFields(inferConfirmedFields(profile));
    setDirty(false);
    setErrors({});
    setNotice(null);
  }, [open, businessId, year, profile?.id]);

  useEffect(() => {
    if (!open || !businessId) return;
    let cancelled = false;
    taxProfile.loadMemory()
      .then((result) => {
        if (cancelled) return;
        const memories = {};
        const nextValues = {};
        for (const memory of result?.memories || []) {
          memories[memory.memory_key || memory.memoryKey] = memory;
          nextValues[memory.memory_key || memory.memoryKey] = memory.value;
        }
        setActiveMemories(memories);
        setMemoryValues(nextValues);
        setChangedMemoryKeys(new Set());
      })
      .catch(() => {
        if (!cancelled) setActiveMemories({});
      });
    return () => { cancelled = true; };
  }, [open, businessId, year]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dirty]);

  const updateField = useCallback((field, value) => {
    setValues((current) => ({ ...current, [field]: value }));
    setConfirmedFields((current) => new Set(current).add(field));
    setDirty(true);
    setErrors((current) => ({ ...current, [field]: undefined }));
  }, []);

  const updateMemory = useCallback((field, value) => {
    setMemoryValues((current) => ({ ...current, [field]: value }));
    setChangedMemoryKeys((current) => new Set(current).add(field));
    setDirty(true);
  }, []);

  const useSuggestedValue = useCallback((field) => {
    if (!(field in suggestions)) return;
    updateField(field, suggestions[field]);
  }, [suggestions, updateField]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved tax setup changes?")) return;
    onClose?.();
  }, [dirty, onClose]);

  const ensureProfile = useCallback(async () => {
    if (taxProfile.profile?.id) return taxProfile.profile;
    return taxProfile.initialize({ source: "system" });
  }, [taxProfile]);

  const saveProfile = useCallback(async (patch) => {
    const current = await ensureProfile();
    if (current?.profile && !current.profile.id) return taxProfile.create(patch);
    return taxProfile.update(patch);
  }, [ensureProfile, taxProfile]);

  const saveMemories = useCallback(async (payloads) => {
    for (const payload of payloads) {
      await taxProfile.setMemory(payload);
    }
  }, [taxProfile]);

  const save = useCallback(async ({ mode = "save" } = {}) => {
    const validation = mode === "continue"
      ? validateTaxSetup(values, { stepId })
      : mode === "save_and_calculate"
        ? validateTaxSetup(values)
        : {};
    if (Object.keys(validation).length) {
      setErrors(validation);
      return false;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const patch = buildTaxProfilePatch(values, { confirmedFields, existingProfile: profile });
      const memoryPayloads = buildMemoryPayloads(memoryValues, changedMemoryKeys);
      await saveTaxSetupData({
        ensureProfile,
        saveProfile,
        saveMemories,
        refreshCalculation: onSaveAndCalculate,
        profilePatch: patch,
        memoryPayloads,
        mode: mode === "save_and_calculate" ? "save_and_calculate" : "save",
      });
      setDirty(false);
      setChangedMemoryKeys(new Set());
      await onSaved?.();
      setNotice(mode === "save_and_calculate" ? "Profile saved and calculation refresh requested." : "Tax setup saved.");
      if (mode === "save_close") onClose?.();
      return true;
    } catch (err) {
      setNotice(err?.message || "Tax setup could not be saved.");
      setErrors(mapBackendFieldErrors(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [values, stepId, confirmedFields, profile, memoryValues, changedMemoryKeys, ensureProfile, saveProfile, saveMemories, onSaveAndCalculate, onSaved, onClose]);

  const continueStep = async () => {
    const ok = await save({ mode: "continue" });
    if (ok) setStepId(nextStepId(stepId));
  };

  if (!open) return null;

  const currentIndex = stepIndex(stepId);
  const stepTitle = stepTitleFor(stepId);
  const stepDescription = stepDescriptionFor(stepId, values);

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/65 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="tax-setup-title">
      <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden border-l border-white/10 bg-[#080b0f] text-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-4 py-4 sm:px-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Tax setup</div>
            <h1 id="tax-setup-title" className="mt-1 text-2xl font-semibold">Complete your tax profile</h1>
            <p className="mt-1 max-w-2xl text-sm text-white/58">
              Provide the inputs Bizzi needs for entity routing, estimate readiness, safe-harbor planning, reserve planning, and tax memory.
            </p>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close tax setup" className="rounded-full border border-white/10 bg-white/[0.04] p-2 text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40">
            <X className="h-5 w-5" />
          </button>
        </header>

        <TaxSetupProgress currentStepId={stepId} onSelect={setStepId} />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          {notice ? (
            <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.055] px-3 py-2 text-sm text-white/74" aria-live="polite">
              {notice}
            </div>
          ) : null}
          {taxProfile.error ? (
            <div className="mb-4 flex gap-2 rounded-2xl border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-sm text-rose-50">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {taxProfile.error.message || "Tax profile failed to load."}
            </div>
          ) : null}
          <TaxSetupStepShell title={stepTitle} description={stepDescription} errors={errors}>
            {renderStep({
              stepId,
              values,
              errors,
              suggestions,
              activeMemories,
              memoryValues,
              confirmedFields,
              updateField,
              updateMemory,
              useSuggestedValue,
            })}
          </TaxSetupStepShell>
        </div>

        <footer className="flex flex-col gap-3 border-t border-white/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <button
            type="button"
            onClick={() => setStepId(previousStepId(stepId))}
            disabled={currentIndex === 0 || submitting}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-white/72 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => save({ mode: "save_close" })} disabled={submitting} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-white/72 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40 disabled:opacity-50">
              Save and close
            </button>
            {stepId === "review" ? (
              <button type="button" onClick={() => save({ mode: "save_and_calculate" })} disabled={submitting} className="inline-flex items-center gap-2 rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-[#06100c] hover:bg-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:opacity-60">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Save and calculate
              </button>
            ) : (
              <button type="button" onClick={continueStep} disabled={submitting} className="inline-flex items-center gap-2 rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-[#06100c] hover:bg-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:opacity-60">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Save and continue
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function renderStep(props) {
  const { stepId, values, errors, suggestions, activeMemories, memoryValues, updateField, updateMemory, useSuggestedValue } = props;
  if (stepId === "business_structure") {
    return (
      <div className="space-y-5">
        <ChoiceGroup value={values.entity_type} options={ENTITY_OPTIONS} onChange={(value) => {
          updateField("entity_type", value);
          if (value === "sole_proprietor") updateField("tax_election", "sole_proprietor");
          if (value === "s_corp") updateField("tax_election", "s_corp");
          if (value === "single_member_llc") updateField("tax_election", "");
        }} error={errors.entity_type} />
        {values.entity_type === "single_member_llc" ? (
          <FieldBlock label="How is the LLC taxed?" error={errors.tax_election}>
            <Segmented value={values.tax_election} options={LLC_ELECTION_OPTIONS} onChange={(value) => updateField("tax_election", value)} />
          </FieldBlock>
        ) : null}
      </div>
    );
  }
  if (stepId === "filing_context") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Filing status" value={values.filing_status} options={FILING_STATUS_OPTIONS} onChange={(value) => updateField("filing_status", value)} error={errors.filing_status} />
        <SelectField label="Primary tax state" value={values.primary_tax_state} options={[{ value: "", label: "Select state" }, ...US_STATE_OPTIONS]} onChange={(value) => updateField("primary_tax_state", value)} error={errors.primary_tax_state} suggestion={suggestions.primary_tax_state} onUseSuggestion={() => useSuggestedValue("primary_tax_state")} />
        <SelectField label="Accounting method" value={values.accounting_method} options={ACCOUNTING_METHOD_OPTIONS} onChange={(value) => updateField("accounting_method", value)} error={errors.accounting_method} />
      </div>
    );
  }
  if (stepId === "entity_details") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {isSCorp(values) ? (
          <>
            <MoneyField label="Reasonable salary target" value={values.owner_reasonable_salary} onChange={(value) => updateField("owner_reasonable_salary", value)} error={errors.owner_reasonable_salary} />
            <MoneyField label="Owner W-2 wages YTD" value={values.owner_w2_wages_ytd} onChange={(value) => updateField("owner_w2_wages_ytd", value)} error={errors.owner_w2_wages_ytd} />
            <InfoBlock>S-Corp pass-through income is not included in self-employment tax. Owner wages remain subject to payroll taxes.</InfoBlock>
          </>
        ) : (
          <FieldBlock label="Does self-employment tax generally apply?" error={errors.self_employment_tax_applies}>
            <Segmented value={values.self_employment_tax_applies} options={TRI_STATE_OPTIONS} onChange={(value) => updateField("self_employment_tax_applies", value)} />
          </FieldBlock>
        )}
        <MoneyField label="Federal withholding YTD" value={values.federal_withholding_ytd} onChange={(value) => updateField("federal_withholding_ytd", value)} error={errors.federal_withholding_ytd} />
        <MoneyField label="State withholding YTD" value={values.state_withholding_ytd} onChange={(value) => updateField("state_withholding_ytd", value)} error={errors.state_withholding_ytd} />
        <MoneyField label="Health-insurance deduction YTD" value={values.health_insurance_deduction_ytd} onChange={(value) => updateField("health_insurance_deduction_ytd", value)} error={errors.health_insurance_deduction_ytd} />
        <MoneyField label="Retirement contributions YTD" value={values.retirement_contributions_ytd} onChange={(value) => updateField("retirement_contributions_ytd", value)} error={errors.retirement_contributions_ytd} />
        <MoneyField label="HSA contributions YTD" value={values.hsa_contributions_ytd} onChange={(value) => updateField("hsa_contributions_ytd", value)} error={errors.hsa_contributions_ytd} />
        <FieldBlock label="Could this business be eligible for the qualified business income deduction?" error={errors.qbi_eligible} className="sm:col-span-2">
          <Segmented value={values.qbi_eligible} options={TRI_STATE_OPTIONS} onChange={(value) => updateField("qbi_eligible", value)} />
          <p className="mt-2 text-xs text-white/52">Bizzi is collecting this information, but the current estimate does not yet include a calculated QBI deduction.</p>
        </FieldBlock>
      </div>
    );
  }
  if (stepId === "payment_planning") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Safe-harbor method" value={values.safe_harbor_method} options={SAFE_HARBOR_OPTIONS} onChange={(value) => updateField("safe_harbor_method", value)} error={errors.safe_harbor_method} />
        <PercentField label="Reserve buffer percent" value={values.reserve_buffer_percent} onChange={(value) => updateField("reserve_buffer_percent", value)} error={errors.reserve_buffer_percent} />
        {["prior_year_100", "prior_year_110"].includes(values.safe_harbor_method) ? (
          <MoneyField label="Prior-year total tax" value={values.prior_year_total_tax} onChange={(value) => updateField("prior_year_total_tax", value)} error={errors.prior_year_total_tax} />
        ) : null}
        {values.safe_harbor_method === "prior_year_110" ? (
          <MoneyField label="Prior-year AGI" value={values.prior_year_agi} onChange={(value) => updateField("prior_year_agi", value)} error={errors.prior_year_agi} />
        ) : null}
      </div>
    );
  }
  if (stepId === "tax_memory") {
    return <TaxMemoryFields values={memoryValues} memories={activeMemories} onChange={updateMemory} onViewHistory={(key) => window.alert(`History for ${key} is available through the tax memory API.`)} />;
  }
  return <TaxProfileSummary values={values} confirmedFields={props.confirmedFields || new Set()} suggestions={suggestions} memoryValues={memoryValues} />;
}

function ChoiceGroup({ value, options, onChange, error }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange(option.value)} className={`rounded-2xl border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-emerald-300/40 ${value === option.value ? "border-emerald-300/45 bg-emerald-300/[0.11]" : "border-white/10 bg-white/[0.045] hover:bg-white/[0.08]"}`}>
          <div className="font-semibold text-white">{option.label}</div>
          <div className="mt-1 text-sm leading-relaxed text-white/56">{option.description}</div>
        </button>
      ))}
      {error ? <div className="sm:col-span-2 text-sm text-rose-100">{error}</div> : null}
    </div>
  );
}

function FieldBlock({ label, error, children, className = "" }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-black/16 p-3 ${className}`}>
      <div className="text-sm font-semibold text-white/84">{label}</div>
      <div className="mt-2">{children}</div>
      {error ? <div className="mt-2 text-xs text-rose-100">{error}</div> : null}
    </div>
  );
}

function SelectField({ label, value, options, onChange, error, suggestion, onUseSuggestion }) {
  return (
    <FieldBlock label={label} error={error}>
      <select value={value || ""} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-white/10 bg-[#0f1115] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-300/35">
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {suggestion && !value ? (
        <button type="button" onClick={onUseSuggestion} className="mt-2 rounded-full border border-emerald-300/22 bg-emerald-300/[0.08] px-2.5 py-1 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/[0.13]">
          Use suggested {suggestion}
        </button>
      ) : null}
    </FieldBlock>
  );
}

function MoneyField({ label, value, onChange, error }) {
  return (
    <FieldBlock label={label} error={error}>
      <input type="number" min="0" step="1" value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-white/10 bg-[#0f1115] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-300/35" />
    </FieldBlock>
  );
}

function PercentField({ label, value, onChange, error }) {
  return (
    <FieldBlock label={label} error={error}>
      <input type="number" min="0" max="100" step="1" value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-white/10 bg-[#0f1115] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-300/35" />
    </FieldBlock>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button key={String(option.value)} type="button" onClick={() => onChange(option.value)} className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-300/40 ${value === option.value ? "border-emerald-300/45 bg-emerald-300/12 text-emerald-50" : "border-white/10 bg-white/[0.04] text-white/66 hover:bg-white/[0.08] hover:text-white"}`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function InfoBlock({ children }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-3 text-sm leading-relaxed text-white/62 sm:col-span-2">{children}</div>;
}

function stepTitleFor(stepId) {
  return {
    business_structure: "Business tax structure",
    filing_context: "Personal filing context",
    entity_details: "Entity-specific information",
    payment_planning: "Estimated-payment planning",
    tax_memory: "Tax memory preferences",
    review: "Review",
  }[stepId] || "Tax setup";
}

function stepDescriptionFor(stepId, values) {
  if (stepId === "business_structure") return "Bizzi will not guess an LLC tax election. Confirm the route that matches your records.";
  if (stepId === "filing_context") return "Use business profile values only as suggestions. Saving here confirms the values for tax setup.";
  if (stepId === "entity_details" && isSCorp(values)) return "S-Corp setup asks for owner wage context. Sole proprietor salary fields are intentionally hidden.";
  if (stepId === "entity_details") return "Provide amounts you know. Unknown amounts should stay blank rather than becoming zero.";
  if (stepId === "payment_planning") return "Estimated payments already made are managed in the payments workflow, not duplicated here.";
  if (stepId === "tax_memory") return "Optional preferences improve future classification and planning, but they do not block the estimate.";
  return "Review confirmed values separately from suggestions and save only after you are comfortable with the setup.";
}

function buildSuggestions({ profileEnvelope, profile, currentBusiness }) {
  const fromServer = profileEnvelope?.suggestedDefaults || profile?.metadata?.suggestedDefaults || {};
  const state = fromServer.primary_tax_state || currentBusiness?.state || currentBusiness?.entity_formation_state || null;
  return state && !profile?.primary_tax_state_confirmed ? { primary_tax_state: String(state).toUpperCase() } : {};
}

function profileToValues(profile) {
  if (!profile) return EMPTY_VALUES;
  return {
    ...EMPTY_VALUES,
    ...profile,
    primary_tax_state: profile.primary_tax_state || "",
    accounting_method: profile.accounting_method || "",
    filing_status: profile.filing_status || "",
    tax_election: profile.tax_election || "",
    entity_type: profile.entity_type || "",
    safe_harbor_method: profile.safe_harbor_method || "",
    reserve_buffer_percent: profile.reserve_buffer_percent == null ? "" : Math.round(Number(profile.reserve_buffer_percent) * 100),
  };
}

function inferConfirmedFields(profile) {
  const fields = new Set();
  if (!profile) return fields;
  for (const [key, value] of Object.entries(profile)) {
    if (value == null || value === "" || key === "primary_tax_state") continue;
    fields.add(key);
  }
  if (profile.primary_tax_state && profile.primary_tax_state_confirmed) fields.add("primary_tax_state");
  return fields;
}

function mapBackendFieldErrors(err) {
  const details = err?.details || {};
  if (details.field) return { [details.field]: err.message };
  if (details.fields && typeof details.fields === "object") return details.fields;
  return {};
}
