# Admin Bookkeeping Access endpoint inventory

The source of truth is the exact method/path matcher in `src/services/adminBookkeepingAccess.js`. Anything absent from that allowlist remains blocked by the global Admin View write guard.

## Permitted customer Books Review mutations

- Save the selected transaction or credit-card inflow resolution.
- Approve a Needs Review categorization (including its normal vendor-rule learning and delayed-posting decision).
- Undo a Bizzi bookkeeping decision or confirmed Bizzi match.
- Mark, reject, discover, and confirm the protected credit-card-payment workflow.
- Refresh read-only existing-QBO match evidence; approve, reject, or undo an incoming-deposit match; or approve the deposit as new income.
- Exclude a transaction.
- Create vendor rules through the normal Books Review approval flow. Direct Rules-page edits remain blocked.
- Submit an existing operator clarification.
- Retry bookkeeping processing.
- Retry an individual failed QBO posting only when the server reloads it as failed, unposted, and mutable.

## Explicitly prohibited

- Chat, GPT, AI usage, credits, and chat history mutations.
- Billing, subscriptions, invoices, payment methods, invites, membership, roles, and ownership.
- QuickBooks or Plaid connection, replacement, disconnect, token, secret, mapping, account-creation, or provider-administration mutations.
- Auto-post configuration, bulk/manual posting, reconciliation runs, suggestion/reconsideration AI, and account-mapping changes.
- Business deletion, broad deletion, security settings, cross-business switching, and any attempt to bypass posting/matching safety gates.

## Not relevant / read-only

- Feed, account, status, report, and cached QBO reads remain governed by normal business-scoped read routes.
- Other application modules retain the original read-only Admin View behavior.
- GET match inspection is forced to `persist: false` in Admin View; explicit refresh is the audited discovery action.
