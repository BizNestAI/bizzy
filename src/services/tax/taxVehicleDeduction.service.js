import { monthlyMileageAllocation } from "./taxVehicleMileagePresentation.js";
import { createHash, randomUUID } from "node:crypto";
import { calculateVehicleMileagePeriods } from "./vehicleMileageRates.js";
import { conflictError, forbiddenBusinessError, notFoundError, validationError } from "./taxErrors.js";

export const VEHICLE_DEDUCTION_CONTRACT_VERSION = "vehicle-deduction-v1";

export async function listVehicleDeductionWorkflows({ supabase, businessId, taxYear } = {}) {
  const year = requireYear(taxYear);
  const [vehicles, elections, mileageEntries, rates] = await Promise.all([
    listRows(supabase, "tax_vehicles", (row) => row.business_id === businessId && row.status === "active", (query) => query.eq("business_id", businessId).eq("status", "active")),
    listRows(supabase, "tax_vehicle_method_elections", (row) => row.business_id === businessId && Number(row.tax_year) === year && ["active", "finalized"].includes(row.status), (query) => query.eq("business_id", businessId).eq("tax_year", year)),
    listRows(supabase, "tax_vehicle_mileage_inputs", (row) => row.business_id === businessId && Number(row.tax_year) === year && ["active", "finalized"].includes(row.status || "active") && !row.superseded_by, (query) => query.eq("business_id", businessId).eq("tax_year", year)),
    listRows(supabase, "tax_vehicle_mileage_rates", (row) => row.purpose === "business" && row.status === "active" && overlapsYear(row, year), (query) => query.eq("purpose", "business").eq("status", "active")),
  ]);
  const electionByVehicle = new Map();
  for (const vehicle of vehicles) {
    const matches = elections.filter(row => String(row.vehicle_id) === String(vehicle.id) && !row.superseded_by);
    if (matches.length === 1) electionByVehicle.set(String(vehicle.id), matches[0]);
  }
  return {
    contractVersion: VEHICLE_DEDUCTION_CONTRACT_VERSION,
    liveRefreshSupported: true,
    taxYear: year,
    rates: rates.sort(byPeriod).map(publicRate),
    vehicles: vehicles.map((vehicle) => publicWorkflow(vehicle, electionByVehicle.get(String(vehicle.id)), mileageEntries, rates)),
  };
}

