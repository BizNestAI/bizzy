import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  ensurePaymentAccount,
  fetchPaymentAccounts,
  findStrongPaymentAccountMatch,
} from "../../../services/bookkeeping/qboAccounts.js";

const router = Router();

function getPlaidPostingRail(type, subtype) {
  const t = String(type || "").trim().toLowerCase();
  const st = String(subtype || "").trim().toLowerCase();

  if (t === "depository") return "depository";
  if (t === "credit") return "credit";

  if (["checking", "savings", "money market", "cd"].includes(st)) return "depository";
  if (st.includes("credit")) return "credit";

  return null;
}

function mapPlaidRailToQboType(plaidRail) {
  if (plaidRail === "depository") return "Bank";
  if (plaidRail === "credit") return "CreditCard";
  return null;
}

router.get("/qbo/payment-accounts", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const accounts = await fetchPaymentAccounts(businessId);
    return res.json({
      ok: true,
      accounts: (accounts || []).map((acct) => ({
        id: acct.id,
        name: acct.name,
        type: acct.type,
      })),
    });
  } catch (err) {
    console.error("[bookkeeping][qbo-payment-accounts] fetch failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "qbo_payment_accounts_fetch_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/qbo/payment-accounts/ensure", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const plaidAccountId = req.body?.plaid_account_id || req.body?.plaidAccountId || null;
  if (!plaidAccountId) {
    return res.status(400).json({ ok: false, error: "missing_plaid_account_id" });
  }

  try {
    const { data: plaidAccount, error: plaidErr } = await supabase
      .from("plaid_accounts")
      .select("plaid_account_id,name,official_name,mask,type,subtype")
      .eq("business_id", businessId)
      .eq("plaid_account_id", plaidAccountId)
      .maybeSingle();
    if (plaidErr) throw plaidErr;
    if (!plaidAccount) {
      return res.status(404).json({ ok: false, error: "plaid_account_not_found" });
    }

    const plaidRail = getPlaidPostingRail(plaidAccount.type, plaidAccount.subtype);
    const qboType = mapPlaidRailToQboType(plaidRail);
    if (!qboType) {
      return res.status(400).json({ ok: false, error: "plaid_account_not_postable" });
    }

    const accounts = await fetchPaymentAccounts(businessId);
    const strongMatch = findStrongPaymentAccountMatch(
      accounts,
      plaidAccount.name || plaidAccount.official_name,
      plaidAccount.mask
    );
    if (strongMatch) {
      return res.json({
        ok: true,
        created: false,
        account: {
          id: strongMatch.id,
          name: strongMatch.name,
          type: strongMatch.type,
        },
      });
    }

    const ensureResult = await ensurePaymentAccount({
      businessId,
      plaidName: plaidAccount.name || plaidAccount.official_name || "Bank Account",
      mask: plaidAccount.mask || null,
      qboType,
    });

    return res.json({
      ok: true,
      created: Boolean(ensureResult?.created),
      account: {
        id: ensureResult?.account?.id,
        name: ensureResult?.account?.name,
        type: ensureResult?.account?.type,
      },
    });
  } catch (err) {
    console.error("[bookkeeping][qbo-payment-accounts] ensure failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "qbo_payment_accounts_ensure_failed",
      message: err?.message || "failed",
    });
  }
});

export default router;
