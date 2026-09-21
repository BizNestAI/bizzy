# Books Review regression repair plan

This is a production plan only. It has not been executed. Run it only after the lifecycle migration is deployed and the read-only audit output has been reviewed by an operator.

1. Export the read-only audit result and assign each candidate one classification: same-row downgrade, pending-to-settled inheritance gap, posting-failure regression, duplicate, explicit undo, or no prior-approval evidence.
2. Begin a transaction at `SERIALIZABLE` isolation and lock only the approved candidate `transaction_categorizations` and related `bank_transactions` rows with `FOR UPDATE`.
3. Re-run the QBO evidence check inside the transaction. If either `transaction_categorizations.qbo_txn_id` or a posted `qbo_posted_transactions` receipt exists, preserve that evidence and normalize the row to `status = 'posted'`, `review_status = 'handled'`, and `posting_status = 'posted'`. Never schedule another post.
4. For same-row downgrades with durable approval evidence (`decided_by = 'user'`, a manual approval marker, or an authoritative final account), restore `status = 'approved'`, `review_status = 'handled'`, the prior final account, and the original `decided_at`. Preserve `post_error`; set `posting_status = 'posting_failed'` when an attempt failed, otherwise derive scheduled/not-scheduled from `post_after`.
5. For a settled row with an unambiguous `pending_transaction_id` lineage, copy the pending shadow's categorization, final account, review decision, and safe workflow metadata to the settled internal row. Archive the pending shadow and its categorization. If amount, physical account, or direction changed materially, do not copy approval: set an explicit `review_reopen_reason` such as `amount_changed_after_settlement`.
6. For active duplicates, select one canonical internal row using exact Plaid lineage and posting evidence. Preserve the row tied to QBO. Archive only the non-posted duplicate; never delete either row.
7. Do not alter explicit Undo rows or rows with no evidence of a previous approval.
8. Insert one `bookkeeping_lifecycle_events` record per repaired row with previous/new state, actor `production_repair`, reason, posting attempt identity, and Plaid lineage.
9. Assert before commit that each candidate appears in exactly one of Needs Review, Handled, Posted, or Matched; no QBO transaction identity is shared by two active bank rows; and no repaired posting is newly eligible when QBO evidence already exists.
10. Commit once. Re-running the repair must be a no-op because every update predicate includes the audited previous state and excludes already-normalized rows.

Prepare the executable repair SQL from the reviewed audit export, with exact transaction IDs and expected old values in every `WHERE` clause. Do not use merchant/date/amount matching as the mutation key.
