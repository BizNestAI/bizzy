// File: /src/api/accounting/bookkeeping.routes.js
import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import { getQBOClient } from "../../utils/qboClient.js";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import OpenAI from "openai";
import { getBookkeepingHealth, upsertBookkeepingHealth } from "./bookkeepingHealth.js";

const router = express.Router();

// Small helper to hydrate user + business context
function readCtx(req) {
  const b = req.body || {};
  const q = req.query || {};
  const h = req.headers || {};
  return {
    userId: b.userId || b.user_id || q.userId || q.user_id || req.user?.id || null,
    businessId:
      b.businessId || b.business_id || q.businessId || q.business_id || h["x-business-id"] || req.user?.business_id || null,
  };
}

async function fetchChartOfAccounts(businessId) {
  const qbo = await getQBOClient(businessId);
  if (!qbo) return [];
  try {
    const res = await qbo.findAccounts({ Active: true });
    const accounts = Array.isArray(res?.QueryResponse?.Account)
      ? res.QueryResponse.Account
      : [];
    return accounts
      .filter((a) => !a.SubAccount && a.AccountType && !/header/i.test(a.Classification || ""))
      .map((a) => ({
        id: a.Id,
        name: a.Name,
        type: a.AccountType,
        subType: a.AccountSubType || null,
      }));
  } catch (e) {
    console.warn("[bookkeeping] fetch COA failed", e?.message || e);
    return [];
  }
}

async function fetchUncategorizedTransactions({ businessId, sinceDate, limit = 500, qbo }) {
  const client = qbo || (await getQBOClient(businessId));
  if (!client) return { items: [], count: 0 };

  try {
    // Use the TransactionList report to capture multiple Txn types; filter in memory for now.
    let report = null;
    if (typeof client.reportTransactionList === "function") {
      report = await client.reportTransactionList({
        start_date: sinceDate || undefined,
        end_date: undefined,
        sort_by: "TxnDate",
        sort_order: "DESC",
        max_results: limit,
      });
    } else if (typeof client.findTransactions === "function") {
      report = await client.findTransactions({
        MaxResults: limit,
        SortBy: "TxnDate",
        SortOrder: "DESC",
        ...(sinceDate ? { TxnDate: `>=${sinceDate}` } : {}),
      });
    }

    const rows = report?.Rows?.Row || report?.QueryResponse?.Txn || [];
    const UNCATS = new Set([
      "Uncategorized Expense",
      "Uncategorized Income",
      "Ask My Accountant",
    ]);

    const items = rows
      .map((row) => {
        const cells = row?.ColData || null;
        const isReportRow = Array.isArray(cells);

        const txnId = isReportRow ? row?.Id || cells?.[0]?.value || null : row?.Id || null;
        const date = isReportRow ? cells?.[1]?.value || null : row?.TxnDate || row?.MetaData?.CreateTime || null;
        const payee = isReportRow
          ? cells?.[3]?.value || cells?.[2]?.value || row?.entity || ""
          : row?.VendorRef?.name || row?.EntityRef?.name || row?.Payee || row?.Description || "";
        const desc = isReportRow ? cells?.[4]?.value || cells?.[5]?.value || "" : row?.PrivateNote || row?.Description || "";
        const accountName = isReportRow
          ? cells?.[6]?.value || row?.Account || ""
          : row?.AccountRef?.name || "";
        const amount = Number(
          isReportRow ? cells?.[7]?.value || row?.Amount || 0 : row?.TotalAmt || row?.Amount || 0
        );
        const txnType = isReportRow ? row?.TxnType || cells?.[8]?.value || row?.Type || null : row?.TxnType || row?.Type || null;

        return {
          id: txnId,
          date,
          payee,
          description: desc,
          amount,
          currentAccountName: accountName || "Uncategorized",
          currentAccountId: isReportRow ? null : row?.AccountRef?.value || null,
          accountType: row?.AccountRef?.type || null,
          txnType: txnType || null,
          raw: row,
        };
      })
      .filter((t) => {
        const acct = (t.currentAccountName || "").trim();
        return t.id && (!acct || UNCATS.has(acct));
      })
      .slice(0, limit);

    return { items, count: items.length };
  } catch (e) {
    console.error("[bookkeeping] uncategorized fetch failed", e);
    throw e;
  }
}

