# Mileage Deduction UI refinement

1. Components changed

BusinessMileagePanel now owns the single collapsed Mileage deduction card beneath the navigation tabs. TaxDashboard no longer renders the duplicate tab-adjacent text button. The summary separates title, Standard mileage / vehicle identity, state badge and saved miles / deduction. VehicleTreatmentEditor has a presentation-only method mode, opened in the new MileageMethodDialog. Existing transaction correction mode and its controlled preview/apply contract remain available. Retained uncommitted dark-dropdown changes were preserved; Tab now closes the dark listbox to allow normal form navigation. Tax currency wrappers and the relevant mounted/source tests were updated.

No authoritative service, API, rate, database or migration files changed. No transaction population, election, protected-decision rule, snapshot history, calculation, authorization, projection identity or matrix composition contract changed.

2. Copy removed and added

| Removed | Added |
|---|---|
| Tab-adjacent Mileage deduction text action | One Mileage deduction title in the card |
| Mileage deduction · Standard mileage / Mileage needed · Add business miles | Mileage deduction; Standard mileage · Primary vehicle; Mileage needed badge (or Estimate saved / Finalized) |
| Enter the business miles you drove during each period… | Enter your business miles. Bizzi applies the correct mileage rate, and Gas expenses are not deducted separately. |
| Gas expenses in your books | Gas purchases |
| 70 covered by this vehicle’s Standard Mileage decision. 26 require separate confirmation across your books. | 70 assigned to this vehicle · 26 still need review (both values remain server-owned and dynamic) |
| Gas expenses are shown for context and do not determine your mileage deduction. | Gas purchases do not affect your mileage deduction. |
| Dollar rates, sum of monthly deductions and snapshot wording | Estimated deduction: $0; populated example: 1,000 miles × 72.5¢ = $725 estimated deduction |
| Enter monthly breakdown | Add miles by month |
| Enter each month’s business miles. Blank months count as zero… | Add monthly mileage to show deductions by month in the matrix. Enter business miles by month. Blank months count as 0. |
| Use period total instead | Enter one total for January–June / Enter one total for July–December |
| Validation shown on opening a disclosure | Add mileage for at least one month, only while the relevant disclosure is open and touched |
| Inline method-amendment form, internal override/precedence controls | Separate Change vehicle method modal: This will update your [selected year] vehicle deduction. |
| Internal ownership status | Owned / Leased / I’m not sure |
| Entire vehicle/year implementation confirmation | I understand this will recalculate my [selected year] vehicle deduction. |
| Final year-end snapshot/amendment mechanics | Finalizing confirms your annual mileage amount. Later changes require an explicit correction. |

Method changes are now a muted text action after Save mileage, before the separately collapsed Year-end options. Normal method form fields are New method, Ownership status, conditional Business-use percentage, and Reason for change, plus the recalculation confirmation. Selecting Standard Mileage exposes the existing necessary eligibility confirmations under a separate disclosure; 100% business use still requires its existing explicit confirmation. These conditional factual checks cannot safely be removed. No internal precedence checkbox is shown and no hidden supersession is inferred. Protected decisions remain preserved under the unchanged server contract; changes that cannot safely proceed show a short review/eligibility explanation.

3. Responsive and accessibility behavior

The card and optional disclosures remain native details/summary controls with visible keyboard focus. The monthly disclosure changes visibility only; opening it cannot activate monthly mode, manufacture a zero answer or invalidate a period total. Monthly input grids use two columns on narrow screens and three at medium/desktop widths; half-year groups stack until a wide layout has room for both. Fields have visible month labels, month/year accessible names, decimal input mode, miles suffixes, focus rings and contextual error indicators. New primary fields stay empty; intentionally saved zeroes remain zero.

Monthly validation is shown only for an open, interacted-with section. Closing it hides its validation without changing data or making invalid active entries savable. Switching from a differing period total to monthly data requires explicit confirmation and retains both local drafts. Switching back safely derives the period total from the same validated monthly sum and keeps monthly fields for further editing. Unsaved drafts never publish to the matrix or headline.

The method modal has an accessible title, aria-modal semantics, a focusable panel, focus trapping, focus restoration, Escape and backdrop close behavior. Close is blocked during saves or uncertain outcomes so the existing exact-key retry cannot be lost. Existing dark comboboxes retain arrow/typeahead/selection behavior; Tab closes open menus. Dialog scrolling is bounded to the viewport and layouts stack on mobile.

