import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import useTaxProfile from "../../hooks/tax/useTaxProfile.js";
import {
  ACCOUNTING_METHOD_OPTIONS,
  ENTITY_OPTIONS,
  FILING_STATUS_OPTIONS,
  LLC_ELECTION_OPTIONS,
  SAFE_HARBOR_OPTIONS,
  US_STATE_OPTIONS,
  isSCorp,
} from "./Setup/taxProfileFields.js";
import { buildTaxProfilePatch } from "./Setup/taxSetupValidation.js";

const EDITABLE_FIELDS = [
  "entity_type",
  "tax_election",
  "filing_status",
  "primary_tax_state",
  "accounting_method",
  "safe_harbor_method",
  "prior_year_total_tax",
  "prior_year_agi",
  "owner_reasonable_salary",
  "owner_w2_wages_ytd",
  "federal_withholding_ytd",
  "state_withholding_ytd",
  "reserve_buffer_percent",
];

const EMPTY_VALUES = {
  entity_type: "",
  tax_election: "",
  filing_status: "",
  primary_tax_state: "",
  accounting_method: "",
  safe_harbor_method: "",
  prior_year_total_tax: "",
  prior_year_agi: "",
  owner_reasonable_salary: "",
  owner_w2_wages_ytd: "",
  federal_withholding_ytd: "",
  state_withholding_ytd: "",
  reserve_buffer_percent: "",
};

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
  const [values, setValues] = useState(EMPTY_VALUES);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [rendered, setRendered] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(profileToValues(profile));
    setDirty(false);
    setNotice("");
  }, [open, profile?.id, profile]);

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
    setNotice("");
    try {
      const patch = buildTaxProfilePatch(values, { confirmedFields, existingProfile: profile });
      await taxProfile.update(patch);
      setDirty(false);
      setNotice("Tax profile saved.");
      await onSaved?.();
    } catch (err) {
      setNotice(err?.message || "Tax profile could not be saved.");
    }
  };

  const modal = (
    <div
      className={`fixed bottom-0 right-0 top-0 left-[var(--nav-w,0px)] z-[90] grid place-items-center px-4 py-8 font-sans transition-opacity duration-200 ease-out ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tax-profile-modal-title"
    >
      <section className={`pointer-events-auto flex max-h-[min(760px,calc(100vh-96px))] w-full max-w-[720px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080b0f] text-white shadow-[0_24px_90px_rgba(0,0,0,0.68)] transition-all duration-200 ease-out ${visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.98] opacity-0"}`}>
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
            <SelectField label="Business tax structure" value={values.entity_type} options={ENTITY_OPTIONS} onChange={(value) => updateField("entity_type", value)} />
            {values.entity_type === "single_member_llc" ? (
              <SelectField label="LLC tax election" value={values.tax_election} options={LLC_ELECTION_OPTIONS} onChange={(value) => updateField("tax_election", value)} />
            ) : null}
            <SelectField label="Filing status" value={values.filing_status} options={FILING_STATUS_OPTIONS} onChange={(value) => updateField("filing_status", value)} />
            <SelectField label="Primary tax state" value={values.primary_tax_state} options={[{ value: "", label: "Select state" }, ...US_STATE_OPTIONS]} onChange={(value) => updateField("primary_tax_state", value)} />
            <SelectField label="Accounting method" value={values.accounting_method} options={ACCOUNTING_METHOD_OPTIONS} onChange={(value) => updateField("accounting_method", value)} />
            <SelectField label="Safe-harbor method" value={values.safe_harbor_method} options={SAFE_HARBOR_OPTIONS} onChange={(value) => updateField("safe_harbor_method", value)} />
            <MoneyField label="Prior-year total tax" value={values.prior_year_total_tax} onChange={(value) => updateField("prior_year_total_tax", value)} />
            <MoneyField label="Prior-year AGI" value={values.prior_year_agi} onChange={(value) => updateField("prior_year_agi", value)} />
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

function SelectField({ label, value, options, onChange }) {
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState(null);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef(null);

  const normalizedOptions = useMemo(
    () => (options || []).map((option) => ({
      value: option?.value ?? "",
      label: String(option?.label ?? option?.value ?? "").trim(),
    })),
    [options]
  );
  const selectedIndex = Math.max(0, normalizedOptions.findIndex((option) => String(option.value) === String(value ?? "")));
  const selectedOption = normalizedOptions[selectedIndex] || normalizedOptions[0] || { value: "", label: "Select" };
  const selectId = useMemo(() => `tax-profile-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, [label]);

  const updateMenuPosition = useCallback(() => {
    if (!buttonRef.current || typeof window === "undefined") return;
    const rect = buttonRef.current.getBoundingClientRect();
    const margin = 12;
    const width = Math.max(rect.width, 220);
    const maxWidth = Math.max(180, window.innerWidth - margin * 2);
    const safeWidth = Math.min(width, maxWidth);
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const preferredMaxHeight = label.toLowerCase().includes("state") ? 280 : 220;
    const openUp = below < 180 && above > below;
    const maxHeight = Math.max(120, Math.min(preferredMaxHeight, openUp ? above - 8 : below - 8));
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - safeWidth - margin);
    setMenuStyle({
      position: "fixed",
      left,
      top: openUp ? Math.max(margin, rect.top - maxHeight - 8) : Math.min(window.innerHeight - margin, rect.bottom + 8),
      width: safeWidth,
      maxHeight,
    });
  }, [label]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    setActiveIndex(selectedIndex);
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, selectedIndex, updateMenuPosition]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (buttonRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const choose = (option) => {
    onChange?.(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        choose(normalizedOptions[activeIndex] || selectedOption);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        const count = normalizedOptions.length || 1;
        return (current + direction + count) % count;
      });
      return;
    }
    if (event.key.length === 1 && /\S/.test(event.key)) {
      typeaheadRef.current += event.key.toLowerCase();
      window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = window.setTimeout(() => {
        typeaheadRef.current = "";
      }, 500);
      const index = normalizedOptions.findIndex((option) => option.label.toLowerCase().startsWith(typeaheadRef.current));
      if (index >= 0) {
        event.preventDefault();
        setActiveIndex(index);
        if (!open) choose(normalizedOptions[index]);
      }
    }
  };

  return (
    <div className="block">
      <span id={`${selectId}-label`} className="text-[11px] font-semibold text-white/70">{label}</span>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${selectId}-listbox`}
        aria-labelledby={`${selectId}-label`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
        className="dark-dropdown mt-1 flex w-full items-center justify-between gap-2 rounded-[11px] border border-white/10 bg-[#0f1115] px-3 py-1.5 text-left text-xs text-white outline-none transition hover:border-emerald-200/28 hover:bg-white/[0.04] focus:ring-2 focus:ring-emerald-300/35"
      >
        <span className={selectedOption.value === "" ? "text-white/42" : "text-white"}>{selectedOption.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-white/48 transition ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && menuStyle ? createPortal(
        <div
          ref={menuRef}
          id={`${selectId}-listbox`}
          role="listbox"
          aria-labelledby={`${selectId}-label`}
          style={menuStyle}
          className="z-[120] overflow-y-auto rounded-xl border border-white/12 bg-[#080b0f] p-1 text-xs text-white shadow-[0_22px_54px_rgba(0,0,0,0.72)] ring-1 ring-emerald-300/10"
        >
          {normalizedOptions.map((option, index) => {
            const selected = String(option.value) === String(value ?? "");
            const active = index === activeIndex;
            return (
              <button
                key={`${selectId}-${String(option.value)}`}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
                className={[
                  "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition",
                  selected ? "bg-emerald-300/[0.13] text-emerald-50" : "text-white/78",
                  active && !selected ? "bg-white/[0.075] text-white" : "",
                ].join(" ")}
              >
                <span className="truncate">{option.label}</span>
                {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-200" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>,
        document.body
      ) : null}
    </div>
  );
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

function profileToValues(profile) {
  const source = profile || {};
  return {
    ...EMPTY_VALUES,
    ...source,
    entity_type: source.entity_type || source.entityType || "",
    tax_election: source.tax_election || source.taxElection || "",
    filing_status: source.filing_status || source.filingStatus || "",
    primary_tax_state: source.primary_tax_state || source.primaryState || source.state || "",
    accounting_method: source.accounting_method || source.accountingMethod || "",
    safe_harbor_method: source.safe_harbor_method || source.safeHarborMethod || "",
    prior_year_total_tax: source.prior_year_total_tax ?? source.priorYearTotalTax ?? "",
    prior_year_agi: source.prior_year_agi ?? source.priorYearAgi ?? source.priorYearAGI ?? "",
    owner_reasonable_salary: source.owner_reasonable_salary ?? source.ownerReasonableSalary ?? "",
    owner_w2_wages_ytd: source.owner_w2_wages_ytd ?? source.ownerW2WagesYtd ?? source.ownerW2WagesYTD ?? source.ownerWagesYtd ?? "",
    federal_withholding_ytd: source.federal_withholding_ytd ?? source.federalWithholdingYtd ?? source.federalWithholdingYTD ?? "",
    state_withholding_ytd: source.state_withholding_ytd ?? source.stateWithholdingYtd ?? source.stateWithholdingYTD ?? "",
    reserve_buffer_percent: source.reserve_buffer_percent == null && source.reserveBufferPercent == null
      ? ""
      : Math.round(Number(source.reserve_buffer_percent ?? source.reserveBufferPercent) * 100),
  };
}