// GET /api/accounting/uncategorized
router.get("/uncategorized", requireAuth, async (req, res) => {
  try {
    const { businessId } = readCtx(req);
    if (!businessId) return res.status(400).json({ error: "missing businessId" });
    const qbo = await getQBOClient(businessId);
    if (!qbo) return res.status(400).json({ error: "quickbooks_not_connected" });

    const { items, count } = await fetchUncategorizedTransactions({ businessId, qbo });
    const coa = await fetchChartOfAccounts(businessId);

    // Update bookkeeping health snapshot
    await upsertBookkeepingHealth({
      businessId,
      uncategorizedCount: count,
      lastSyncAt: new Date().toISOString(),
    });

    // Optional: last cleanup timestamp from bookkeeping_actions table
    const { data: lastRow } = await supabase
      .from("bookkeeping_actions")
      .select("applied_at")
      .eq("business_id", businessId)
      .order("applied_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    res.json({ items, count, chartOfAccounts: coa, lastCleanupAt: lastRow?.applied_at || null });
  } catch (e) {
    console.error("[bookkeeping] list error", e);
    res.status(500).json({ error: "failed_to_fetch_uncategorized" });
  }
});

// POST /api/accounting/uncategorized/suggest
router.post("/uncategorized/suggest", requireAuth, async (req, res) => {
  try {
    const { businessId } = readCtx(req);
    const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    if (!businessId) return res.status(400).json({ error: "missing businessId" });
    if (!transactions.length) return res.json([]);

    const coa = await fetchChartOfAccounts(businessId);

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.json([]);
    const openai = new OpenAI({ apiKey: openaiKey });

    const system =
      "You are Bizzi, an AI bookkeeping assistant for home service and construction businesses. You help categorize QuickBooks bank transactions into the correct Chart of Accounts, and explain your reasoning concisely.";
    const coaLines = coa.map((c) => `${c.name} (${c.type}${c.subType ? ` – ${c.subType}` : ""})`).join("; ");
    const txnLines = transactions
      .slice(0, 25)
      .map((t) => `${t.id} | ${t.date} | ${t.payee || t.description} | ${t.amount}`)
      .join("\n");

    const prompt = [
      "Business COA:",
      coaLines || "(empty)",
      "Transactions to categorize (id | date | payee | amount):",
      txnLines,
      "For each, respond as JSON array with fields: txnId, suggestedAccountName, confidence (high|medium|low), reason (short). Use only account names from COA; if unsure, choose a general catch-all like 'Ask My Accountant'.",
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: process.env.BIZZY_GPT_SUGGEST_MODEL || "gpt-5.1",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 700,
    });

    const raw = completion?.choices?.[0]?.message?.content || "[]";
    let parsed = [];
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = [];
    }

    const suggestions = parsed
      .filter((s) => s?.txnId)
      .map((s) => {
        const match = coa.find((c) => c.name === s.suggestedAccountName) || null;
        return {
          txnId: s.txnId,
          suggestedAccountId: match?.id || null,
          suggestedAccountName: s.suggestedAccountName || match?.name || null,
          confidence: (s.confidence || "low").toLowerCase(),
          reason: s.reason || "",
        };
      });

    res.json(suggestions);
  } catch (e) {
    console.error("[bookkeeping] suggest error", e);
    res.status(500).json({ error: "failed_to_suggest" });
  }
});

