import { supabase } from "../supabaseAdmin.js";
import { getPlaidClient, plaidEnvName } from "./plaidClient.js";
import { triggerContractorCfoInsightsBestEffort } from "../insights/contractorCfoTriggerService.js";
import { enqueueBookkeepingProcessingForTransactions } from "../bookkeeping/backgroundBookkeepingProcessingService.js";
import { resolveStoredPlaidAccessToken } from "./plaidTokenCrypto.js";
import {
  buildCanonicalTransactionIdentity,
  findPendingLifecycleCandidate,
  findProbableRelinkDuplicateCandidates,
  hasMaterialTransactionChange,
  isDeterministicCanonicalIdentity,
  isPlaidMutationDuringPaginationError,
} from "./plaidCanonicalIdentity.js";

function normalizeDate(d) {
  if (!d) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMemo(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
}

function buildFingerprintKey({ plaid_account_id, date, name, merchant_name, amount }) {
  const accountId = plaid_account_id || null;
  const txnDate = normalizeDate(date);
  const memo = normalizeMemo(name || merchant_name || "");
  const amt = normalizeAmount(amount);
  if (!accountId || !txnDate || !memo || amt == null) return null;
  return `${accountId}|${txnDate}|${amt}|${memo}`;
}

function uniqById(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function isoDateAddDays(isoDate, deltaDays) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

async function upsertRowsInChunks(table, rows, onConflict, chunkSize = 200) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(slice, { onConflict });
    if (error) throw error;
  }
}

// In-memory lock fallback (per process). DB locks are primary.
const memoryLocks = new Set();

async function acquireDbLock(itemId) {
  const { data, error } = await supabase
    .from("plaid_items")
    .update({ sync_in_progress: true, sync_started_at: nowIso() })
    .eq("id", itemId)
    .eq("sync_in_progress", false)
    .select("id")
    .single();
  if (error) return false;
  return !!data;
}

async function releaseDbLock(itemId) {
  await supabase
    .from("plaid_items")
    .update({ sync_in_progress: false, sync_started_at: null })
    .eq("id", itemId);
}

