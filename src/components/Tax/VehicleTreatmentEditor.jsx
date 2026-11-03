import React, { useEffect, useRef, useState } from "react";

export default function VehicleTreatmentEditor({ vehicles = [], vehicleId: initialVehicleId = "", transactionIds = [], defaultAction = "exclude", onPreview, onApply, onSaved, readOnly = false }) {
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
  return <section className="my-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.035] p-3 text-xs text-white/70">
    <button type="button" disabled={readOnly || busy || unknown} onClick={() => setOpen(!open)} className="font-semibold text-emerald-100 disabled:opacity-40">Change treatment</button>
    {saved ? <p role="status" className="mt-2 text-emerald-100">Treatment saved with audit history.</p> : null}
    {open ? <>
      <p className="mt-2">Explicit corrections can amend earlier user decisions. CPA decisions remain protected. A vehicle method or percentage amendment recalculates the entire vehicle/year.</p>
      <fieldset disabled={busy || unknown || readOnly} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label>Correction<select aria-label="Vehicle correction action" value={action} onChange={change(setAction)} className="dark-dropdown mt-1 w-full rounded-lg bg-[#151a18] p-2">
          <option value="exclude">Manually exclude selected expenses</option><option value="assign">Assign selected expenses to a vehicle</option><option value="recategorize">Recategorize selected as non-vehicle expenses</option><option value="amend">Change vehicle method or business-use percentage for the year</option><option value="correct_mileage">Correct mileage, including finalized mileage</option>
        </select></label>
        {["assign", "amend", "correct_mileage"].includes(action) ? <label>Vehicle<select aria-label="Correction vehicle" value={vehicleId} onChange={change(setVehicleId)} className="dark-dropdown mt-1 w-full rounded-lg bg-[#151a18] p-2">
          <option value="">Choose a vehicle</option>{vehicles.length <= 1 ? <option value="primary">One vehicle — reuse Primary vehicle</option> : null}
          {vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.displayName}</option>)}{action === "assign" ? <option value="new">Another vehicle — name optional</option> : null}
        </select></label> : <p className="self-end">{transactionIds.length} selected transaction{transactionIds.length === 1 ? "" : "s"}</p>}
        {action === "amend" ? <>
          <label>Method<select aria-label="Amended vehicle method" value={method} onChange={change(setMethod)} className="mt-1 w-full rounded-lg bg-[#151a18] p-2"><option value="actual_expenses">Actual Expenses</option><option value="standard_mileage">Standard Mileage</option></select></label>
          <label>Ownership<select value={ownershipType} onChange={change(setOwnershipType)} className="mt-1 w-full rounded-lg bg-[#151a18] p-2"><option value="">Unconfirmed — method changes will be blocked</option><option value="owned">Owned</option><option value="leased">Leased</option></select></label>
          {method === "actual_expenses" ? <><label>Business use %<input aria-label="Amended business use percent" type="number" min="0.01" max="100" step="0.01" value={percent} onChange={change(setPercent)} className="mt-1 w-full rounded-lg bg-black/30 p-2" /></label><label className="flex items-center gap-2"><input type="checkbox" checked={allBusiness} onChange={change(setAllBusiness)} />I explicitly confirm entirely business use if choosing 100%.</label></> : <div className="space-y-2 sm:col-span-2">{[
            ["ownedOrLeased", "I owned or leased this vehicle."], ["firstYearAvailable", "Standard Mileage was chosen in the owned vehicle’s first business-use year, or used throughout its lease including renewals."],
            ["fleetUnderFive", "I did not operate five or more vehicles simultaneously."], ["noDisallowedDepreciation", "I have not claimed MACRS, Section 179, special depreciation, or depreciation other than straight-line."]
          ].map(([name, label]) => <label key={name} className="flex gap-2"><input type="checkbox" checked={!!eligibility[name]} onChange={(event) => { setEligibility((current) => ({ ...current, [name]: event.target.checked })); setPreview(null); }} />{label}</label>)}</div>}
          <label className="flex gap-2 sm:col-span-2"><input type="checkbox" checked={confirmYear} onChange={change(setConfirmYear)} />I understand this changes the entire vehicle/year and replaces its prior method election.</label>
          <label className="flex gap-2 sm:col-span-2"><input type="checkbox" checked={supersedeManual} onChange={change(setSupersedeManual)} />Explicitly supersede earlier user overrides within this vehicle/year. Preserve CPA decisions.</label>
        </> : null}
        {action === "recategorize" ? <label>Non-vehicle tax category<select value={category} onChange={change(setCategory)} className="mt-1 w-full rounded-lg bg-[#151a18] p-2"><option value="other_business_expense">Other business expense</option><option value="office_expense">Office expense</option><option value="materials_supplies">Materials and supplies</option><option value="travel_transportation">Travel transportation</option></select></label> : null}
        {action === "correct_mileage" ? <><label className="sm:col-span-2">Replacement periods: start date, end date, business miles (one period per line)<textarea value={mileageText} onChange={change(setMileageText)} placeholder="2026-01-01, 2026-06-30, 3200" className="mt-1 w-full rounded-lg bg-black/30 p-2" /></label><label className="flex gap-2 sm:col-span-2"><input type="checkbox" checked={recordsConfirmed} onChange={change(setRecordsConfirmed)} />Mileage records support this complete replacement snapshot.</label></> : null}
        <label className="sm:col-span-2">Reason<input aria-label="Vehicle correction reason" value={reason} onChange={change(setReason)} className="mt-1 w-full rounded-lg bg-black/30 p-2" /></label>
      </fieldset>
      {error ? <p role="alert" className="mt-2 text-amber-100">{error}</p> : null}
      {preview ? <div className="mt-3 rounded-lg border border-white/15 p-3" aria-label="Vehicle correction preview"><p>{preview.affectedCount} affected · {preview.label}: ${Number(preview.beforeDeduction).toFixed(2)} → ${Number(preview.afterDeduction).toFixed(2)}</p>
        {["amend", "correct_mileage"].includes(action) ? <p>Mileage Deduction: ${Number(preview.beforeMileageDeduction || 0).toFixed(2)} → ${Number(preview.afterMileageDeduction || 0).toFixed(2)}</p> : null}
        <p>{preview.skipped.length} protected decisions preserved. Review all affected transactions before confirming.</p>
        <div className="mt-2 max-h-56 overflow-y-auto">{preview.rows.map((row) => <p key={row.transactionId}>{row.date || "Date unavailable"} · {row.accountName} · ${Math.abs(row.signedAmount).toFixed(2)} · ${row.previousDeductibleAmount.toFixed(2)} → ${row.deductibleAmount.toFixed(2)} · {row.treatment}</p>)}</div>
      </div> : null}
      <div className="mt-3 flex gap-2"><button type="button" disabled={busy || unknown || readOnly || reason.trim().length < 3} onClick={makePreview} className="rounded-full border border-white/20 px-3 py-2 disabled:opacity-40">Preview correction</button>
        {preview ? <button type="button" disabled={busy || readOnly} onClick={apply} className="rounded-full bg-emerald-200 px-3 py-2 font-semibold text-black disabled:opacity-40">{unknown ? "Retry same confirmation" : "Confirm correction"}</button> : null}
      </div>
    </> : null}
  </section>;
}
