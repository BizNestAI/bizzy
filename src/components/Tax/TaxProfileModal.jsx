import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import useTaxProfile from "../../hooks/tax/useTaxProfile.js";
import {
  ACCOUNTING_METHOD_OPTIONS,
  ENTITY_OPTIONS,
  FILING_STATUS_OPTIONS,
  LLC_ELECTION_OPTIONS,
  SAFE_HARBOR_OPTIONS,
  SELF_EMPLOYMENT_OPTIONS,
  US_STATE_OPTIONS,
  isSCorp,
  isSoleOrDisregarded,
} from "./Setup/taxProfileFields.js";
import { buildTaxProfilePatch } from "./Setup/taxSetupValidation.js";
import TaxProfileSelectField from "./Setup/TaxProfileSelectField.jsx";
import {
  TAX_PROFILE_EMPTY_VALUES,
  profileToTaxProfileValues,
} from "./Setup/taxProfileFormModel.js";

const EDITABLE_FIELDS = [
  "entity_type",
  "tax_election",
  "filing_status",
  "primary_tax_state",
  "accounting_method",
  "safe_harbor_method",
  "self_employment_tax_applies",
  "prior_year_total_tax",
  "prior_year_agi",
  "owner_reasonable_salary",
  "owner_w2_wages_ytd",
  "federal_withholding_ytd",
  "state_withholding_ytd",
  "reserve_buffer_percent",
];

