import React, { useEffect, useRef, useState } from 'react';
import VehicleTreatmentEditor from './VehicleTreatmentEditor.jsx';
import { calculateVehicleMileagePeriods } from '../../services/tax/vehicleMileageRates.js';
import { mileageMonthFields } from '../../services/tax/taxVehicleMileagePresentation.js';

const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
const money = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const monthName = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
const periodLabel = rate => `${monthName(rate.effectiveStart)}–${monthName(rate.effectiveEnd)} ${rate.effectiveStart.slice(0,4)}`;
const fieldClass = 'mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/50';

export default function BusinessMileagePanel({ workflows, gasContext, projectionKey = '', readOnly, onPreview, onSave, onMethodPreview, onMethodApply }) {
  const vehicles = workflows?.vehicles || [];
  return <div className="mt-4 space-y-3">
    {vehicles.filter(v => v.election?.method === 'standard_mileage').map(vehicle => <MileageVehicle
      key={`${vehicle.id}:${vehicle.election.id}:${JSON.stringify(vehicle.mileage?.periods || [])}`}
      {...{ vehicle, vehicles, gasContext, projectionKey, readOnly, onPreview, onSave, onMethodPreview, onMethodApply }} />)}
    {vehicles.filter(v => v.election?.method === 'actual_expenses').map(vehicle => <VehicleTreatmentEditor key={vehicle.id} vehicles={vehicles} vehicleId={vehicle.id} defaultAction="amend" triggerLabel="Change vehicle method" compact readOnly={readOnly} onPreview={onMethodPreview} onApply={onMethodApply} />)}
  </div>;
}

function GasContext({ context, vehicleId }) {
  if (!context) return <p className="text-xs text-white/55">Gas expense context is unavailable. Refresh to load your books.</p>;
  const rows = [{ label: `${context.taxYear} total`, ...context.total }, ...context.periods.map(p => ({ ...p, label: `${monthName(p.effectiveStart)}–${monthName(p.effectiveEnd)}` }))];
  return <section aria-label="Gas expenses in your books" className="my-3 rounded-xl border border-white/10 p-3 text-xs text-white/65">
    <h3 className="mb-2 font-semibold text-white/85">Gas expenses in your books</h3>
    <dl>{rows.map(row => <div key={row.label} className="flex flex-wrap justify-between gap-2 py-1"><dt>{row.label}</dt><dd>{number(row.transactionCount)} transactions · {money(row.grossExpenseAmount)}</dd></div>)}</dl>
    <p className="mt-2">{number(context.byVehicle?.[vehicleId]?.transactionCount || 0)} covered by this vehicle’s Standard Mileage decision. {number(context.requiresSeparateConfirmation?.transactionCount || 0)} require separate confirmation across your books.</p>
    <p className="mt-1">Gas expenses are shown for context and do not determine your mileage deduction.</p>
  </section>;
}

