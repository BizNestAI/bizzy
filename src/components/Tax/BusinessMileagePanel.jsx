import React, { useEffect, useRef, useState } from 'react';
import VehicleTreatmentEditor from './VehicleTreatmentEditor.jsx';
import { formatTaxCurrency as money } from './taxCurrency.js';
import { calculateVehicleMileagePeriods } from '../../services/tax/vehicleMileageRates.js';
import { mileageMonthFields } from '../../services/tax/taxVehicleMileagePresentation.js';

const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
const monthName = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
const periodLabel = rate => `${monthName(rate.effectiveStart)}–${monthName(rate.effectiveEnd)} ${rate.effectiveStart.slice(0,4)}`;
const fieldClass = 'mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/50';

export default function BusinessMileagePanel({ workflows, gasContext, projectionKey = '', taxYear, expanded = false, readOnly, onPreview, onSave, onMethodPreview, onMethodApply }) {
  const vehicles = workflows?.vehicles || [];
  return <div className="mt-4 space-y-3">
    {vehicles.filter(v => v.election?.method === 'standard_mileage').map(vehicle => <MileageVehicle
      key={`${vehicle.id}:${vehicle.election.id}:${JSON.stringify(vehicle.mileage?.periods || [])}`}
      {...{ vehicle, vehicles, gasContext, projectionKey, taxYear: taxYear || workflows?.taxYear || gasContext?.taxYear || Number(vehicle.election.effectiveStart?.slice(0,4) || vehicle.availableRates?.[0]?.effectiveStart?.slice(0,4)), expanded, readOnly, onPreview, onSave, onMethodPreview, onMethodApply }} />)}
    {vehicles.filter(v => v.election?.method === 'actual_expenses').map(vehicle => <VehicleTreatmentEditor key={vehicle.id} vehicles={vehicles} vehicleId={vehicle.id} defaultAction="amend" triggerLabel="Change vehicle method" compact methodOnly taxYear={taxYear || workflows?.taxYear || gasContext?.taxYear || Number(vehicle.election.effectiveStart?.slice(0,4))} readOnly={readOnly} onPreview={onMethodPreview} onApply={onMethodApply} />)}
  </div>;
}

function GasContext({ context, vehicleId }) {
  if (!context) return <p className="text-xs text-white/55">Gas purchases are unavailable. Refresh to load your totals.</p>;
  const rows = [{ label: `${context.taxYear} total`, ...context.total }, ...context.periods.map(p => ({ ...p, label: `${monthName(p.effectiveStart)}–${monthName(p.effectiveEnd)}` }))];
  return <section aria-label="Gas purchases" className="my-3 rounded-xl border border-white/10 p-3 text-xs text-white/65">
    <h3 className="mb-2 font-semibold text-white/85">Gas purchases</h3>
    <dl>{rows.map(row => <div key={row.label} className="flex flex-wrap justify-between gap-2 py-1"><dt>{row.label}</dt><dd>{number(row.transactionCount)} transactions · {money(row.grossExpenseAmount)}</dd></div>)}</dl>
    <p className="mt-2 font-medium text-white/75">{number(context.byVehicle?.[vehicleId]?.transactionCount || 0)} assigned to this vehicle · {number(context.requiresSeparateConfirmation?.transactionCount || 0)} still need review</p>
    <p className="mt-1">Gas purchases do not affect your mileage deduction.</p>
  </section>;
}