// POST /api/accounting/uncategorized/apply
router.post("/uncategorized/apply", requireAuth, async (req, res) => {
  try {
    const { businessId, userId } = readCtx(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!businessId) return res.status(400).json({ error: "missing businessId" });
    if (!items.length) return res.status(400).json({ error: "missing items" });

    const qbo = await getQBOClient(businessId);
    if (!qbo) return res.status(400).json({ error: "quickbooks_not_connected" });

    async function fetchFullTxn(txnId, txnType) {
      const getter = `get${txnType}`;
      if (typeof qbo[getter] !== "function") return null;
      return await new Promise((resolve, reject) => {
        qbo[getter](txnId, (err, resp) => {
          if (err) return reject(err);
          resolve(resp);
        });
      });
    }

    async function applySingle(item) {
      if (!item?.txnId || !item?.newAccountId) {
        return { txnId: item?.txnId || null, ok: false, error: "missing_txn_or_account" };
      }

      const txnType = item.txnType || item.raw?.TxnType || "Purchase";
      const method = `update${txnType}`;

      // Ensure we have a full transaction (for SyncToken + line details)
      let baseTxn = item.raw || null;
      if (!baseTxn?.SyncToken) {
        try {
          baseTxn = await fetchFullTxn(item.txnId, txnType);
        } catch (e) {
          return { txnId: item.txnId, ok: false, error: `fetch_txn_failed_${txnType}` };
        }
      }

      const sparseTxn = {
        ...baseTxn,
        Sparse: true,
        SyncToken: baseTxn?.SyncToken,
        Id: item.txnId,
      };

      if (Array.isArray(sparseTxn.Line)) {
        sparseTxn.Line = sparseTxn.Line.map((ln) => {
          const detail = ln.AccountBasedExpenseLineDetail || ln.DetailType === "AccountBasedExpenseLineDetail";
          if (detail && ln.AccountBasedExpenseLineDetail) {
            return {
              ...ln,
              AccountBasedExpenseLineDetail: {
                ...ln.AccountBasedExpenseLineDetail,
                AccountRef: { value: item.newAccountId, name: item.newAccountName || undefined },
              },
            };
          }
          return ln;
        });
      }

      if (!sparseTxn.AccountRef) {
        sparseTxn.AccountRef = { value: item.newAccountId, name: item.newAccountName || undefined };
      }

      if (typeof qbo[method] !== "function") {
        return { txnId: item.txnId, ok: false, error: `unsupported_txn_type_${txnType}` };
      }

      // Promisify the node-quickbooks callback API
      await new Promise((resolve, reject) => {
        qbo[method](sparseTxn, (err, resp) => {
          if (err) return reject(err);
          return resolve(resp);
        });
      });

      await supabase.from("bookkeeping_actions").insert({
        business_id: businessId,
        user_id: userId,
        txn_id: item.txnId,
        old_account_id: item.oldAccountId || null,
        new_account_id: item.newAccountId,
        confidence: item.confidence || null,
        reason: item.reason || null,
        applied_at: new Date().toISOString(),
      });

      return { txnId: item.txnId, ok: true };
    }

    const results = await Promise.all(items.map((it) => applySingle(it).catch((e) => ({ txnId: it?.txnId || null, ok: false, error: e?.message || "apply_failed" }))));

    // Update bookkeeping health (best effort) after apply
    try {
      const remaining = await fetchUncategorizedTransactions({ businessId, limit: 50 });
      await upsertBookkeepingHealth({
        businessId,
        uncategorizedCount: remaining.count,
        lastCleanupAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("[bookkeeping] health refresh after apply failed", e?.message || e);
    }

    res.json({ ok: true, results });
  } catch (e) {
    console.error("[bookkeeping] apply error", e);
    res.status(500).json({ error: "failed_to_apply" });
  }
});

// GET /api/accounting/bookkeeping-health
router.get("/bookkeeping-health", requireAuth, async (req, res) => {
  try {
    const { businessId } = readCtx(req);
    if (!businessId) return res.status(400).json({ error: "missing businessId" });
    const row = await getBookkeepingHealth(businessId);
    res.json({ ok: true, health: row });
  } catch (e) {
    console.error("[bookkeeping] health fetch error", e);
    res.status(500).json({ error: "health_fetch_failed" });
  }
});

export { fetchUncategorizedTransactions, fetchChartOfAccounts };
export default router;