4. Shared currency formatter and precision audit

New shared formatTaxCurrency uses whole-dollar en-US USD estimates. TaxDashboard matrix, Vehicle Expense details, Gas question details and headline amounts all use it through the existing formatCurrencyLocal call sites. The previous Gas question Actual Expenses estimate that explicitly used two decimal places now uses this same display contract. BusinessMileagePanel Gas totals and live estimates, VehicleTreatmentEditor previews, overview view-model amounts, and planning/explanation wrappers also reuse it.

Examples: exact 3934.47 displays $3,934 everywhere in corresponding estimate surfaces; exact 2869.60 displays $2,870; exact cents remain unchanged internally. Period and annual display amounts are independently rounded, so rounded visible subtotals can differ from a rounded annual amount by a dollar. Reconciliation and saving always use exact cents. This is a presentation rule, not a calculation or storage change. Rates remain human-readable 72.5¢ / 76¢, not rounded currency amounts.

5. Focused tests

211/211 focused mileage, currency, Gas, vehicle, grouped-decision, lifecycle, matrix/projection and classification regressions pass in 3.31 seconds with a 45-second parent timeout. The final keyboard change also passes four targeted mounted/currency tests in 2.25 seconds with a 20-second timeout. Coverage includes one heading, removal of duplicate navigation copy, concise state/explanation, dynamic 96/70/26 Gas context, shared currency precision, collapsed saved summary, real saved zero, live unsaved preview, responsive month fields/suffixes/year labels, disclosure-only expansion, contextual validation, explicit non-destructive mode changes, modal-only method edits, preview invalidation after edits, confirmation gating, exact preview-ID/idempotency-key application, uncertain-result retry, Escape/backdrop close, focus return and dark-menu Tab behavior.

The authoritative Gas fixture still reconciles 96 total, 70 assigned and 26 requiring review. Existing 76 total / 70 actionable / six protected semantic-question regressions remain passing. Rates, monthly/annual rounding, save/refresh/retry and Standard Mileage / Actual Expenses / stale-state tests pass unchanged except intentional presentation assertions. No database or production data writes were used for this task.

Two additional dashboard/planning test files produce 21 passes and three failures both before and after these changes. The identical failures concern a date-only deadline fixture, an older loading-skeleton text assertion and an older estimated-expense heading assertion. The baseline source is preserved in /tmp/bizzi-mileage-refine-baseline; no new failure was introduced. One stale dark-dropdown source assertion was updated to verify the retained disabled-menu guard rather than requiring its older unguarded expression.

Logs: /tmp/bizzi-mileage-refine-final-focused.log; /tmp/bizzi-mileage-refine-keyboard.log; /tmp/bizzi-mileage-refine-baseline-extra.log; /tmp/bizzi-mileage-refine-current-extra.log.

6. Build and lint

Changed-file ESLint, production build and git diff --check pass. Production build retains the existing dynamic-import and large-chunk warnings. Checks were bounded; no unbounded broad suite was launched. Build/lint logs are /tmp/bizzi-mileage-refine-final-build.log and /tmp/bizzi-mileage-refine-final-lint.log.

7. Remaining UX limitations

The three pre-existing dashboard/planning assertions remain outside this UI refinement. Eligibility facts can still be required when changing to Standard Mileage; ownership/eligibility uncertainty is blocked safely rather than guessed. The modal deliberately does not offer hidden supersession of prior explicit decisions; a conflicting expense can require separate review in All transactions. Exact cents are preserved but estimate surfaces intentionally display whole dollars. Mounted tests validate behavior and markup; no production-browser screenshot validation is claimed.

8. Deployment implications

Frontend-only release under separate authorization. No backend deployment, migration, rate change, data backfill or projection rebuild is required. The existing server APIs and preview/apply payload shape are reused. A client reload loads the refined presentation. Existing unknown-outcome retry, stale-state, eligibility, RLS and atomic-save behavior remain server-enforced. No commit, push, deployment, migration or production data write occurred, and unrelated work including the dirty nested worktree remains preserved.

9. Verdict: READY for review and staging UI validation
