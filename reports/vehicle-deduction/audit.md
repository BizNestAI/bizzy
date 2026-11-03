# Vehicle deduction audit — 2026-11-03 (before implementation)

Existing work preserved: TaxDashboard removal of visible stable-key text; dirty nested Claude worktree. No production actions authorized.

| Requirement | Current implementation and evidence | Status | Minimum action |
|---|---|---|---|
| 76 Gas / 70 actionable / six protected | taxGroupedDecisionPreview.service.js actionable filter, semantic manifest; taxGasMatrixMembership and taxGasPreviewDashboard.mounted tests | Correct | Retain exact membership and protected authority |
| Projection, fingerprint, retry, cancellation | taxWorkspaceProjection.service.js, taxWorkspaceRecovery.js, taxGroupedDecisionManifest.js; workspace lifecycle/recovery tests | Correct | Keep contracts untouched |
| Standard Mileage zero separate Gas | taxVehicleQuestionContract.js canonical vehicle_standard_mileage_no_separate_gas, override batch; dashboard covered-by-mileage bucket | Correct | Retain signed accounting and bookkeeping |
| Separate mileage deduction / pending | taxWorkspaceProjection.service.js mileage total; BusinessMileagePanel renders $0 without pending wording | Partial | Explicit Mileage Deduction and Mileage needed |
| No mandatory name | ReviewDecisionModal requires vehicleId; createTaxVehicle requires displayName | Conflicting | Resolve one-vehicle placeholder atomically on confirm |
| Multiple vehicles | Existing selector and allTransactionsAttributed confirmation | Partial | Ask one/multiple; block mixed batches pending allocation |
| Internal IDs and elections | tax_vehicles, tax_vehicle_method_elections migration 20261101180000 | Correct | Reuse with unique placeholder identity |
| Mileage snapshots/history | replace_tax_vehicle_mileage_entries supersedes full active set | Partial | Preserve replacement semantics; identical retry no-op; cumulative coverage tests |
| Interim YTD / rate boundaries | Effective-period entries supported; UI forces full rate-period dates | Partial | User supplies through-date within rate period |
| Multiple rates / unsupported years | vehicleMileageRates.js and tax_vehicle_mileage_rates seeded 2026 split; no fallback rates | Correct | Keep server DB rate authority; strengthen date/year validation |
| Finalization | Schema has finalized states, no user action to finalize | Missing | Add authorized, idempotent finalize path |
| Actual business use / explicit 100% | vehicleTreatmentForAnswer requires all_business or mixed percentage | Correct | Keep explicit choices and server validation |
| Actual gas-only label / positive magnitude | Generic deduction label in modal; signed batch allocation | Partial | Label Estimated deductible gas expense; verify $3,587 × 80% |
| Invalid mileage and allocations | Regex miles/percent, overlap validation; no strict calendar/year bound, empty entries preview allowed | Partial | Reject invalid/out-of-year/empty entries |
| Not sure | Modal closes without apply; server rejects unsupported method | Correct | Do not create placeholder until confirm transaction |
| Eligibility owned/leased | Three eligibility checkboxes, no lease-period confirmation | Partial | Explain first-year/lease restrictions; require lease confirmation |
| Method changes | SQL supersedes election but updates only currently actionable rows | Conflicting | Fail closed on method/percentage changes until full-year protected recalculation is available |
| Future inheritance | Account-only default ignores vehicle association | Conflicting | Keep future vehicle rows Needs Input; no automatic attribution |
| Preview/apply authority | Server reloads classifications, validates manifest, constructs batch; atomic preview wrapper | Correct | Preserve authority; validate vehicle choices inside atomic wrapper |
| Idempotency | Grouped operation/confirmation fingerprint exists; mileage replaces with duplicate audit rows on retry | Partial | Add canonical snapshot fingerprint and no-op retry |
| Tenant/RLS | Routes assertTaxBusinessAccess; service-only RLS on vehicles/elections/rates/mileage | Correct | Retain service-only grants and cross-business checks |
| Migration safety | Existing additive tables/functions and RLS | Partial | Add migration; never apply to production |
| Confirmation/audit history | grouped operations, preview manifests, classification audit, superseded mileage/elections | Correct | Retain and extend snapshot metadata |
| Broader actual expense accounts | Grouped account/category scope only | Correct | Do not silently include unrelated accounts |

Baseline focused run: 82/83 pass. Existing failure: taxGroupedDecisionPreviewContract.test.js expects visible `Stable key:` text removed by pre-existing user change. Do not restore that text.

Tax sources: https://www.irs.gov/tax-professionals/standard-mileage-rates (2026 split rates); https://www.irs.gov/taxtopics/tc510 (method eligibility). Production rate publication references must be verified before release.