export async function createTaxVehicle({ supabase, businessId, actor = {}, input = {} } = {}) {
  requireCustomer(actor);
  const displayName = text(input.displayName);
  if (!displayName || displayName.length > 120) throw validationError("invalid_vehicle_name", "Enter a vehicle name between 1 and 120 characters.");
  const ownershipType = text(input.ownershipType) || null;
  if (ownershipType && !["owned", "leased"].includes(ownershipType)) throw validationError("invalid_vehicle_ownership", "Choose owned or leased.");
  const row = {
    id: randomUUID(), business_id: businessId, display_name: displayName,
    model_year: optionalInteger(input.modelYear, 1900, 2100), make: optionalText(input.make, 80), model: optionalText(input.model, 80),
    ownership_type: ownershipType, placed_in_service_on: optionalDate(input.placedInServiceOn), status: "active", created_by: actor.userId,
  };
  if (supabase.store) {
    supabase.store.tax_vehicles ||= [];
    supabase.store.tax_vehicles.push({ ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return publicVehicle(row);
  }
  const { data, error } = await supabase.from("tax_vehicles").insert(row).select("*").single();
  if (error) throw error;
  return publicVehicle(data);
}

export async function previewVehicleMileage({ supabase, businessId, taxYear, actor = {}, input = {} } = {}) {
  requireCustomer(actor);
  const workflow = await requireStandardMileageElection({ supabase, businessId, taxYear, vehicleId: input.vehicleId });
  const rates = workflow.rates.map((rate) => ({ effectiveFrom: rate.effective_start, effectiveTo: rate.effective_end, amountPerMile: Number(rate.amount_per_mile), sourceVersion: rate.source_version }));
  if (!Array.isArray(input.entries) || !input.entries.length) throw validationError("mileage_entries_required", "Enter at least one mileage period.");
  if (input.expectedElectionId && String(input.expectedElectionId) !== String(workflow.election.id)) throw conflictError("vehicle_election_changed", "The vehicle method changed. Refresh before saving mileage.");
  const result = calculateVehicleMileagePeriods({ entries: input.entries, rates });
  if (result.periods.some((period) => period.periodStart < `${Number(taxYear)}-01-01` || period.periodEnd > `${Number(taxYear)}-12-31`)) throw validationError("mileage_outside_tax_year", "Mileage periods must be within the selected tax year.");
  const mileageBasis = text(input.mileageBasis) || "records";
  const substantiation = text(input.substantiationStatus) || "unsubstantiated";
  if (!["records", "estimate"].includes(mileageBasis) || !["unsubstantiated", "supported", "verified"].includes(substantiation)) throw validationError("invalid_mileage_support", "Choose valid mileage records and support.");
  if (input.finalize === true && (mileageBasis !== "records" || !["supported", "verified"].includes(substantiation))) throw validationError("mileage_finalization_requires_records", "Confirm supported mileage records before finalizing.");
  return {
    contractVersion: VEHICLE_DEDUCTION_CONTRACT_VERSION,
    finalized: input.finalize === true,
    vehicleId: workflow.vehicle.id,
    electionId: workflow.election.id,
    periods: [...result.periods].sort(byPeriod).map(({ periodStart, periodEnd, businessMiles, amount, amountPerMile, rateSourceVersion }) => ({ periodStart, periodEnd, businessMiles, amount, amountPerMile, rateSourceVersion })),
    totalBusinessMiles: result.totalBusinessMiles,
    totalDeduction: result.totalDeduction,
    monthlyAllocation: monthlyMileageAllocation(result.periods),
    replacesExistingActiveEntries: workflow.entries.length,
  };
}

export async function saveVehicleMileage({ supabase, businessId, taxYear, actor = {}, input = {} } = {}) {
  const preview = await previewVehicleMileage({ supabase, businessId, taxYear, actor, input });
  if (text(input.expectedElectionId) !== String(preview.electionId)) throw conflictError("vehicle_election_changed", "The vehicle method changed. Refresh before saving mileage.");
  if (input.expectedPreview && JSON.stringify({ electionId: preview.electionId, periods: preview.periods, totalDeduction: preview.totalDeduction }) !== JSON.stringify(input.expectedPreview)) throw conflictError("mileage_preview_stale", "Mileage rates or details changed. Review the updated estimate before saving.");
  const entries = preview.periods.map((period) => ({
    period_start: period.periodStart, period_end: period.periodEnd, business_miles: period.businessMiles,
    mileage_basis: text(input.mileageBasis) || "records", substantiation_status: text(input.substantiationStatus) || "unsubstantiated",
    finalize: input.finalize === true,
  }));
  if (supabase.store) return saveMileageInStore({ supabase, businessId, taxYear: Number(taxYear), actor, preview, entries });
  const { data, error } = await supabase.rpc("replace_tax_vehicle_mileage_entries", {
    p_business_id: businessId, p_tax_year: Number(taxYear), p_vehicle_id: preview.vehicleId,
    p_actor_user_id: actor.userId, p_expected_election_id: preview.electionId, p_entries: entries,
  });
  if (error) throw mapVehicleError(error);
  return { ...preview, totalDeduction: Number(data?.total_deduction ?? preview.totalDeduction), saved: true, entryIds: data?.entry_ids || [] };
}

async function requireStandardMileageElection({ supabase, businessId, taxYear, vehicleId }) {
  const year = requireYear(taxYear);
  const vehicleIdText = text(vehicleId);
  if (!vehicleIdText) throw validationError("vehicle_required", "Select a vehicle.");
  const rows = await listRows(supabase, "tax_vehicles", (row) => String(row.id) === vehicleIdText && row.business_id === businessId && row.status === "active", (query) => query.eq("id", vehicleIdText).eq("business_id", businessId).eq("status", "active"));
  const vehicle = rows[0];
  if (!vehicle) throw forbiddenBusinessError("This vehicle is not available for the current business.");
  const elections = await listRows(supabase, "tax_vehicle_method_elections", (row) => row.business_id === businessId && String(row.vehicle_id) === vehicleIdText && Number(row.tax_year) === year && ["active", "finalized"].includes(row.status), (query) => query.eq("business_id", businessId).eq("vehicle_id", vehicleIdText).eq("tax_year", year));
  const election = elections[0];
  if (!election) throw notFoundError("vehicle_election_not_found", "Choose a vehicle deduction method before adding mileage.");
  if (election.method !== "standard_mileage") throw conflictError("standard_mileage_inactive", "Mileage cannot contribute while Actual Expenses is active.");
  const [entries, rates] = await Promise.all([
    listRows(supabase, "tax_vehicle_mileage_inputs", (row) => row.business_id === businessId && String(row.vehicle_id) === vehicleIdText && Number(row.tax_year) === year && ["active", "finalized"].includes(row.status || "active") && !row.superseded_by, (query) => query.eq("business_id", businessId).eq("vehicle_id", vehicleIdText).eq("tax_year", year)),
    listRows(supabase, "tax_vehicle_mileage_rates", (row) => row.purpose === "business" && row.status === "active" && overlapsYear(row, year), (query) => query.eq("purpose", "business").eq("status", "active")),
  ]);
  return { vehicle, election, entries, rates };
}

function publicWorkflow(vehicle, election, allEntries, rates) {
  const entries = allEntries.filter((entry) => String(entry.vehicle_id) === String(vehicle.id));
  const mileageDeduction = election?.method === "standard_mileage" ? roundMoney(entries.reduce((sum, entry) => sum + Number(entry.deduction_amount || 0), 0)) : 0;
  return {
    ...publicVehicle(vehicle),
    election: election ? { id: election.id, method: election.method, status: election.status, electedBy: election.elected_by, electedAt: election.elected_at, supersededBy: election.superseded_by || null, businessUsePercent: numberOrNull(election.business_use_percent), effectiveStart: election.effective_start, effectiveEnd: election.effective_end, finalized: election.status === "finalized" } : null,
    mileage: { status: entries.length ? "entered" : election?.method === "standard_mileage" ? "needed" : "inactive", entryCount: entries.length, businessMiles: entries.reduce((sum, entry) => sum + Math.round(Number(entry.business_miles || 0) * 100), 0) / 100, deductionAmount: mileageDeduction, substantiationStatus: aggregateSubstantiation(entries), periods: entries.sort(byPeriod).map(publicMileageEntry), monthlyAllocation: monthlyMileageAllocation(entries.map(publicMileageEntry)) },
    availableRates: rates.sort(byPeriod).map(publicRate),
  };
}

function saveMileageInStore({ supabase, businessId, taxYear, actor, preview, entries }) {
  supabase.store.tax_vehicle_mileage_inputs ||= [];
  const snapshotFingerprint = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const current = supabase.store.tax_vehicle_mileage_inputs.filter((row) => row.business_id === businessId && String(row.vehicle_id) === String(preview.vehicleId) && Number(row.tax_year) === taxYear && ["active", "finalized"].includes(row.status) && !row.superseded_by);
  if (current.length && current.every((row) => row.metadata?.snapshot_fingerprint === snapshotFingerprint)) return { ...preview, saved: true, entryIds: current.map((row) => row.id) };
  const election = supabase.store.tax_vehicle_method_elections.find((row) => row.id === preview.electionId);
  if (election?.status === "finalized") throw conflictError("vehicle_election_finalized", "Finalized mileage requires a controlled amendment.");
  for (const row of supabase.store.tax_vehicle_mileage_inputs) if (row.business_id === businessId && String(row.vehicle_id) === String(preview.vehicleId) && Number(row.tax_year) === taxYear && ["active", "inactive"].includes(row.status || "active") && !row.superseded_by) row.status = "superseded";
  const now = new Date().toISOString();
  const created = entries.map((entry, index) => ({ id: randomUUID(), business_id: businessId, tax_year: taxYear, vehicle_key: preview.vehicleId, vehicle_id: preview.vehicleId, ...entry, source: "user", confirmed_by: actor.userId, confirmed_at: now, status: preview.finalized ? "finalized" : "active", finalized_at: preview.finalized ? now : null, rate_snapshot: [preview.periods[index]], deduction_amount: preview.periods[index].amount, metadata: { snapshot_fingerprint: snapshotFingerprint }, created_at: now, updated_at: now }));
  supabase.store.tax_vehicle_mileage_inputs.push(...created);
  if (preview.finalized) { election.status = "finalized"; election.finalized_at = now; }
  return { ...preview, saved: true, entryIds: created.map((row) => row.id) };
}

async function listRows(supabase, table, storeFilter, buildQuery) {
  if (supabase.store) return (supabase.store[table] || []).filter(storeFilter);
  const { data, error } = await buildQuery(supabase.from(table).select("*"));
  if (error) throw error;
  return (data || []).filter(storeFilter);
}

function publicVehicle(row) { return { id: row.id, displayName: row.display_name, modelYear: row.model_year || null, make: row.make || null, model: row.model || null, ownershipType: row.ownership_type || null, placedInServiceOn: row.placed_in_service_on || null, status: row.status }; }
function publicRate(row) { return { id: row.id || null, effectiveStart: row.effective_start || row.effectiveFrom, effectiveEnd: row.effective_end || row.effectiveTo, amountPerMile: Number(row.amount_per_mile ?? row.amountPerMile), sourceVersion: row.source_version || row.sourceVersion }; }
function publicMileageEntry(row) { return { id: row.id, periodStart: row.period_start, periodEnd: row.period_end, businessMiles: Number(row.business_miles), deductionAmount: Number(row.deduction_amount || 0), substantiationStatus: row.substantiation_status }; }
function aggregateSubstantiation(entries) { return entries.length && entries.every((entry) => ["supported", "verified"].includes(entry.substantiation_status)) ? "supported" : entries.length ? "needs_support" : "missing"; }
function overlapsYear(row, year) { return String(row.effective_start || row.effectiveFrom) <= `${year}-12-31` && String(row.effective_end || row.effectiveTo) >= `${year}-01-01`; }
function byPeriod(a, b) { return String(a.period_start || a.effective_start || a.periodStart || a.effectiveStart).localeCompare(String(b.period_start || b.effective_start || b.periodStart || b.effectiveStart)); }
function requireCustomer(actor) { if (!actor.userId || actor.source !== "user" || actor.tenantMode === "admin_view") throw forbiddenBusinessError("Customer authorization is required."); }
function requireYear(value) { const year = Number(value); if (!Number.isInteger(year) || year < 2000 || year > 2100) throw validationError("invalid_tax_year", "Enter a valid tax year."); return year; }
function optionalDate(value) { if (value == null || value === "") return null; const result = text(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw validationError("invalid_vehicle_date", "Enter a valid date."); return result; }
function optionalText(value, max) { const result = text(value); if (!result) return null; if (result.length > max) throw validationError("invalid_vehicle_field", "Vehicle details are too long."); return result; }
function optionalInteger(value, min, max) { if (value == null || value === "") return null; const result = Number(value); if (!Number.isInteger(result) || result < min || result > max) throw validationError("invalid_vehicle_year", "Enter a valid vehicle year."); return result; }
function numberOrNull(value) { return value == null ? null : Number(value); }
function text(value) { return value == null ? "" : String(value).trim(); }
function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function mapVehicleError(error) { const value = `${error?.code || ""} ${error?.message || ""}`.toLowerCase(); if (value.includes("vehicle_election_finalized")) return conflictError("vehicle_election_finalized", "Finalized mileage requires a controlled amendment."); if (value.includes("mileage_finalization_requires_records")) return validationError("mileage_finalization_requires_records", "Confirm supported mileage records before finalizing."); if (value.includes("overlap")) return conflictError("duplicate_or_overlapping_mileage", "Mileage periods overlap an existing entry."); if (value.includes("vehicle_election_changed")) return conflictError("vehicle_election_changed", "The vehicle method changed. Refresh before saving mileage."); return error; }
