# Bizzi Transaction Date Policy Audit

Local audit date: 2026-09-16

## Canonical Policy

For finalized bank and credit-card transactions, Bizzi's authoritative accounting date is the financial institution posted date from Plaid transaction `date`.

`QBO TxnDate = bank_transactions.date`

`bank_transactions.date` is currently the existing schema field that represents Plaid's posted transaction date. This audit found no need for a destructive migration to rename it.

## Date Fields

| Field | Meaning | Accounting-date eligible? | Main readers/writers |
| --- | --- | --- | --- |
| Plaid `date` | Financial institution posted/finalized date | Yes | `plaidSyncService.js` writes `bank_transactions.date`; Books Review, Admin Monthly Review, Posting Review, Posting Trace, matching, scopes, reports read it |
| `bank_transactions.date` | Canonical stored Plaid posted date | Yes | QBO posting worker, duplicate preflight, auto-post policy, income/payment matching, monthly filters, tax/job/reconciliation readers |
| Plaid `authorized_date` | Purchase initiation/authorization date | No | `plaidSyncService.js` writes `bank_transactions.authorized_date`; canonical identity can use it for pending replacement context; reconciliation trace displays it |
| Plaid `authorized_datetime` | Higher precision authorization context when present in raw Plaid payload | No | Retained only in `bank_transactions.raw` if Plaid sends it |
| `created_at` / `updated_at` | Bizzi database timestamps | No | Sorting, freshness, audit metadata, UI timestamps |
| `post_after` | Worker scheduling timestamp | No | `autoPostControl.js`, `booksPost.cron.js`, Posting Review UI |
| `last_post_attempt_at` | Posting attempt timestamp | No | Posting worker/audit UI |
| `posted_at` | Time Bizzi confirmed/stored QBO receipt | No | `qbo_posted_transactions`, transaction lifecycle, Posted feed |
| QBO `TxnDate` | Accounting date in QuickBooks | Must equal posted date | QBO payloads built in `booksPost.cron.js`; QBO report ingestion reads it back |
| QBO creation/update timestamps | Provider operational metadata | No | Stored as provider response/audit context only |

## Lifecycle Trace

1. Plaid initial synchronization: `plaidSyncService.js` maps Plaid `date` to `bank_transactions.date` and Plaid `authorized_date` to `bank_transactions.authorized_date`.
2. Pending transaction ingestion: pending rows still carry Plaid `date` when provided, but pending rows are not postable.
3. Pending-to-posted replacement: canonical identity uses posted and authorized dates as match evidence; after finalization the stored `date` remains the accounting date.
4. Plaid modification/removal events: posted QBO-linked material date changes are flagged for accounting review instead of silently rewriting accounting output.
5. `bank_transactions`: `date` is the canonical posted-date column; `authorized_date` is context.
6. Categorization and merchant-rule evaluation: rules may use `bank_transactions.date` for scope/windowing, not as rule authority unless explicitly intended.
7. Posting Review: selected-month buckets are filtered by `bank_transactions.date`; scheduled labels use `post_after` only as timing context.
8. Posting intents: idempotency now uses the canonical accounting date and refuses missing posted dates.
9. Duplicate preflight: QBO search windows are centered on the canonical accounting date, not authorization or processing timestamps.
10. QBO payload construction: Purchase, Deposit, CreditCardCharge, and CC payment Transfer payloads use `getAccountingDateFromBankTransaction`.
11. QBO receipt storage: receipt timestamps record posting completion; they are not accounting dates.
12. Books Review: transaction rows display/filter by `bank_transactions.date`; authorized date can be shown only as context in trace views.
13. Admin Monthly Review: month filters, source ledger, Posting Trace, and Books Review mirror use posted-date based fields.
14. Posting Trace: Plaid-side transaction date is `bank_transactions.date`; status timestamps are separate.
15. Reconciliation and matching: QBO report dates are normalized as calendar dates; match windows use bank posted date.
16. Reports, exports, monthly filters: transaction-month filters should use `bank_transactions.date` or QBO `TxnDate` when reading provider reports.

## Enforcement Added

- `src/services/bookkeeping/accountingDatePolicy.js` centralizes date-only normalization and accounting-date extraction.
- Plaid ingestion now explicitly calls posted-date and authorized-date normalizers.
- Duplicate preflight returns `MISSING_ACCOUNTING_DATE` when no Plaid posted date exists.
- QBO posting worker marks missing posted-date rows non-postable and never falls back to the current date for QBO `TxnDate`.
- QBO monthly P&L ingestion now parses report calendar dates without timezone-shifting date-only values.
