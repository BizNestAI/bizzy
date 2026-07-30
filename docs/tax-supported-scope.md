# Tax Supported Scope

## Pack 3 State Support

For 2026, Bizzi has verified the individual broad earned-income-tax component as zero for:

- `AK`
- `FL`
- `NV`
- `NH`
- `SD`
- `TN`
- `TX`
- `WA`
- `WY`

This is not full state support by itself. Business/entity exposure is tracked separately through `entity_tax_caveat` rows and may make total state liability `partial` or `unavailable`.

## Known Zero Versus Unknown

- Known zero individual component: display `$0` with a `Verified zero` badge.
- Unknown or deferred entity component: display `Not fully calculated` with `Partial entity support`.
- Total state liability is `$0` only when all material components are known zero or calculated.
- Unsupported state liability may produce provisional reserve guidance, but the state liability amount remains `null`.

## Provisional Reserve

Unsupported or partial state calculations may use `unsupported_state_provisional_reserve_v1`:

`max(0, projected state-apportionable income) * (7% base + 2% uncertainty buffer)`

This is labeled `Provisional state reserve estimate`, has `isLiabilityEstimate=false`, and must not be displayed as estimated state tax owed.

## Deferred Pack 4 Items

Entity/business tax calculation remains deferred where official thresholds, filing triggers, bases, and entity applicability are not fully encoded. Examples include Texas franchise tax, Washington B&O tax, New Hampshire BPT/BET, Tennessee franchise/excise tax, Nevada Commerce Tax, Florida corporate income/franchise tax, Alaska corporate income tax, South Dakota contractor excise tax, and Wyoming annual/license obligations.