export function MileageVehicle({ vehicle, vehicles = [], gasContext, projectionKey, taxYear, expanded = false, readOnly, onPreview, onSave, onMethodPreview, onMethodApply }) {
  const rates = vehicle.availableRates || [];
  const savedPeriods = vehicle.mileage?.periods || [];
  const savedMiles = members => members.length ? members.reduce((sum,p)=>sum+Math.round(Number(p.businessMiles)*100),0)/100 : "";
  const [periodValues, setPeriodValues] = useState(() => Object.fromEntries(rates.map(r => [r.effectiveStart, savedMiles(savedPeriods.filter(p => p.periodStart >= r.effectiveStart && p.periodEnd <= r.effectiveEnd))])));
  const [monthlyMode, setMonthlyMode] = useState(() => Object.fromEntries(rates.map(r => [r.effectiveStart, savedPeriods.some(p => p.periodStart >= r.effectiveStart && p.periodEnd <= r.effectiveEnd && p.periodStart.slice(0,7)===p.periodEnd.slice(0,7)) && !savedPeriods.some(p => p.periodStart >= r.effectiveStart && p.periodEnd <= r.effectiveEnd && p.periodStart.slice(0,7)!==p.periodEnd.slice(0,7))])));
  const [monthlyValues, setMonthlyValues] = useState(() => Object.fromEntries(rates.flatMap(mileageMonthFields).map(m => [m.key, savedMiles(savedPeriods.filter(p => p.periodStart.slice(0,7)===m.key && p.periodEnd.slice(0,7)===m.key))])));
  const [monthlyOpen, setMonthlyOpen] = useState({});
  const [monthlyTouched, setMonthlyTouched] = useState({});
  const [periodTouched, setPeriodTouched] = useState({});
  const [pendingSwitch, setPendingSwitch] = useState(null);
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
    if (rates.some(r => monthlyMode[r.effectiveStart] && !mileageMonthFields(r).some(m => monthlyValues[m.key] !== ""))) throw new Error("Add mileage for at least one month.");
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
    if(!previewMatches || !local || rateMismatch || !supported || saving || locked || pendingSwitch) return;
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

  const monthEntries = (rate, values = monthlyValues) => mileageMonthFields(rate).map(m => ({ periodStart: m.periodStart, periodEnd: m.periodEnd, businessMiles: values[m.key] === '' ? 0 : values[m.key] }));
  const monthlyResult = (rate, values = monthlyValues) => {
    if (!mileageMonthFields(rate).some(m => values[m.key] !== '')) return null;
    try { return calculateVehicleMileagePeriods({ entries: monthEntries(rate, values), rates: rateInputs }); } catch { return null; }
  };
  const changeMonth = (rate, month, value) => {
    const next = { ...monthlyValues, [month]: value };
    setMonthlyValues(next); setMonthlyTouched(v => ({ ...v, [rate.effectiveStart]: true })); setSavedMessage('');
    if (!monthlyMode[rate.effectiveStart]) {
      const result = monthlyResult(rate, next);
      const prior = periodValues[rate.effectiveStart];
      if (prior !== '' && (result == null || Number(prior) !== result.totalBusinessMiles)) setPendingSwitch({ rateStart: rate.effectiveStart });
      else { setMonthlyMode(v => ({ ...v, [rate.effectiveStart]: true })); setPendingSwitch(null); }
    }
  };
  const status = vehicle.election.finalized ? 'Finalized' : savedPeriods.length ? 'Estimate saved' : 'Mileage needed';
  const Container = expanded ? 'section' : 'details';
  const Heading = expanded ? 'div' : 'summary';
  return <Container className="rounded-2xl border border-sky-300/20 bg-sky-300/[0.035] p-4 sm:p-5" aria-label={`${vehicle.displayName} mileage deduction`}>
    <Heading className={expanded ? 'text-sm text-white/85' : 'cursor-pointer rounded-lg text-sm text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60'}>
      <span className="flex flex-wrap items-center justify-between gap-2"><span className="text-base font-semibold">Mileage deduction</span><span className="rounded-full border border-white/10 px-2 py-1 text-[11px] text-white/65">{status}</span></span>
      <span className="mt-1 block text-xs text-white/55">Standard mileage · {vehicle.displayName}</span>
      {savedPeriods.length ? <span className="mt-2 block text-xs text-white/70">{number(vehicle.mileage.businessMiles)} business miles · {money(vehicle.mileage.deductionAmount)} estimated deduction</span> : null}
    </Heading>
    <p className="mt-3 text-xs text-white/60">Enter your business miles. Bizzi applies the correct mileage rate, and Gas expenses are not deducted separately.</p>
    <GasContext context={gasContext} vehicleId={vehicle.id} />
    {!locked ? <fieldset disabled={saving} className="grid min-w-0 gap-5 lg:grid-cols-2">
      {rates.map(rate => {
        const rateKey = rate.effectiveStart;
        const months = mileageMonthFields(rate);
        const halfLabel = `${monthName(rate.effectiveStart)}–${monthName(rate.effectiveEnd)}`;
        const draft = monthlyResult(rate);
        const hasMonthlyAnswer = months.some(m => monthlyValues[m.key] !== '');
        let result = null;
        try { if (!monthlyMode[rateKey] || hasMonthlyAnswer) result = calculateVehicleMileagePeriods({ entries: entries.filter(p=>p.periodStart>=rate.effectiveStart && p.periodEnd<=rate.effectiveEnd), rates: rateInputs }); } catch { /* Input errors are shown only after interaction. */ }
        const monthError = monthlyOpen[rateKey] && monthlyTouched[rateKey] && !draft;
        const periodError = !monthlyMode[rateKey] && periodTouched[rateKey] && !result;
        return <section key={rateKey} className="min-w-0" aria-label={periodLabel(rate)}>
          <h3 className="text-xs font-medium text-white/70">{periodLabel(rate)} · {number(rate.amountPerMile*100)}¢ per mile</h3>
          <label className="mt-2 block text-xs text-white/55">Business miles
            <input className={fieldClass} type="text" inputMode="decimal" placeholder="Business miles" aria-label={`${periodLabel(rate)} business miles`}
              value={monthlyMode[rateKey] ? result ? number(result.totalBusinessMiles) : '' : periodValues[rateKey]}
              readOnly={monthlyMode[rateKey]} aria-invalid={periodError || undefined}
              onBlur={() => setPeriodTouched(v=>({...v,[rateKey]:true}))}
              onChange={e=>{updatePeriod(rateKey,e.target.value);setPeriodTouched(v=>({...v,[rateKey]:true}));}} />
          </label>
          {result || (!monthlyMode[rateKey] && periodValues[rateKey] === "") || (monthlyMode[rateKey] && !hasMonthlyAnswer) ? <p className="mt-2 text-xs text-emerald-100" aria-live="polite">{result?.totalBusinessMiles ? `${number(result.totalBusinessMiles)} miles × ${number(rate.amountPerMile*100)}¢ = ${money(result.totalDeduction)} estimated deduction` : `Estimated deduction: ${money(0)}`}</p> : null}
          {periodError ? <p role="alert" className="mt-2 text-xs text-amber-100">Enter valid business miles.</p> : null}
          <details className="mt-3 text-xs text-white/65" onToggle={event=>{const isOpen=event.currentTarget.open;setMonthlyOpen(v=>({...v,[rateKey]:isOpen}));}}>
            <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60">Add miles by month</summary>
            <p className="mt-2">Add monthly mileage to show deductions by month in the matrix.</p>
            <p className="my-2">Enter business miles by month. Blank months count as 0.</p>
            <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-3">
              {months.map(m => <label key={m.key} className="min-w-0 text-xs">{m.label}
                <span className="relative block"><input className={`${fieldClass} pr-12 ${monthError ? 'border-amber-200/40' : ''}`} type="text" inputMode="decimal" placeholder="0" aria-label={`${m.label} ${rate.effectiveStart.slice(0,4)} business miles`} aria-invalid={monthError || undefined}
                  value={monthlyValues[m.key]} onBlur={()=>setMonthlyTouched(v=>({...v,[rateKey]:true}))} onChange={e=>changeMonth(rate,m.key,e.target.value)} /><span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-white/40">miles</span></span>
              </label>)}
            </div>
            {monthError ? <p role="alert" className="mt-2 text-xs text-amber-100">{hasMonthlyAnswer ? 'Enter valid business miles.' : 'Add mileage for at least one month.'}</p> : null}
            {pendingSwitch?.rateStart === rateKey ? <div className="mt-3 rounded-lg border border-amber-200/20 p-3" role="alert">
              <p>Use monthly mileage for {halfLabel}? This will replace the period total in this estimate. Your period and monthly entries will be kept while you edit.</p>
              <div className="mt-2 flex flex-wrap gap-3"><button type="button" disabled={!draft} className="underline disabled:opacity-40 focus-visible:ring-2" onClick={()=>{setMonthlyMode(v=>({...v,[rateKey]:true}));setPendingSwitch(null);}}>Use monthly mileage</button><button type="button" className="underline focus-visible:ring-2" onClick={()=>setPendingSwitch(null)}>Keep period total</button></div>
            </div> : null}
            {monthlyMode[rateKey] ? <button className="mt-3 underline focus-visible:ring-2 disabled:opacity-40" type="button" disabled={!draft} onClick={()=>{setPeriodValues(v=>({...v,[rateKey]:String(draft.totalBusinessMiles)}));setMonthlyMode(v=>({...v,[rateKey]:false}));setPendingSwitch(null);}}>Enter one total for {halfLabel}</button> : null}
            {!monthlyMode[rateKey] && hasMonthlyAnswer && !pendingSwitch ? <button type="button" className="mt-3 underline focus-visible:ring-2" onClick={()=>{const prior=periodValues[rateKey];if(prior!=='' && (!draft || Number(prior)!==draft.totalBusinessMiles))setPendingSwitch({rateStart:rateKey});else setMonthlyMode(v=>({...v,[rateKey]:true}));}}>Use monthly mileage</button> : null}
          </details>
        </section>;
      })}
    </fieldset> : null}
    {!locked && local ? <div className="mt-4 rounded-xl border border-emerald-300/15 p-3 text-sm text-emerald-100" aria-live="polite">Estimated deduction: {money(previewMatches ? server.value.totalDeduction : local.totalDeduction)}<span className="mt-1 block text-xs text-white/60">{number(local.totalBusinessMiles)} miles</span></div> : null}
    {!locked && invalid && /accepted range|Annual|outside/i.test(invalid) ? <p role="alert" className="mt-2 text-xs text-amber-100">{invalid}</p> : null}
    {!locked ? <>
      <label className="mt-4 flex gap-2 text-xs text-white/65"><input type="checkbox" disabled={saving} checked={supported} onChange={e=>setSupported(e.target.checked)} />I have mileage records supporting these business miles.</label>
      {local && !previewMatches && !error ? <p className="mt-2 text-xs text-white/50" role="status">Checking your mileage estimate…</p> : null}
      {rateMismatch ? <p role="alert" className="mt-2 text-xs text-amber-100">Mileage rates changed. Refresh to use the current rates before saving.</p> : null}
      <div className="mt-4 flex justify-end"><button type="button" disabled={!local || !supported || !previewMatches || rateMismatch || Boolean(error) || saving || Boolean(pendingSwitch)} onClick={save} className="rounded-full bg-emerald-300 px-4 py-2 text-xs font-semibold text-black disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-white">{saving?'Saving…':'Save mileage'}</button></div>
    </> : null}
    <VehicleTreatmentEditor vehicles={vehicles} vehicleId={vehicle.id} defaultAction="amend" triggerLabel="Change vehicle method" compact methodOnly taxYear={taxYear} readOnly={readOnly || saving} onPreview={onMethodPreview} onApply={onMethodApply} />
    {!locked ? <details className="mt-3 text-xs text-white/50"><summary className="cursor-pointer rounded focus-visible:ring-2">Year-end options</summary><p className="mt-2">Finalizing confirms your annual mileage amount. Later changes require an explicit correction.</p><label className="mt-2 flex gap-2"><input type="checkbox" disabled={saving} checked={finalize} onChange={e=>setFinalize(e.target.checked)} />Finalize year-end mileage</label></details> : null}
    {error ? <p role="alert" className="mt-2 text-xs text-rose-200">{error}</p> : null}
    {savedMessage ? <p role="status" className="mt-2 text-xs text-emerald-100">{savedMessage}</p> : null}
  </Container>;
}