export function MileageVehicle({ vehicle, vehicles = [], gasContext, projectionKey, readOnly, onPreview, onSave, onMethodPreview, onMethodApply }) {
  const rates = vehicle.availableRates || [];
  const savedPeriods = vehicle.mileage?.periods || [];
  const savedMiles = members => members.length ? members.reduce((sum,p)=>sum+Math.round(Number(p.businessMiles)*100),0)/100 : "";
  const [periodValues, setPeriodValues] = useState(() => Object.fromEntries(rates.map(r => [r.effectiveStart, savedMiles(savedPeriods.filter(p => p.periodStart >= r.effectiveStart && p.periodEnd <= r.effectiveEnd))])));
  const [monthlyMode, setMonthlyMode] = useState(() => Object.fromEntries(rates.map(r => [r.effectiveStart, savedPeriods.some(p => p.periodStart >= r.effectiveStart && p.periodEnd <= r.effectiveEnd && p.periodStart.slice(0,7)===p.periodEnd.slice(0,7)) && !savedPeriods.some(p => p.periodStart >= r.effectiveStart && p.periodEnd <= r.effectiveEnd && p.periodStart.slice(0,7)!==p.periodEnd.slice(0,7))])));
  const [monthlyValues, setMonthlyValues] = useState(() => Object.fromEntries(rates.flatMap(mileageMonthFields).map(m => [m.key, savedMiles(savedPeriods.filter(p => p.periodStart.slice(0,7)===m.key && p.periodEnd.slice(0,7)===m.key))])));
  const [supported, setSupported] = useState(vehicle.mileage?.substantiationStatus === 'supported');
  const [finalize, setFinalize] = useState(false);
  const [server, setServer] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const callbacks = useRef({ onPreview, onSave }); callbacks.current = { onPreview, onSave };
  const locked = readOnly || vehicle.election?.finalized;
  const rateInputs = rates.map(r => ({effectiveFrom:r.effectiveStart,effectiveTo:r.effectiveEnd,amountPerMile:r.amountPerMile,sourceVersion:r.sourceVersion}));
  const entries = rates.flatMap(rate => monthlyMode[rate.effectiveStart]
    ? mileageMonthFields(rate).map(m=>({periodStart:m.periodStart,periodEnd:m.periodEnd,businessMiles:monthlyValues[m.key] === '' ? 0 : monthlyValues[m.key]}))
    : [{periodStart:rate.effectiveStart,periodEnd:rate.effectiveEnd,businessMiles:periodValues[rate.effectiveStart]}]);
  let local = null, invalid = '';
  try {
    if (rates.some(r => monthlyMode[r.effectiveStart] && !mileageMonthFields(r).some(m => monthlyValues[m.key] !== ""))) throw new Error("Enter business miles for at least one month in each expanded period.");
    if (!rates.length || !entries.length || entries.some(e=>e.businessMiles==='' || e.businessMiles==null)) throw new Error('Enter business miles for each period.');
    local = calculateVehicleMileagePeriods({entries,rates:rateInputs});
  } catch(caught) { invalid = caught.message; }
  const requestKey = JSON.stringify({entries, rates:rateInputs, electionId:vehicle.election.id, supported, finalize, projectionKey});
  const previewMatches = server?.key === requestKey && server.value.electionId === vehicle.election.id;
  const periodSignature = periods => JSON.stringify((periods || []).map(p => [p.periodStart,p.periodEnd,p.businessMiles,p.amount,p.amountPerMile,p.rateSourceVersion || null]));
  const rateMismatch = previewMatches && (server.value.totalDeduction !== local?.totalDeduction || server.value.totalBusinessMiles !== local?.totalBusinessMiles || periodSignature(server.value.periods) !== periodSignature(local?.periods));
  const activeKey = useRef(requestKey); activeKey.current = requestKey;
  useEffect(() => {
    setServer(null); setError('');
    if (!local || locked) return undefined;
    const controller = new AbortController();
    let expired = false;
    const deadline = setTimeout(()=>{ expired=true; controller.abort(); if(activeKey.current===requestKey)setError('Mileage validation timed out. Edit a value to try again.'); },12000);
    const timer = setTimeout(async()=>{
      try {
        const value = await callbacks.current.onPreview({vehicleId:vehicle.id,expectedElectionId:vehicle.election.id,entries,substantiationStatus:supported?'supported':'unsubstantiated',finalize,signal:controller.signal});
        if (!expired && !controller.signal.aborted && activeKey.current===requestKey) setServer({key:requestKey,value});
      } catch(caught) { if(!controller.signal.aborted && activeKey.current===requestKey)setError(caught.message || 'Mileage could not be validated.'); }
      finally { clearTimeout(deadline); }
    },200);
    return ()=>{ controller.abort();clearTimeout(timer);clearTimeout(deadline); };
    // requestKey includes every input and server identity. Callbacks are refs so
    // dashboard rerenders cannot restart or accept a stale request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[requestKey,locked]);
  const save = async()=>{
    if(!previewMatches || !local || rateMismatch || !supported || saving || locked) return;
    const key = requestKey;
    const expectedPreview={electionId:server.value.electionId,periods:server.value.periods,totalDeduction:server.value.totalDeduction};
    setSaving(true);setError('');setSavedMessage('');
    try {
      const result=await callbacks.current.onSave({vehicleId:vehicle.id,expectedElectionId:vehicle.election.id,entries,expectedPreview,substantiationStatus:'supported',finalize});
      if(activeKey.current===key) {
        setServer(null);
        setSavedMessage(`Saved mileage deduction: ${money(result.totalDeduction)}. Your deductions have been refreshed.`);
      }
    } catch(caught) { setServer(null);setError(caught.message || 'Mileage could not be saved. Refresh to check the saved amount before retrying.'); }
    finally {setSaving(false);}
  };
  const updatePeriod=(key,value)=>{setPeriodValues(v=>({...v,[key]:value}));setSavedMessage('');};
  const summary=vehicle.election.finalized?'Finalized':savedPeriods.length?'Estimate saved':'Mileage needed · Add business miles';
  return <details className="rounded-2xl border border-sky-300/20 bg-sky-300/[0.035] p-4" aria-label={`${vehicle.displayName} mileage deduction`}>
    <summary className="cursor-pointer rounded-lg text-sm text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60">
      <span className="font-semibold">Mileage deduction · Standard mileage</span><span className="ml-2 text-xs text-white/55">{vehicle.displayName}</span>
      <span className="mt-1 block text-xs text-white/65">{summary}{savedPeriods.length ? ` · ${number(vehicle.mileage.businessMiles)} business miles · ${money(vehicle.mileage.deductionAmount)} estimated deduction` : ''}</span>
    </summary>
    <p className="mt-3 text-xs text-white/60">Enter the business miles you drove during each period. Bizzi applies the applicable mileage rate. Your Gas expenses stay in your books but are not deducted separately.</p>
    <VehicleTreatmentEditor vehicles={vehicles} vehicleId={vehicle.id} defaultAction="amend" triggerLabel="Change vehicle method" compact readOnly={readOnly || saving} onPreview={onMethodPreview} onApply={onMethodApply} />
    <GasContext context={gasContext} vehicleId={vehicle.id} />
    {!locked ? <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
      {rates.map(rate=>{const months=mileageMonthFields(rate); let groupPreview = null; try { groupPreview = calculateVehicleMileagePeriods({ entries: entries.filter(p=>p.periodStart>=rate.effectiveStart && p.periodEnd<=rate.effectiveEnd), rates: rateInputs }); } catch { /* Invalid groups do not display an amount. */ } const members=groupPreview?.periods || []; const total=members.reduce((sum,p)=>sum+Math.round(p.businessMiles*100),0)/100; const amount=members.reduce((sum,p)=>sum+Math.round(p.amount*100),0)/100;
        return <div key={rate.effectiveStart}>
          <label className="text-xs text-white/65">{periodLabel(rate)} · {number(rate.amountPerMile*100)}¢ per mile
            <input className={fieldClass} type="text" inputMode="decimal" aria-label={`${periodLabel(rate)} business miles`} value={monthlyMode[rate.effectiveStart] ? number(total) : periodValues[rate.effectiveStart]} readOnly={monthlyMode[rate.effectiveStart]} onChange={e=>updatePeriod(rate.effectiveStart,e.target.value)} />
          </label>
          {groupPreview ? <p className="mt-2 text-xs text-emerald-100">{number(total)} miles {monthlyMode[rate.effectiveStart] ? "·" : "×"} ${Number(rate.amountPerMile).toFixed(3)} {monthlyMode[rate.effectiveStart] ? "per mile ·" : "="} {money(amount)}{monthlyMode[rate.effectiveStart] ? " (sum of monthly deductions)" : ""}</p> : null}
          <details className="mt-3 text-xs text-white/65" onToggle={e=>{if(e.currentTarget.open && !monthlyMode[rate.effectiveStart]) {setMonthlyMode(v=>({...v,[rate.effectiveStart]:true}));}}}>
            <summary className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60">Enter monthly breakdown</summary>
            {monthlyMode[rate.effectiveStart] ? <><p className="my-2">Enter each month’s business miles. Blank months count as zero. The period total is calculated from these months.</p>
              {months.map(m=><label key={m.key} className="mt-2 block">{m.label}<input className={fieldClass} type="text" inputMode="decimal" aria-label={`${m.label} business miles`} value={monthlyValues[m.key]} onChange={e=>{setMonthlyValues(v=>({...v,[m.key]:e.target.value}));setSavedMessage('');}} /></label>)}
              <button className="mt-2 underline focus-visible:ring-2" type="button" onClick={()=>{setPeriodValues(v=>({...v,[rate.effectiveStart]:String(total)}));setMonthlyMode(v=>({...v,[rate.effectiveStart]:false}));}}>Use period total instead</button>
            </> : null}
          </details>
        </div>;})}
    </fieldset> : null}
    {!locked && local ? <div className="mt-3 rounded-xl border border-emerald-300/20 p-3 text-sm text-emerald-100" aria-live="polite">Estimated mileage deduction: {money(previewMatches ? server.value.totalDeduction : local.totalDeduction)}<span className="mt-1 block text-xs">{number(local.totalBusinessMiles)} miles</span></div> : null}
    {!locked && invalid ? <p role="status" className="mt-2 text-xs text-white/55">{invalid}</p> : null}
    {!locked ? <>
      <label className="mt-3 flex gap-2 text-xs text-white/65"><input type="checkbox" disabled={saving} checked={supported} onChange={e=>setSupported(e.target.checked)} />I have mileage records supporting these business miles.</label>
      <details className="mt-3 text-xs text-white/60"><summary className="cursor-pointer focus-visible:ring-2">Year-end options</summary><p className="mt-2">Finalizing locks your annual amount. Future corrections require review.</p><label className="mt-2 flex gap-2"><input type="checkbox" disabled={saving} checked={finalize} onChange={e=>setFinalize(e.target.checked)} />Finalize year-end mileage</label></details>
      {local && !previewMatches && !error ? <p className="mt-2 text-xs text-white/50" role="status">Checking your mileage estimate…</p> : null}
      {rateMismatch ? <p role="alert" className="mt-2 text-xs text-amber-100">Mileage rates changed. Refresh to use the current rates before saving.</p> : null}
      <div className="mt-3 flex justify-end"><button type="button" disabled={!local || !supported || !previewMatches || rateMismatch || Boolean(error) || saving} onClick={save} className="rounded-full bg-emerald-300 px-4 py-2 text-xs font-semibold text-black disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-white">{saving?'Saving…':'Save mileage'}</button></div>
    </> : null}
    {(vehicle.mileage?.monthlyAllocation?.status !== 'complete' || !Object.values(monthlyMode).every(Boolean)) ? <p className="mt-3 text-xs text-white/55">Add monthly mileage to show your deduction by month. Period totals are included in your annual deduction; monthly allocation is unavailable without a breakdown.</p> : null}
    {error ? <p role="alert" className="mt-2 text-xs text-rose-200">{error}</p> : null}
    {savedMessage ? <p role="status" className="mt-2 text-xs text-emerald-100">{savedMessage}</p> : null}
  </details>;
}
