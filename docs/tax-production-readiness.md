# Tax Production Readiness

Status: **Ready with warning for internal/staging QA only. Not ready for broad real-user launch until blockers below are cleared.**

## Supported Scope

Status: **Ready with warning**

Current supported product scope is sole proprietors, disregarded single-member LLCs, single-member LLCs with S-Corp election, and S-Corporations where verified federal, state, deduction, payment, reserve, and deadline rules exist for the requested tax year.

Deferred or unsupported scope remains surfaced through canonical `unsupportedItems` / `supportedButDeferred`:

- QBI calculation
- complex credits
- multi-state allocation
- unsupported local taxes
- capital gains
- partnership income
- spouse income integration
- advanced depreciation unless configured

## Rule Coverage

Status: **Not ready until launch scope is validated**

Run:

```bash
npm run tax:validate-rules -- --year=2026 --states=NC,SC,FL --entities=sole_proprietor,single_member_llc_disregarded,single_member_llc_s_corp,s_corporation
```

Production scope must not be marked supported when rules are unverified, legacy-only, conflicting, expired, or missing entity-specific state components.

## Security / RLS

Status: **Ready with warning**

`20260714_tax_security_rls_hardening.sql` adds business ownership RLS policies and global rule read-only policies. This must be applied and verified in staging with direct Supabase user-token tests before real-data QA.

Required staging checks:

- User A cannot read or mutate User B tax rows through Supabase.
- Rule tables expose only safe read rows to ordinary users.
- Immutable history tables reject ordinary user mutation.
- Service-role routes still perform backend business authorization.

## Auth / Tenancy

Status: **Ready with warning**

Tax routes use `requireAuth` at server mount, Tax router security middleware, and `assertTaxBusinessAccess` in route handlers. Route IDs must always be resolved under business scope.

Remaining staging checks:

- manipulated `businessId`
- manipulated `runId`
- manipulated `transactionId`
- manipulated `paymentId`
- manipulated `reserveAccountId`
- legacy snapshot IDs
- export routes

## Environment

Status: **Ready**

`taxEnvironmentSafety` blocks implicit mock/legacy fallback flags in production. Demo mode remains explicit. Internal scheduler routes require `TAX_SCHEDULER_INTERNAL_SECRET`.

## Automation

Status: **Ready with warning**

Event-driven and scheduled jobs use canonical recalculation requests, fingerprints, locks, and worker retry/dead-letter behavior. Cron and event routes must remain internal-only.

## Observability

Status: **Ready with warning**

Existing structured tax-change, scheduler, and recalculation logs are safe. Production monitoring still needs dashboard wiring for:

- calculation success/partial/failure
- p50/p95 duration
- queue depth
- dead letters
- stale running runs
- rule coverage failures
- cross-business denial counts
- export counts
- reconciliation failures
- low-confidence calculation counts

## Performance

Status: **Ready with warning**

Prompt 34 added a >1,000 transaction QA test. Before broad launch, run business QA against staging businesses with 10,000+ classifications and inspect database plans for deductions transactions, source references, exports, components, and calculation runs.

## Failure Recovery

Status: **Ready with warning**

Canonical runs are not marked complete if component persistence fails. Recalculation requests retry and dead-letter. Scheduler locks can be reclaimed. Export interruption and database timeout paths still need staging/chaos verification.

## Known Limitations

- Rule coverage must be validated for each launch state/entity/year.
- The nine no-broad-individual-earned-income-tax states have verified individual zero treatment only. Entity/business caveats keep total state liability partial until Pack 4 state-specific entity rules are encoded.
- Provisional state reserve guidance is not a calculated state liability and must not be treated as an estimated payment obligation.
- Direct Supabase RLS behavior must be verified against a real isolated test database.
- Public share links for legacy snapshots should remain retired.
- Production metrics dashboards are not fully provisioned by this repo change.
- QA tooling is read-only and does not auto-fix production data.

## Blockers

1. Apply and verify `20260714_tax_security_rls_hardening.sql` in staging.
2. Run `npm run tax:production-audit -- --json` in CI/staging with production-like environment variables.
3. Run `npm run tax:validate-rules` for the exact launch state/entity/year scope.
4. Run `npm run tax:qa-business` against representative staging businesses with real posted transactions.
5. Add an isolated Supabase user-token RLS test database job before external real-user rollout.

## Launch Checklist

- [ ] RLS migration applied
- [ ] Cross-business API tests pass
- [ ] Direct Supabase RLS tests pass
- [ ] Production audit passes
- [ ] Launch rule scope passes
- [ ] Representative business QA reports pass or have accepted warnings
- [ ] Scheduler secret configured
- [ ] Mock flags disabled
- [ ] Export audit logging monitored
- [ ] Dead-letter and failure alerts monitored

## Final Recommendation

Use the current Tax module for internal real-data QA and CPA review after staging RLS verification. Do not mark the module broadly production-ready until the blockers above are closed for the intended launch scope.