async function runSyncForItem(plaid, businessId, item, options = {}) {
  const { force = false } = options;
  const itemLockKey = `${businessId}:${item.plaid_item_id}`;
  if (memoryLocks.has(itemLockKey)) {
    return { skipped: true, reason: "memory_lock" };
  }
  const gotDbLock = await acquireDbLock(item.id);
  if (!gotDbLock) return { skipped: true, reason: "db_lock" };
  memoryLocks.add(itemLockKey);

  try {
    const originalCursor = item.cursor || null;
    let cursor = originalCursor;
    let hasMore = true;
    const added = [];
    const modified = [];
    const removed = [];
    const accessToken = await resolveStoredPlaidAccessToken({
      storedToken: item.plaid_access_token,
      persistEncrypted: async (encrypted) => {
        await supabase
          .from("plaid_items")
          .update({ plaid_access_token: encrypted, updated_at: nowIso() })
          .eq("business_id", businessId)
          .eq("plaid_item_id", item.plaid_item_id);
      },
    });

    let mutationRestarts = 0;
    while (hasMore) {
      try {
        const resp = await plaid.transactionsSync({
          access_token: accessToken,
          cursor: cursor || undefined,
        });
        const d = resp?.data || {};
        added.push(...(d.added || []));
        modified.push(...(d.modified || []));
        removed.push(...(d.removed || []));
        cursor = d.next_cursor || cursor;
        hasMore = !!d.has_more;
      } catch (err) {
        if (isPlaidMutationDuringPaginationError(err) && mutationRestarts < 3) {
          mutationRestarts += 1;
          cursor = originalCursor;
          hasMore = true;
          added.length = 0;
          modified.length = 0;
          removed.length = 0;
          if (process.env.NODE_ENV !== "production") {
            console.warn("[plaid][sync] mutation during pagination; restarting from original cursor", {
              business_id: businessId,
              plaid_item_id: item.plaid_item_id,
              restart: mutationRestarts,
            });
          }
          continue;
        }
        throw err;
      }
    }

    const now = new Date().toISOString();
    const accountIdsFromPayload = Array.from(
      new Set([...added, ...modified].map((tx) => tx?.account_id).filter(Boolean))
    );
    const accountPhysicalMap = new Map();
    if (accountIdsFromPayload.length) {
      const { data: accountRows, error: accountErr } = await supabase
        .from("plaid_accounts")
        .select("plaid_account_id,physical_account_id")
        .eq("business_id", businessId)
        .in("plaid_account_id", accountIdsFromPayload);
      if (accountErr) throw accountErr;
      for (const acct of accountRows || []) {
        accountPhysicalMap.set(acct.plaid_account_id, acct.physical_account_id || null);
      }
    }

    const rows = [...added, ...modified]
      .filter((tx) => {
        const hasId = !!tx.transaction_id;
        if (!hasId && process.env.NODE_ENV !== "production") {
          console.warn("[plaid][sync] skipping txn without plaid_transaction_id", { name: tx.name, date: tx.date });
        }
        return hasId;
      })
      .map((tx) => {
      const rawAmount = Number(tx.amount || 0); // Plaid raw (+ outflow)
      const direction =
        rawAmount > 0 ? "OUTFLOW" : rawAmount < 0 ? "INFLOW" : "UNKNOWN";
      const normalizedAmount = rawAmount * -1; // Bizzi: negative outflow
      return {
        business_id: businessId,
        plaid_item_id: item.plaid_item_id,
        plaid_env: item.plaid_env || plaidEnvName,
        plaid_account_id: tx.account_id,
        physical_account_id: accountPhysicalMap.get(tx.account_id) || null,
        plaid_transaction_id: tx.transaction_id,
        pending_transaction_id: tx.pending_transaction_id || null,
        name: tx.name || tx.merchant_name || "Transaction",
        merchant_name: tx.merchant_name || null,
        merchant_entity_id: tx.merchant_entity_id || null,
        plaid_amount_raw: rawAmount,
        amount: normalizedAmount,
        signed_amount: normalizedAmount,
        direction,
        iso_currency_code: tx.iso_currency_code || null,
        unofficial_currency_code: tx.unofficial_currency_code || null,
        date: tx.date || null,
        authorized_date: tx.authorized_date || null,
        pending: Boolean(tx.pending),
        payment_channel: tx.payment_channel || null,
        transaction_type: tx.transaction_type || null,
        check_number: tx.check_number || null,
        category_primary:
          (Array.isArray(tx.category) && tx.category[0]) ||
          tx.personal_finance_category?.primary ||
          null,
        category_detailed:
          (Array.isArray(tx.category) && tx.category[1]) ||
          tx.personal_finance_category?.detailed ||
          null,
        category_confidence:
          tx.personal_finance_category?.confidence_level || null,
        personal_finance_category: tx.personal_finance_category || null,
        location: tx.location || null,
        counterparties: tx.counterparties || null,
        plaid_last_modified_at: tx.timestamp || tx.datetime || null,
        last_seen_at: now,
        is_archived: false,
        archived_at: null,
        archived_reason: null,
        raw: tx,
        updated_at: now,
      };
    })
      .map((row) => {
        const canonical = buildCanonicalTransactionIdentity(row);
        return {
          ...row,
          duplicate_fingerprint: buildFingerprintKey(row),
          canonical_fingerprint: canonical.fingerprint,
          canonical_fingerprint_confidence: canonical.confidence,
          canonical_match_reason: canonical.reason,
          canonical_source: "plaid_sync",
        };
      });

    if (process.env.NODE_ENV !== "production" && rows.length) {
      const sample = rows[0];
      console.info("[plaid][sync] sample txn", {
        plaid_amount_raw: sample.plaid_amount_raw,
        amount: sample.amount,
        direction: sample.direction,
        name: sample.name,
        merchant_name: sample.merchant_name,
      });
    }

    let resolvedTxnIds = [];

    if (rows.length || removed.length) {
      const exactPlaidIds = Array.from(
        new Set(
          [
            ...rows.map((r) => r.plaid_transaction_id),
            ...rows.map((r) => r.pending_transaction_id),
            ...removed.map((r) => r?.transaction_id),
          ].filter(Boolean)
        )
      );
      const accountIds = Array.from(new Set(rows.map((r) => r.plaid_account_id).filter(Boolean)));
      const physicalAccountIds = Array.from(new Set(rows.map((r) => r.physical_account_id).filter(Boolean)));
      const deterministicFingerprints = Array.from(
        new Set(
          rows
            .filter((r) => isDeterministicCanonicalIdentity({ fingerprint: r.canonical_fingerprint, confidence: r.canonical_fingerprint_confidence }))
            .map((r) => r.canonical_fingerprint)
            .filter(Boolean)
        )
      );
      const candidateDates = Array.from(
        new Set(
          rows.flatMap((row) => [normalizeDate(row.date), normalizeDate(row.authorized_date)].filter(Boolean))
        )
      );

      const fetchedRows = [];
      if (exactPlaidIds.length) {
        const { data: byTxnId, error: byTxnIdErr } = await supabase
          .from("bank_transactions")
          .select(
            "id,physical_account_id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,merchant_entity_id,payment_channel,transaction_type,check_number,amount,signed_amount,is_archived,duplicate_fingerprint,canonical_fingerprint,canonical_fingerprint_confidence"
          )
          .eq("business_id", businessId)
          .in("plaid_transaction_id", exactPlaidIds);
        if (byTxnIdErr) throw byTxnIdErr;
        fetchedRows.push(...(byTxnId || []));

        const { data: byPendingId, error: byPendingIdErr } = await supabase
          .from("bank_transactions")
          .select(
            "id,physical_account_id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,merchant_entity_id,payment_channel,transaction_type,check_number,amount,signed_amount,is_archived,duplicate_fingerprint,canonical_fingerprint,canonical_fingerprint_confidence"
          )
          .eq("business_id", businessId)
          .in("pending_transaction_id", exactPlaidIds);
        if (byPendingIdErr) throw byPendingIdErr;
        fetchedRows.push(...(byPendingId || []));
      }

      if (accountIds.length && candidateDates.length) {
        const minDate = isoDateAddDays(candidateDates.reduce((min, d) => (d < min ? d : min)), -2);
        const maxDate = isoDateAddDays(candidateDates.reduce((max, d) => (d > max ? d : max)), 2);
        const { data: candidateRows, error: candidateErr } = await supabase
          .from("bank_transactions")
          .select(
            "id,physical_account_id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,merchant_entity_id,payment_channel,transaction_type,check_number,amount,signed_amount,is_archived,duplicate_fingerprint,canonical_fingerprint,canonical_fingerprint_confidence"
          )
          .eq("business_id", businessId)
          .eq("is_archived", false)
          .in("plaid_account_id", accountIds)
          .gte("date", minDate)
          .lte("date", maxDate);
        if (candidateErr) throw candidateErr;
        fetchedRows.push(...(candidateRows || []));
      }

      if (physicalAccountIds.length && candidateDates.length) {
        const minDate = isoDateAddDays(candidateDates.reduce((min, d) => (d < min ? d : min)), -2);
        const maxDate = isoDateAddDays(candidateDates.reduce((max, d) => (d > max ? d : max)), 2);
        const { data: physicalRows, error: physicalErr } = await supabase
          .from("bank_transactions")
          .select(
            "id,physical_account_id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,merchant_entity_id,payment_channel,transaction_type,check_number,amount,signed_amount,is_archived,duplicate_fingerprint,canonical_fingerprint,canonical_fingerprint_confidence"
          )
          .eq("business_id", businessId)
          .eq("is_archived", false)
          .in("physical_account_id", physicalAccountIds)
          .gte("date", minDate)
          .lte("date", maxDate);
        if (physicalErr) throw physicalErr;
        fetchedRows.push(...(physicalRows || []));
      }

      if (deterministicFingerprints.length) {
        const { data: byCanonical, error: byCanonicalErr } = await supabase
          .from("bank_transactions")
          .select(
            "id,physical_account_id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,merchant_entity_id,payment_channel,transaction_type,check_number,amount,signed_amount,is_archived,duplicate_fingerprint,canonical_fingerprint,canonical_fingerprint_confidence"
          )
          .eq("business_id", businessId)
          .eq("is_archived", false)
          .in("canonical_fingerprint", deterministicFingerprints);
        if (byCanonicalErr) throw byCanonicalErr;
        fetchedRows.push(...(byCanonical || []));
      }

      const existingRows = uniqById(fetchedRows);
      const existingByPlaidId = new Map();
      const existingByPendingId = new Map();
      const existingByCanonicalFingerprint = new Map();
      for (const row of existingRows) {
        if (row.plaid_transaction_id && !existingByPlaidId.has(row.plaid_transaction_id)) {
          existingByPlaidId.set(row.plaid_transaction_id, row);
        }
        if (row.pending_transaction_id && !existingByPendingId.has(row.pending_transaction_id)) {
          existingByPendingId.set(row.pending_transaction_id, row);
        }
        if (row.canonical_fingerprint && row.canonical_fingerprint_confidence === "deterministic") {
          const arr = existingByCanonicalFingerprint.get(row.canonical_fingerprint) || [];
          arr.push(row);
          existingByCanonicalFingerprint.set(row.canonical_fingerprint, arr);
        }
      }

      const claimedExistingIds = new Set();
      const protectedRemovedIds = new Set();
      const rowsForIdUpsert = [];
      const rowsForPlaidUpsert = [];
      const postedReviewUpdates = [];

      for (const row of rows) {
        let existing =
          existingByPlaidId.get(row.plaid_transaction_id) ||
          null;

        if (!existing && row.pending_transaction_id) {
          existing =
            existingByPlaidId.get(row.pending_transaction_id) ||
            existingByPendingId.get(row.pending_transaction_id) ||
            null;
        }

        if (!existing && row.pending === false) {
          existing = findPendingLifecycleCandidate(row, existingRows);
        }

        if (!existing && row.canonical_fingerprint && row.canonical_fingerprint_confidence === "deterministic") {
          const canonicalMatches = uniqById(existingByCanonicalFingerprint.get(row.canonical_fingerprint) || [])
            .filter((candidate) => !candidate.is_archived && !claimedExistingIds.has(candidate.id));
          if (canonicalMatches.length === 1) {
            existing = canonicalMatches[0];
          }
        }

        if (existing && !claimedExistingIds.has(existing.id)) {
          claimedExistingIds.add(existing.id);
          if (existing.plaid_transaction_id) protectedRemovedIds.add(existing.plaid_transaction_id);
          if (existing.pending_transaction_id) protectedRemovedIds.add(existing.pending_transaction_id);
          rowsForIdUpsert.push({
            ...row,
            id: existing.id,
            pending_source_transaction_id: existing.pending && !row.pending ? existing.id : null,
            canonical_match_reason: existing.pending && !row.pending ? "pending_lifecycle_merge" : row.canonical_match_reason,
          });
          continue;
        }

        const probableRelinkMatches = findProbableRelinkDuplicateCandidates(row, existingRows)
          .filter((candidate) => !claimedExistingIds.has(candidate.id));
        if (
          row.physical_account_id &&
          row.canonical_fingerprint_confidence !== "deterministic" &&
          probableRelinkMatches.length > 0
        ) {
          rowsForPlaidUpsert.push({
            ...row,
            accounting_review_required: true,
            accounting_review_reason: "plaid_relink_duplicate_review_required",
            accounting_review_payload: {
              incoming_plaid_transaction_id: row.plaid_transaction_id,
              incoming_plaid_item_id: row.plaid_item_id,
              incoming_plaid_account_id: row.plaid_account_id,
              physical_account_id: row.physical_account_id,
              candidate_transaction_ids: probableRelinkMatches.map((candidate) => candidate.id).filter(Boolean).slice(0, 10),
              candidate_plaid_transaction_ids: probableRelinkMatches.map((candidate) => candidate.plaid_transaction_id).filter(Boolean).slice(0, 10),
              review_actions: ["link_existing_bizzi_transaction", "confirm_genuinely_new_transaction"],
            },
            canonical_match_reason: "probable_relink_duplicate_review",
            canonical_source: "plaid_relink_review",
          });
          continue;
        }

        rowsForPlaidUpsert.push(row);
      }

      const matchedIds = rowsForIdUpsert.map((r) => r.id).filter(Boolean);
      const catByTxnId = new Map();
      if (matchedIds.length) {
        const { data: catRows, error: catFetchErr } = await supabase
          .from("transaction_categorizations")
          .select("transaction_id,status,qbo_txn_id,posted_at,reconciled_at")
          .eq("business_id", businessId)
          .in("transaction_id", matchedIds);
        if (catFetchErr) throw catFetchErr;
        for (const cat of catRows || []) catByTxnId.set(cat.transaction_id, cat);
      }

      const safeRowsForIdUpsert = [];
      for (const row of rowsForIdUpsert) {
        const existing = existingRows.find((candidate) => candidate.id === row.id);
        const cat = catByTxnId.get(row.id);
        const posted = cat?.status === "posted" || Boolean(cat?.qbo_txn_id || cat?.posted_at || cat?.reconciled_at);
        if (posted && hasMaterialTransactionChange(existing, row)) {
          protectedRemovedIds.add(existing?.plaid_transaction_id);
          if (existing?.pending_transaction_id) protectedRemovedIds.add(existing.pending_transaction_id);
          postedReviewUpdates.push({
            id: row.id,
            last_seen_at: now,
            updated_at: now,
            accounting_review_required: true,
            accounting_review_reason: "plaid_modified_after_qbo_post",
            accounting_review_payload: {
              incoming_plaid_transaction_id: row.plaid_transaction_id,
              incoming_amount: row.amount,
              incoming_date: row.date,
              incoming_name: row.name,
              existing_amount: existing?.amount ?? null,
              existing_date: existing?.date || null,
              existing_name: existing?.name || null,
            },
          });
          continue;
        }
        safeRowsForIdUpsert.push(row);
      }

      try {
        await upsertRowsInChunks("bank_transactions", safeRowsForIdUpsert, "id");
        await upsertRowsInChunks("bank_transactions", rowsForPlaidUpsert, "business_id,plaid_transaction_id");
        await upsertRowsInChunks("bank_transactions", postedReviewUpdates, "id");
        if (postedReviewUpdates.length) {
          const reviewIds = postedReviewUpdates.map((row) => row.id).filter(Boolean);
          const { error: reviewCatErr } = await supabase
            .from("transaction_categorizations")
            .update({
              accounting_review_required: true,
              accounting_review_reason: "plaid_modified_after_qbo_post",
              post_after: null,
              updated_at: now,
            })
            .eq("business_id", businessId)
            .in("transaction_id", reviewIds);
          if (reviewCatErr) throw reviewCatErr;
        }
      } catch (txnErr) {
        const e = new Error("supabase_upsert_failed");
        e.supabase = txnErr;
        throw e;
      }

      const removedIds = Array.from(
        new Set((removed || []).map((row) => row?.transaction_id).filter(Boolean))
      );
      const archiveTxnIds = [];
      for (const removedId of removedIds) {
        const row = existingByPlaidId.get(removedId);
        if (!row?.id) continue;

        const isProtectedLifecycleRow =
          (row.plaid_transaction_id && protectedRemovedIds.has(row.plaid_transaction_id)) ||
          (row.pending_transaction_id && protectedRemovedIds.has(row.pending_transaction_id));

        if (isProtectedLifecycleRow) {
          if (process.env.NODE_ENV !== "production") {
            console.info("[plaid][sync] skip archive for protected lifecycle row", {
              business_id: businessId,
              row_id: row.id,
              plaid_transaction_id: row.plaid_transaction_id || null,
              pending_transaction_id: row.pending_transaction_id || null,
            });
          }
          continue;
        }

        archiveTxnIds.push(row.id);
      }

      if (archiveTxnIds.length) {
        const { data: removedCats, error: removedCatFetchErr } = await supabase
          .from("transaction_categorizations")
          .select("transaction_id,status,qbo_txn_id,posted_at,reconciled_at")
          .eq("business_id", businessId)
          .in("transaction_id", archiveTxnIds);
        if (removedCatFetchErr) throw removedCatFetchErr;
        const postedRemovedIds = new Set(
          (removedCats || [])
            .filter((cat) => cat?.status === "posted" || cat?.qbo_txn_id || cat?.posted_at || cat?.reconciled_at)
            .map((cat) => cat.transaction_id)
            .filter(Boolean)
        );
        const unpostedArchiveTxnIds = archiveTxnIds.filter((id) => !postedRemovedIds.has(id));
        const postedRemovedTxnIds = archiveTxnIds.filter((id) => postedRemovedIds.has(id));

        const archivePayload = unpostedArchiveTxnIds.map((id) => ({
          id,
          is_archived: true,
          archived_at: now,
          archived_reason: "plaid_removed",
          updated_at: now,
        }));
        await upsertRowsInChunks("bank_transactions", archivePayload, "id");
        if (unpostedArchiveTxnIds.length) {
          const { error: catArchiveErr } = await supabase
            .from("transaction_categorizations")
            .update({ is_archived: true, archived_at: now, updated_at: now })
            .eq("business_id", businessId)
            .in("transaction_id", unpostedArchiveTxnIds);
          if (catArchiveErr) throw catArchiveErr;
        }
        if (postedRemovedTxnIds.length) {
          await upsertRowsInChunks(
            "bank_transactions",
            postedRemovedTxnIds.map((id) => ({
              id,
              accounting_review_required: true,
              accounting_review_reason: "plaid_removed_after_qbo_post",
              accounting_review_payload: { removed_at: now, source: "plaid_removed" },
              updated_at: now,
            })),
            "id"
          );
          const { error: removedReviewErr } = await supabase
            .from("transaction_categorizations")
            .update({
              accounting_review_required: true,
              accounting_review_reason: "plaid_removed_after_qbo_post",
              post_after: null,
              updated_at: now,
            })
            .eq("business_id", businessId)
            .in("transaction_id", postedRemovedTxnIds);
          if (removedReviewErr) throw removedReviewErr;
        }
      }

      // Resolve ids after upsert to avoid duplicate categs
      const plaidIds = rowsForPlaidUpsert.map((r) => r.plaid_transaction_id).filter(Boolean);
      resolvedTxnIds = safeRowsForIdUpsert.map((r) => r.id).filter(Boolean);
      if (plaidIds.length) {
        const { data: bankResolved, error: bankResolveErr } = await supabase
          .from("bank_transactions")
          .select("id,plaid_transaction_id")
          .eq("business_id", businessId)
          .in("plaid_transaction_id", plaidIds);
        if (bankResolveErr) throw bankResolveErr;
        resolvedTxnIds.push(...(bankResolved || []).map((r) => r.id).filter(Boolean));
      }

      resolvedTxnIds = Array.from(new Set(resolvedTxnIds));
    }

    if (resolvedTxnIds.length) {
      const { data: bankResolved, error: bankResolveErr } = await supabase
        .from("bank_transactions")
        .select("id,accounting_review_required,accounting_review_reason,accounting_review_payload")
        .eq("business_id", businessId)
        .in("id", resolvedTxnIds);
      if (bankResolveErr) throw bankResolveErr;
      const txnIds = (bankResolved || []).map((r) => r.id).filter(Boolean);
      const reviewByTxnId = new Map(
        (bankResolved || [])
          .filter((row) => row?.accounting_review_required === true)
          .map((row) => [row.id, row])
      );
      if (txnIds.length) {
        const { error: catReviveErr } = await supabase
          .from("transaction_categorizations")
          .update({ is_archived: false, archived_at: null, updated_at: now })
          .eq("business_id", businessId)
          .in("transaction_id", txnIds);
        if (catReviveErr) throw catReviveErr;

        const { data: existingCats, error: catErr } = await supabase
          .from("transaction_categorizations")
          .select("transaction_id")
          .eq("business_id", businessId)
          .in("transaction_id", txnIds);
        if (catErr) throw catErr;
        const existingSet = new Set((existingCats || []).map((c) => c.transaction_id));
        const missingIds = txnIds.filter((id) => !existingSet.has(id));
        if (missingIds.length) {
          const defaults = missingIds.map((id) => ({
            business_id: businessId,
            transaction_id: id,
            status: "needs_review",
            post_after: null,
            post_error: reviewByTxnId.has(id) ? reviewByTxnId.get(id)?.accounting_review_reason || "plaid_accounting_review_required" : null,
            accounting_review_required: reviewByTxnId.has(id),
            accounting_review_reason: reviewByTxnId.get(id)?.accounting_review_reason || null,
            meta: reviewByTxnId.has(id)
              ? {
                  post_block_reason: reviewByTxnId.get(id)?.accounting_review_reason || "plaid_accounting_review_required",
                  plaid_duplicate_review_required: true,
                  plaid_duplicate_review_payload: reviewByTxnId.get(id)?.accounting_review_payload || null,
                }
              : {},
          }));
          const { error: catUpsertErr } = await supabase
            .from("transaction_categorizations")
            .upsert(defaults, { onConflict: "business_id,transaction_id" });
          if (catUpsertErr) throw catUpsertErr;
          if (process.env.NODE_ENV !== "production") {
            console.info("[plaid][sync] categ rows created", { count: defaults.length });
          }
        }
        const reviewTxnIds = Array.from(reviewByTxnId.keys());
        if (reviewTxnIds.length) {
          const { error: reviewCatErr } = await supabase
            .from("transaction_categorizations")
            .update({
              status: "needs_review",
              post_after: null,
              post_error: "plaid_accounting_review_required",
              accounting_review_required: true,
              accounting_review_reason: "plaid_relink_duplicate_review_required",
              updated_at: now,
            })
            .eq("business_id", businessId)
            .in("transaction_id", reviewTxnIds);
          if (reviewCatErr) throw reviewCatErr;
        }
      }
    }

    let lastSyncAt = now;
    const { error: updateErr } = await supabase
      .from("plaid_items")
      .update({
        cursor,
        last_sync_at: now,
        status: "active",
        is_active: true,
        disconnected_at: null,
        updated_at: now,
      })
      .eq("business_id", businessId)
      .eq("plaid_item_id", item.plaid_item_id);
    if (updateErr) {
      const e = new Error("supabase_update_failed");
      e.supabase = updateErr;
      throw e;
    }

    const addedCount = Number.isFinite(added.length) ? added.length : 0;
    const modifiedCount = Number.isFinite(modified.length) ? modified.length : 0;
    const removedCount = Number.isFinite(removed.length) ? removed.length : 0;

    const { error: syncLogErr } = await supabase.from("bank_sync_runs").insert({
      business_id: businessId,
      plaid_item_id: item.plaid_item_id,
      added_count: addedCount,
      modified_count: modifiedCount,
      removed_count: removedCount,
      started_at: now,
      finished_at: now,
      status: "ok",
    });
    if (syncLogErr) {
      const e = new Error("supabase_sync_log_failed");
      e.supabase = syncLogErr;
      throw e;
    }

    // Backfill legacy rows to canonical amount/direction
    try {
      const { data: missingRows, error: missingErr } = await supabase
        .from("bank_transactions")
        .select("id,amount,plaid_amount_raw,direction,signed_amount")
        .eq("business_id", businessId)
        .or("plaid_amount_raw.is.null,direction.is.null,amount.is.null,signed_amount.is.null")
        .limit(5000);
      if (missingErr) throw missingErr;
      if (missingRows && missingRows.length) {
        const updates = missingRows.map((row) => {
          let raw = row.plaid_amount_raw;
          let amount = row.amount;
          let direction = row.direction;
          let signed_amount = row.signed_amount;

          if (raw == null && amount != null) {
            raw = Number(amount);
            amount = raw * -1;
            direction = raw > 0 ? "OUTFLOW" : raw < 0 ? "INFLOW" : "UNKNOWN";
            signed_amount = amount;
          } else if (raw != null) {
            raw = Number(raw);
            if (!direction) direction = raw > 0 ? "OUTFLOW" : raw < 0 ? "INFLOW" : "UNKNOWN";
            if (amount == null) amount = raw * -1;
            if (signed_amount == null) signed_amount = amount;
          }

          return {
            id: row.id,
            plaid_amount_raw: raw,
            amount,
            direction,
            signed_amount,
          };
        });
        const cleaned = updates.filter((u) => u.id);
        const chunkSize = 200;
        for (let i = 0; i < cleaned.length; i += chunkSize) {
          const slice = cleaned.slice(i, i + chunkSize);
          const { error: updErr } = await supabase
            .from("bank_transactions")
            .upsert(slice, { onConflict: "id" });
          if (updErr) throw updErr;
        }
      }
    } catch (backfillErr) {
      console.warn("[plaid][sync] amount/direction backfill failed", backfillErr?.message || backfillErr);
    }

    let bookkeepingEnqueued = 0;
    if (resolvedTxnIds.length) {
      try {
        const queued = await enqueueBookkeepingProcessingForTransactions({
          businessId,
          transactionIds: resolvedTxnIds,
          source: "plaid_sync",
          priority: 10,
          supabase,
        });
        bookkeepingEnqueued = Number(queued?.enqueued || 0);
      } catch (bookkeepingErr) {
        console.warn("[plaid][sync] bookkeeping enqueue failed", {
          business_id: businessId,
          count: resolvedTxnIds.length,
          error: bookkeepingErr?.message || String(bookkeepingErr),
        });
      }
    }

    return {
      ok: true,
      last_sync_at: lastSyncAt,
      added: added.length,
      modified: modified.length,
      removed: removed.length,
      bookkeeping_enqueued: bookkeepingEnqueued,
    };
  } finally {
    memoryLocks.delete(itemLockKey);
    await releaseDbLock(item.id);
  }
}

