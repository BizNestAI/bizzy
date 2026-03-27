import { supabase } from "../supabaseAdmin.js";
import { getPlaidClient } from "./plaidClient.js";

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

function buildFingerprintVariants(row = {}) {
  const dates = Array.from(
    new Set([normalizeDate(row.date), normalizeDate(row.authorized_date)].filter(Boolean))
  );
  return dates
    .map((date) =>
      buildFingerprintKey({
        plaid_account_id: row.plaid_account_id,
        date,
        name: row.name,
        merchant_name: row.merchant_name,
        amount: row.amount,
      })
    )
    .filter(Boolean);
}

function sameOptionalField(a, b) {
  if (a == null || a === "" || b == null || b === "") return true;
  return String(a) === String(b);
}

function isSafeReplayCandidate(candidate, row) {
  if (!candidate || !row) return false;
  return (
    sameOptionalField(candidate.merchant_entity_id, row.merchant_entity_id) &&
    sameOptionalField(candidate.payment_channel, row.payment_channel) &&
    sameOptionalField(candidate.transaction_type, row.transaction_type) &&
    sameOptionalField(candidate.check_number, row.check_number)
  );
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
    let cursor = item.cursor || null;
    let hasMore = true;
    const added = [];
    const modified = [];
    const removed = [];

    while (hasMore) {
      const resp = await plaid.transactionsSync({
        access_token: item.plaid_access_token,
        cursor: cursor || undefined,
      });
      const d = resp?.data || {};
      added.push(...(d.added || []));
      modified.push(...(d.modified || []));
      removed.push(...(d.removed || []));
      cursor = d.next_cursor || cursor;
      hasMore = !!d.has_more;
    }

    const now = new Date().toISOString();
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
        plaid_account_id: tx.account_id,
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
      .map((row) => ({
        ...row,
        duplicate_fingerprint: buildFingerprintKey(row),
      }));

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
            "id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,merchant_entity_id,payment_channel,transaction_type,check_number,amount,is_archived,duplicate_fingerprint"
          )
          .eq("business_id", businessId)
          .in("plaid_transaction_id", exactPlaidIds);
        if (byTxnIdErr) throw byTxnIdErr;
        fetchedRows.push(...(byTxnId || []));

        const { data: byPendingId, error: byPendingIdErr } = await supabase
          .from("bank_transactions")
          .select(
            "id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,merchant_entity_id,payment_channel,transaction_type,check_number,amount,is_archived,duplicate_fingerprint"
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
            "id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,merchant_entity_id,payment_channel,transaction_type,check_number,amount,is_archived,duplicate_fingerprint"
          )
          .eq("business_id", businessId)
          .eq("is_archived", false)
          .in("plaid_account_id", accountIds)
          .gte("date", minDate)
          .lte("date", maxDate);
        if (candidateErr) throw candidateErr;
        fetchedRows.push(...(candidateRows || []));
      }

      const existingRows = uniqById(fetchedRows);
      const existingByPlaidId = new Map();
      const existingByPendingId = new Map();
      const existingByFingerprint = new Map();
      for (const row of existingRows) {
        if (row.plaid_transaction_id && !existingByPlaidId.has(row.plaid_transaction_id)) {
          existingByPlaidId.set(row.plaid_transaction_id, row);
        }
        if (row.pending_transaction_id && !existingByPendingId.has(row.pending_transaction_id)) {
          existingByPendingId.set(row.pending_transaction_id, row);
        }
        for (const key of buildFingerprintVariants(row)) {
          const arr = existingByFingerprint.get(key) || [];
          arr.push(row);
          existingByFingerprint.set(key, arr);
        }
      }

      const claimedExistingIds = new Set();
      const protectedRemovedIds = new Set();
      const rowsForIdUpsert = [];
      const rowsForPlaidUpsert = [];

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

        if (!existing) {
          const fingerprintMatches = uniqById(
            buildFingerprintVariants(row).flatMap((key) => existingByFingerprint.get(key) || [])
          ).filter((candidate) => !candidate.is_archived && !claimedExistingIds.has(candidate.id));

          if (fingerprintMatches.length === 1 && isSafeReplayCandidate(fingerprintMatches[0], row)) {
            existing = fingerprintMatches[0];
          }
        }

        if (existing && !claimedExistingIds.has(existing.id)) {
          claimedExistingIds.add(existing.id);
          if (existing.plaid_transaction_id) protectedRemovedIds.add(existing.plaid_transaction_id);
          if (existing.pending_transaction_id) protectedRemovedIds.add(existing.pending_transaction_id);
          rowsForIdUpsert.push({
            ...row,
            id: existing.id,
          });
          continue;
        }

        rowsForPlaidUpsert.push(row);
      }

      try {
        await upsertRowsInChunks("bank_transactions", rowsForIdUpsert, "id");
        await upsertRowsInChunks("bank_transactions", rowsForPlaidUpsert, "business_id,plaid_transaction_id");
      } catch (txnErr) {
        const e = new Error("supabase_upsert_failed");
        e.supabase = txnErr;
        throw e;
      }

      const removedIds = Array.from(
        new Set((removed || []).map((row) => row?.transaction_id).filter(Boolean))
      );
      const archiveTxnIds = removedIds
        .map((removedId) => existingByPlaidId.get(removedId))
        .filter((row) => row?.id && !protectedRemovedIds.has(row.plaid_transaction_id))
        .map((row) => row.id);

      if (archiveTxnIds.length) {
        const archivePayload = archiveTxnIds.map((id) => ({
          id,
          is_archived: true,
          archived_at: now,
          archived_reason: "plaid_removed",
          updated_at: now,
        }));
        await upsertRowsInChunks("bank_transactions", archivePayload, "id");
        const { error: catArchiveErr } = await supabase
          .from("transaction_categorizations")
          .update({ is_archived: true, archived_at: now, updated_at: now })
          .eq("business_id", businessId)
          .in("transaction_id", archiveTxnIds);
        if (catArchiveErr) throw catArchiveErr;
      }

      // Resolve ids after upsert to avoid duplicate categs
      const plaidIds = rowsForPlaidUpsert.map((r) => r.plaid_transaction_id).filter(Boolean);
      resolvedTxnIds = rowsForIdUpsert.map((r) => r.id).filter(Boolean);
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
        .select("id")
        .eq("business_id", businessId)
        .in("id", resolvedTxnIds);
      if (bankResolveErr) throw bankResolveErr;
      const txnIds = (bankResolved || []).map((r) => r.id).filter(Boolean);
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
            meta: {},
          }));
          const { error: catUpsertErr } = await supabase
            .from("transaction_categorizations")
            .upsert(defaults, { onConflict: "business_id,transaction_id" });
          if (catUpsertErr) throw catUpsertErr;
          if (process.env.NODE_ENV !== "production") {
            console.info("[plaid][sync] categ rows created", { count: defaults.length });
          }
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

    return {
      ok: true,
      last_sync_at: lastSyncAt,
      added: added.length,
      modified: modified.length,
      removed: removed.length,
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
    .select("id,plaid_item_id,plaid_access_token,cursor,status,last_sync_at,is_active")
    .eq("business_id", businessId)
    .eq("is_active", true);
  if (itemsErr) throw itemsErr;
  if (!items || !items.length) return { ok: true, synced: 0, skipped: 0 };

  let synced = 0;
  let skipped = 0;
  for (const item of items) {
    try {
      const res = await runSyncForItem(plaid, businessId, item, { force });
      if (res?.skipped) {
        skipped += 1;
      } else {
        synced += 1;
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

  return { ok: true, synced, skipped };
}
