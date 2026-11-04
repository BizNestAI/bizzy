import MileageMethodDialog from "./MileageMethodDialog.jsx";
import { formatTaxCurrency } from "./taxCurrency.js";
import TaxProfileSelectField from "./Setup/TaxProfileSelectField.jsx";
import React, { useEffect, useRef, useState } from "react";

export default function VehicleTreatmentEditor({ vehicles = [], vehicleId: initialVehicleId = "", transactionIds = [], defaultAction = "exclude", onPreview, onApply, onSaved, readOnly = false, triggerLabel = "Change treatment", compact = false, methodOnly = false, taxYear }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState(defaultAction);
  const [vehicleId, setVehicleId] = useState(initialVehicleId);
  const [method, setMethod] = useState("actual_expenses");
  const [percent, setPercent] = useState("");
  const [reason, setReason] = useState("");
  const [ownershipType, setOwnershipType] = useState("");
  const [category, setCategory] = useState("other_business_expense");
  const [eligibility, setEligibility] = useState({});
  const [allBusiness, setAllBusiness] = useState(false);
  const [confirmYear, setConfirmYear] = useState(false);
  const [supersedeManual, setSupersedeManual] = useState(false);
  const [recordsConfirmed, setRecordsConfirmed] = useState(false);
  const [mileageText, setMileageText] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const key = useRef(null);
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);
  const selectionKey = transactionIds.join(",");
  const previousSelection = useRef(selectionKey);
  useEffect(() => {
    if (previousSelection.current !== selectionKey && !unknown && !busy) { previousSelection.current = selectionKey; setPreview(null); }
  }, [selectionKey, unknown, busy]);
  const change = (setter) => (event) => { setter(event.target.type === "checkbox" ? event.target.checked : event.target.value); setPreview(null); setError(""); };
  const makePreview = async () => {
    setBusy(true); setError(""); setPreview(null); setSaved(false);
    request.current?.abort(); request.current = new AbortController();
    try {
      const entries = action === "correct_mileage" ? mileageText.trim().split("\n").filter(Boolean).map((line) => {
        const [periodStart, periodEnd, businessMiles] = line.split(",").map((part) => part.trim());
        return { periodStart, periodEnd, businessMiles };
      }) : [];
      const next = await onPreview({ action, vehicleId: vehicleId && !["primary", "new"].includes(vehicleId) ? vehicleId : null,
        primaryVehicle: vehicleId === "primary", newVehicle: vehicleId === "new", transactionIds, method,
        businessUsePercent: percent, allBusinessConfirmed: allBusiness, ownershipType, eligibility, reason,
        confirmYearRecalculation: confirmYear, supersedeManual, recordsConfirmed, taxCategory: category, entries,
        signal: request.current.signal });
      key.current = `vehicle-command-${globalThis.crypto.randomUUID()}`;
      setPreview(next);
    } catch (caught) { if (caught.name !== "AbortError") setError(caught.message || "The correction could not be previewed."); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setError("");
    try {
      const result = await onApply({ previewId: preview.previewId, idempotencyKey: key.current });
      setUnknown(false); setPreview(null); setSaved(true); await onSaved?.(result);
    } catch (caught) {
      const uncertain = caught.outcomeUnknown === true || !caught.status || caught.status >= 500 || [408, 429].includes(caught.status);
      setUnknown(uncertain);
      if (!uncertain) { setPreview(null); key.current = null; }
      setError(uncertain ? `${caught.message || "The save outcome is unknown."} Retry this same confirmation to reconcile its outcome.` : caught.message || "Refresh and preview again. Nothing was saved.");
    }
    finally { setBusy(false); }
  };
  return <section className={compact ? "my-3 text-xs text-white/70" : "my-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.035] p-3 text-xs text-white/70"}>
    <button type="button" disabled={readOnly || busy || unknown} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup={methodOnly ? "dialog" : undefined} className={`rounded disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 ${methodOnly ? "font-normal text-white/52 hover:text-white/80" : "font-semibold text-emerald-100"}`}>{triggerLabel}</button>
    {saved ? <p role="status" className="mt-2 text-emerald-100">{methodOnly ? "Vehicle method updated." : "Treatment saved with audit history."}</p> : null}
    {open && !methodOnly ? <>
      <p className="mt-2">Explicit corrections can amend earlier user decisions. CPA decisions remain protected. A vehicle method or percentage amendment recalculates the entire vehicle/year.</p>
      <fieldset disabled={busy || unknown || readOnly} className="mt-3 grid gap-3 sm:grid-cols-2">
        <TaxProfileSelectField label="Correction" ariaLabel="Vehicle correction action" value={action} onChange={value => change(setAction)({ target: { value } })} disabled={busy || unknown || readOnly} options={[{"value": "exclude", "label": "Manually exclude selected expenses"}, {"value": "assign", "label": "Assign selected expenses to a vehicle"}, {"value": "recategorize", "label": "Recategorize selected as non-vehicle expenses"}, {"value": "amend", "label": "Change vehicle method or business-use percentage for the year"}, {"value": "correct_mileage", "label": "Correct mileage, including finalized mileage"}]} />
        {["assign", "amend", "correct_mileage"].includes(action) ? <TaxProfileSelectField label="Vehicle" ariaLabel="Correction vehicle" value={vehicleId} onChange={value => change(setVehicleId)({ target: { value } })} disabled={busy || unknown || readOnly} options={[{ value: "", label: "Choose a vehicle" }, ...(vehicles.length <= 1 ? [{ value: "primary", label: "One vehicle — reuse Primary vehicle" }] : []), ...vehicles.map(vehicle => ({ value: vehicle.id, label: vehicle.displayName })), ...(action === "assign" ? [{ value: "new", label: "Another vehicle — name optional" }] : [])]} /> : <p className="self-end">{transactionIds.length} selected transaction{transactionIds.length === 1 ? "" : "s"}</p>}
        {action === "amend" ? <>
          <TaxProfileSelectField label="Method" ariaLabel="Amended vehicle method" value={method} onChange={value => change(setMethod)({ target: { value } })} disabled={busy || unknown || readOnly} options={[{"value": "actual_expenses", "label": "Actual Expenses"}, {"value": "standard_mileage", "label": "Standard Mileage"}]} />
          <TaxProfileSelectField label="Ownership" value={ownershipType} onChange={value => change(setOwnershipType)({ target: { value } })} disabled={busy || unknown || readOnly} options={[{"value": "", "label": "Unconfirmed — method changes will be blocked"}, {"value": "owned", "label": "Owned"}, {"value": "leased", "label": "Leased"}]} />
          {method === "actual_expenses" ? <><label>Business use %<input aria-label="Amended business use percent" type="number" min="0.01" max="100" step="0.01" value={percent} onChange={change(setPercent)} className="mt-1 w-full rounded-lg bg-black/30 p-2" /></label><label className="flex items-center gap-2"><input type="checkbox" checked={allBusiness} onChange={change(setAllBusiness)} />I explicitly confirm entirely business use if choosing 100%.</label></> : <div className="space-y-2 sm:col-span-2">{[
            ["ownedOrLeased", "I owned or leased this vehicle."], ["firstYearAvailable", "Standard Mileage was chosen in the owned vehicle’s first business-use year, or used throughout its lease including renewals."],
            ["fleetUnderFive", "I did not operate five or more vehicles simultaneously."], ["noDisallowedDepreciation", "I have not claimed MACRS, Section 179, special depreciation, or depreciation other than straight-line."]
          ].map(([name, label]) => <label key={name} className="flex gap-2"><input type="checkbox" checked={!!eligibility[name]} onChange={(event) => { setEligibility((current) => ({ ...current, [name]: event.target.checked })); setPreview(null); }} />{label}</label>)}</div>}
          <label className="flex gap-2 sm:col-span-2"><input type="checkbox" checked={confirmYear} onChange={change(setConfirmYear)} />I understand this changes the entire vehicle/year and replaces its prior method election.</label>
          <label className="flex gap-2 sm:col-span-2"><input type="checkbox" checked={supersedeManual} onChange={change(setSupersedeManual)} />Explicitly supersede earlier user overrides within this vehicle/year. Preserve CPA decisions.</label>
        </> : null}
        {action === "recategorize" ? <TaxProfileSelectField label="Non-vehicle tax category" value={category} onChange={value => change(setCategory)({ target: { value } })} disabled={busy || unknown || readOnly} options={[{"value": "other_business_expense", "label": "Other business expense"}, {"value": "office_expense", "label": "Office expense"}, {"value": "materials_supplies", "label": "Materials and supplies"}, {"value": "travel_transportation", "label": "Travel transportation"}]} /> : null}
        {action === "correct_mileage" ? <><label className="sm:col-span-2">Replacement periods: start date, end date, business miles (one period per line)<textarea value={mileageText} onChange={change(setMileageText)} placeholder="2026-01-01, 2026-06-30, 3200" className="mt-1 w-full rounded-lg bg-black/30 p-2" /></label><label className="flex gap-2 sm:col-span-2"><input type="checkbox" checked={recordsConfirmed} onChange={change(setRecordsConfirmed)} />Mileage records support this complete replacement snapshot.</label></> : null}
        <label className="sm:col-span-2">Reason<input aria-label="Vehicle correction reason" value={reason} onChange={change(setReason)} className="mt-1 w-full rounded-lg bg-black/30 p-2" /></label>
      </fieldset>
      {error ? <p role="alert" className="mt-2 text-amber-100">{error}</p> : null}
      {preview ? <div className="mt-3 rounded-lg border border-white/15 p-3" aria-label="Vehicle correction preview"><p>{preview.affectedCount} affected · {preview.label}: {formatTaxCurrency(preview.beforeDeduction)} → {formatTaxCurrency(preview.afterDeduction)}</p>
        {["amend", "correct_mileage"].includes(action) ? <p>Mileage Deduction: {formatTaxCurrency(preview.beforeMileageDeduction || 0)} → {formatTaxCurrency(preview.afterMileageDeduction || 0)}</p> : null}
        <p>{preview.skipped.length} protected decisions preserved. Review all affected transactions before confirming.</p>
        <div className="mt-2 max-h-56 overflow-y-auto">{preview.rows.map((row) => <p key={row.transactionId}>{row.date || "Date unavailable"} · {row.accountName} · {formatTaxCurrency(Math.abs(row.signedAmount))} · {formatTaxCurrency(row.previousDeductibleAmount)} → {formatTaxCurrency(row.deductibleAmount)} · {row.treatment}</p>)}</div>
      </div> : null}
      <div className="mt-3 flex gap-2"><button type="button" disabled={busy || unknown || readOnly || reason.trim().length < 3} onClick={makePreview} className="rounded-full border border-white/20 px-3 py-2 disabled:opacity-40">Preview correction</button>
        {preview ? <button type="button" disabled={busy || readOnly} onClick={apply} className="rounded-full bg-emerald-200 px-3 py-2 font-semibold text-black disabled:opacity-40">{unknown ? "Retry same confirmation" : "Confirm correction"}</button> : null}
      </div>
    </> : null}
    {open && methodOnly ? <MileageMethodDialog onClose={() => { if (!busy && !unknown) { setOpen(false); setPreview(null); } }} locked={busy || unknown}>
      <p className="mt-2 text-sm text-white/60">This will update your {taxYear} vehicle deduction.</p>
      <fieldset disabled={busy || unknown || readOnly} className="mt-4 grid gap-4 sm:grid-cols-2">
        <TaxProfileSelectField label="New method" ariaLabel="New method" value={method} onChange={value => change(setMethod)({target:{value}})} disabled={busy || unknown || readOnly} options={[{value:"actual_expenses",label:"Actual Expenses"},{value:"standard_mileage",label:"Standard Mileage"}]} />
        <TaxProfileSelectField label="Ownership status" ariaLabel="Ownership status" value={ownershipType} onChange={value => change(setOwnershipType)({target:{value}})} disabled={busy || unknown || readOnly} options={[{value:"owned",label:"Owned"},{value:"leased",label:"Leased"},{value:"",label:"I’m not sure"}]} />
        {method === "actual_expenses" ? <>
          <label className="text-xs text-white/70">Business-use percentage<input aria-label="Business-use percentage" type="number" min="0.01" max="100" step="0.01" value={percent} onChange={change(setPercent)} className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 p-3 focus-visible:ring-2 focus-visible:ring-emerald-300" /></label>
          {Number(percent) === 100 ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={allBusiness} onChange={change(setAllBusiness)} />This vehicle is used only for business.</label> : null}
        </> : <details className="text-xs text-white/65 sm:col-span-2"><summary className="cursor-pointer focus-visible:ring-2">Confirm standard mileage eligibility</summary><p className="my-2">Check your vehicle records before confirming. If you’re not sure, keep your current method until you can confirm eligibility.</p>{[
          ["ownedOrLeased", "I owned or leased this vehicle."],
          ["firstYearAvailable", "I chose standard mileage in the vehicle’s first business-use year, or used it throughout the lease."],
          ["fleetUnderFive", "I used fewer than five business vehicles at the same time."],
          ["noDisallowedDepreciation", "My depreciation history allows standard mileage."],
        ].map(([name,label]) => <label key={name} className="mt-2 flex gap-2"><input type="checkbox" checked={!!eligibility[name]} onChange={event => {setEligibility(current => ({...current,[name]:event.target.checked}));setPreview(null);}} />{label}</label>)}</details>}
        <label className="text-xs text-white/70 sm:col-span-2">Reason for change<textarea aria-label="Reason for change" value={reason} onChange={change(setReason)} className="mt-1 min-h-20 w-full rounded-lg border border-white/15 bg-black/30 p-3 focus-visible:ring-2 focus-visible:ring-emerald-300" /></label>
        <label className="flex gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={confirmYear} onChange={change(setConfirmYear)} />I understand this will recalculate my {taxYear} vehicle deduction.</label>
      </fieldset>
      {!ownershipType ? <p className="mt-3 text-xs text-white/55">Confirm whether you own or lease this vehicle before changing methods. If you’re not sure, check your vehicle records.</p> : null}
      {error ? <p role="alert" className="mt-3 text-xs text-amber-100">{unknown ? "We couldn’t confirm the save. Retry the same confirmation to check its result." : /eligib|ownership|leased/i.test(error) ? "We need to confirm your ownership and mileage eligibility before changing methods. Check your vehicle records, then try again." : /manual|override|CPA|protected|supersede/i.test(error) ? "Some expenses need a separate review before this method can change. Review them in All transactions and keep your current method for now." : "The change could not be completed. Refresh your deductions and preview the change again."}</p> : null}
      {preview ? <section aria-label="Vehicle method preview" className="mt-4 rounded-xl border border-emerald-300/20 p-3 text-xs">
        <h3 className="font-semibold">Review your updated deduction</h3>
        <p className="mt-2">{preview.affectedCount} expenses · {formatTaxCurrency(preview.beforeDeduction)} → {formatTaxCurrency(preview.afterDeduction)}</p>
        <p className="mt-1">Mileage deduction: {formatTaxCurrency(preview.beforeMileageDeduction || 0)} → {formatTaxCurrency(preview.afterMileageDeduction || 0)}</p>
        {preview.skipped?.length ? <p className="mt-2">{preview.skipped.length} expenses will keep their existing treatment.</p> : null}
        <div className="mt-3 max-h-44 overflow-y-auto">{(preview.rows || []).map(row => <p key={row.transactionId} className="py-1">{row.date ? new Date(`${row.date.slice(0,10)}T00:00:00Z`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}) : "Date unavailable"} · {row.accountName} · {formatTaxCurrency(row.previousDeductibleAmount)} → {formatTaxCurrency(row.deductibleAmount)}</p>)}</div>
      </section> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy || unknown || readOnly || reason.trim().length < 3 || !confirmYear || !ownershipType} onClick={makePreview} className="rounded-full border border-white/20 px-4 py-2 text-xs disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-emerald-300">Preview change</button>
        {preview ? <button type="button" disabled={busy || readOnly} onClick={apply} className="rounded-full bg-emerald-200 px-4 py-2 text-xs font-semibold text-black disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-white">{unknown ? "Retry same confirmation" : "Confirm change"}</button> : null}
      </div>
    </MileageMethodDialog> : null}
  </section>;
}