export async function runPlaidSyncForBusiness(businessId, { force = false } = {}) {
  const plaid = getPlaidClient();
  if (!plaid) throw new Error("plaid_not_configured");

  const { data: items, error: itemsErr } = await supabase
    .from("plaid_items")
    .select("id,plaid_item_id,plaid_env,plaid_access_token,cursor,status,last_sync_at,is_active")
    .eq("business_id", businessId)
    .eq("is_active", true);
  if (itemsErr) throw itemsErr;
  if (!items || !items.length) return { ok: true, synced: 0, skipped: 0 };

  let synced = 0;
  let skipped = 0;
  let bookkeepingEnqueued = 0;
  for (const item of items) {
    try {
      const res = await runSyncForItem(plaid, businessId, item, { force });
      if (res?.skipped) {
        skipped += 1;
      } else {
        synced += 1;
        bookkeepingEnqueued += Number(res?.bookkeeping_enqueued || 0);
      }
      await new Promise((r) => setTimeout(r, 250)); // small delay to avoid hammering Plaid
    } catch (err) {
      console.error("[plaid][sync] failed", {
        business_id: businessId,
        item: item.plaid_item_id,
        message: err?.message,
        supabase: err?.supabase || null,
      });
    }
  }

  if (synced > 0) {
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "plaid_sync",
      force: false,
    });
  }

  return { ok: true, synced, skipped, bookkeeping_enqueued: bookkeepingEnqueued };
}