export default function TaxProfileModal({
  open,
  businessId,
  year,
  overviewProfile,
  onClose,
  onSaved,
}) {
  const taxProfile = useTaxProfile({ businessId, year, enabled: open && Boolean(businessId) });
  const profile = taxProfile.profile || overviewProfile || null;
  const [values, setValues] = useState(TAX_PROFILE_EMPTY_VALUES);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [rendered, setRendered] = useState(open);
  const [visible, setVisible] = useState(false);
  const saveInFlightRef = useRef(false);
  const closeAfterSaveTimerRef = useRef(null);

  useEffect(() => {
    if (closeAfterSaveTimerRef.current) {
      window.clearTimeout(closeAfterSaveTimerRef.current);
      closeAfterSaveTimerRef.current = null;
    }
    if (!open) return;
    setValues(profileToTaxProfileValues(profile));
    setDirty(false);
    setNotice("");
  }, [open, profile?.id, profile]);

  useEffect(() => () => {
    if (closeAfterSaveTimerRef.current) window.clearTimeout(closeAfterSaveTimerRef.current);
  }, []);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }

    setVisible(false);
    const timeout = window.setTimeout(() => setRendered(false), 180);
    return () => window.clearTimeout(timeout);
  }, [open]);

  const confirmedFields = useMemo(() => new Set(EDITABLE_FIELDS), []);

  if (!rendered) return null;

  const updateField = (field, value) => {
    setValues((current) => ({ ...current, [field]: value }));
    setDirty(true);
    setNotice("");
  };

  const close = () => {
    if (dirty && !window.confirm("Discard unsaved tax profile changes?")) return;
    onClose?.();
  };

  const save = async () => {
    if (saveInFlightRef.current || taxProfile.saving) return;
    saveInFlightRef.current = true;
    setNotice("");
    try {
      const patch = buildTaxProfilePatch(values, { confirmedFields, existingProfile: profile });
      const result = await taxProfile.update(patch);
      setDirty(false);
      const readiness = result?.readiness || result?.profile?.readiness || null;
      setNotice(readiness?.profile_status === "draft" ? "Tax Profile saved as draft." : "Tax Profile saved.");
      await onSaved?.(result);
      closeAfterSaveTimerRef.current = window.setTimeout(() => {
        closeAfterSaveTimerRef.current = null;
        onClose?.();
      }, 650);
    } catch (err) {
      setNotice(err?.message || "Tax profile could not be saved.");
    } finally {
      saveInFlightRef.current = false;
    }
  };

  const showSelfEmploymentQuestion = isSoleOrDisregarded(values);
  const showPriorYearFields = ["prior_year_100", "prior_year_110"].includes(values.safe_harbor_method);

  const modal = (
    <div
      className={`fixed right-0 top-0 left-[var(--nav-w,0px)] z-[90] grid place-items-center px-4 pt-5 pb-4 font-sans transition-opacity duration-200 ease-out ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
      style={{ bottom: "calc(var(--chat-clearance, 156px) + 16px)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tax-profile-modal-title"
    >
      <section
        className={`pointer-events-auto flex w-full max-w-[720px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080b0f] text-white shadow-[0_24px_90px_rgba(0,0,0,0.68)] transition-all duration-200 ease-out ${visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.98] opacity-0"}`}
        style={{ maxHeight: "min(720px, calc(100svh - var(--chat-clearance, 156px) - 48px))" }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-4 py-3.5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Tax profile</div>
            <h1 id="tax-profile-modal-title" className="mt-1 text-lg font-semibold leading-tight tracking-normal">Edit tax profile</h1>
            <p className="mt-1 max-w-lg text-xs leading-relaxed text-white/54">
              Updates apply to entity routing, filing context, safe harbor, and reserve readiness.
            </p>
          </div>
          <button type="button" onClick={close} aria-label="Close tax profile" className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {taxProfile.error ? (
            <div className="mb-4 rounded-[14px] border border-rose-300/22 bg-rose-400/[0.08] px-3 py-2 text-xs text-rose-50">
              {taxProfile.error.message || "Tax profile failed to load."}
            </div>
          ) : null}
          {notice ? (
            <div className="mb-4 rounded-[14px] border border-white/10 bg-white/[0.05] px-3 py-2 text-xs text-white/72">
              {notice}
            </div>
          ) : null}

          <div className="grid gap-2.5 sm:grid-cols-2">
            <TaxProfileSelectField label="Business tax structure" value={values.entity_type} options={ENTITY_OPTIONS} onChange={(value) => updateField("entity_type", value)} />
            {values.entity_type === "single_member_llc" ? (
              <TaxProfileSelectField label="LLC tax election" value={values.tax_election} options={LLC_ELECTION_OPTIONS} onChange={(value) => updateField("tax_election", value)} />
            ) : null}
            <TaxProfileSelectField label="Filing status" value={values.filing_status} options={FILING_STATUS_OPTIONS} onChange={(value) => updateField("filing_status", value)} />
            <TaxProfileSelectField label="Primary tax state" value={values.primary_tax_state} options={[{ value: "", label: "Select state" }, ...US_STATE_OPTIONS]} onChange={(value) => updateField("primary_tax_state", value)} />
            <TaxProfileSelectField label="Accounting method" value={values.accounting_method} options={ACCOUNTING_METHOD_OPTIONS} onChange={(value) => updateField("accounting_method", value)} />
            <TaxProfileSelectField label="Safe-harbor method" value={values.safe_harbor_method} options={SAFE_HARBOR_OPTIONS} onChange={(value) => updateField("safe_harbor_method", value)} />
            {showSelfEmploymentQuestion ? (
              <TaxProfileSelectField
                label="Is this business income subject to self-employment tax?"
                value={values.self_employment_tax_applies}
                options={SELF_EMPLOYMENT_OPTIONS}
                onChange={(value) => updateField("self_employment_tax_applies", value)}
                helper="Used to determine whether self-employment tax should be included in your estimate."
              />
            ) : null}
            {showPriorYearFields ? (
              <MoneyField label="Prior-year total tax" value={values.prior_year_total_tax} onChange={(value) => updateField("prior_year_total_tax", value)} />
            ) : null}
            {values.safe_harbor_method === "prior_year_110" ? (
              <MoneyField label="Prior-year AGI" value={values.prior_year_agi} onChange={(value) => updateField("prior_year_agi", value)} />
            ) : null}
            {isSCorp(values) ? (
              <>
                <MoneyField label="Reasonable salary target" value={values.owner_reasonable_salary} onChange={(value) => updateField("owner_reasonable_salary", value)} />
                <MoneyField label="Owner W-2 wages YTD" value={values.owner_w2_wages_ytd} onChange={(value) => updateField("owner_w2_wages_ytd", value)} />
              </>
            ) : null}
            <MoneyField label="Federal withholding YTD" value={values.federal_withholding_ytd} onChange={(value) => updateField("federal_withholding_ytd", value)} />
            <MoneyField label="State withholding YTD" value={values.state_withholding_ytd} onChange={(value) => updateField("state_withholding_ytd", value)} />
            <PercentField label="Reserve buffer percent" value={values.reserve_buffer_percent} onChange={(value) => updateField("reserve_buffer_percent", value)} />
          </div>
        </div>

        <footer className="flex flex-col gap-3 border-t border-white/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-white/46">Saved through the Tax API.</div>
          <div className="flex gap-2">
            <button type="button" onClick={close} className="rounded-full border border-white/10 bg-black/18 px-3 py-1.5 text-xs font-semibold text-white/64 transition hover:bg-white/10 hover:text-white">
              Cancel
            </button>
            <button type="button" onClick={save} disabled={taxProfile.saving || taxProfile.loading || !dirty} className="inline-flex items-center gap-2 rounded-full bg-emerald-300 px-4 py-1.5 text-xs font-semibold text-[#06100c] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50">
              {taxProfile.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save profile
            </button>
          </div>
        </footer>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}

function MoneyField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-white/70">{label}</span>
      <input type="number" min="0" step="1" value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-[11px] border border-white/10 bg-[#0f1115] px-3 py-1.5 text-xs text-white outline-none transition focus:ring-2 focus:ring-emerald-300/35" />
    </label>
  );
}

function PercentField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-white/70">{label}</span>
      <input type="number" min="0" max="100" step="1" value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-[11px] border border-white/10 bg-[#0f1115] px-3 py-1.5 text-xs text-white outline-none transition focus:ring-2 focus:ring-emerald-300/35" />
    </label>
  );
}
