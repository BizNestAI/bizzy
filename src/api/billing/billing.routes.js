// src/api/billing/billing.routes.js
import express from "express";
import {
  stripe,
  stripeMode,
  STRIPE_WEBHOOK_SECRET_ACTIVE,
  PRICE_BIZZI_HUMAN_REVIEW_ACTIVE,
} from "./stripe.js";
import { supabase } from "../../services/supabaseAdmin.js";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";

const APP_URL = process.env.APP_URL || process.env.APP_BASE_URL || "http://localhost:5173";
const ACTIVE_SUFFIX = stripeMode === "test" ? "test" : "live";
const USE_LEGACY_FALLBACK = stripeMode === "live";

const ACTIVE_BILLING_COLUMNS = {
  stripe_customer_id: `stripe_customer_id_${ACTIVE_SUFFIX}`,
  stripe_subscription_id: `stripe_subscription_id_${ACTIVE_SUFFIX}`,
  subscription_status: `subscription_status_${ACTIVE_SUFFIX}`,
  plan_price_id: `plan_price_id_${ACTIVE_SUFFIX}`,
  current_period_end: `current_period_end_${ACTIVE_SUFFIX}`,
  trial_end: `trial_end_${ACTIVE_SUFFIX}`,
  cancel_at_period_end: `cancel_at_period_end_${ACTIVE_SUFFIX}`,
  last_invoice_status: `last_invoice_status_${ACTIVE_SUFFIX}`,
  canceled_at: `canceled_at_${ACTIVE_SUFFIX}`,
  last_invoice_id: `last_invoice_id_${ACTIVE_SUFFIX}`,
  last_payment_failed_at: `last_payment_failed_at_${ACTIVE_SUFFIX}`,
  plan_type: `plan_type_${ACTIVE_SUFFIX}`,
};

if (process.env.NODE_ENV !== "production") {
  console.log("[billing] stripe env", {
    stripeMode,
    hasActivePrice: Boolean(PRICE_BIZZI_HUMAN_REVIEW_ACTIVE),
    hasActiveWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET_ACTIVE),
  });
}

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));

function readIds(req) {
  const q = req.query || {};
  const b = req.body || {};
  const h = req.headers || {};
  const user_id = req.user?.id || b.user_id || q.user_id || h["x-user-id"] || null;
  const business_id = b.businessId || b.business_id || q.business_id || q.businessId || h["x-business-id"] || null;
  return { user_id, business_id };
}

async function assertBusinessOwnership(userId, businessId) {
  if (!businessId || !userId) return false;
  const { data, error } = await supabase
    .from("business_profiles")
    .select("id, user_id")
    .eq("id", businessId)
    .maybeSingle();
  if (error || !data) return false;
  return data.user_id === userId;
}

async function upsertBusinessBilling(businessId, payload = {}) {
  if (!businessId) return;
  const scopedPayload = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (value === undefined) return;
    const scopedKey = ACTIVE_BILLING_COLUMNS[key];
    if (scopedKey) scopedPayload[scopedKey] = value;
    if (USE_LEGACY_FALLBACK) scopedPayload[key] = value;
  });
  const row = {
    business_id: businessId,
    updated_at: new Date().toISOString(),
    ...scopedPayload,
  };
  await supabase.from("business_billing").upsert(row, { onConflict: "business_id" });
}

async function syncBillingFromSubscription(businessId, subscriptionId) {
  if (!businessId || !subscriptionId) return null;
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const status = mapSubStatus(sub.status);
  const metadataPlanType = normalizePlanType(sub?.metadata?.planType || sub?.metadata?.plan_type || null);
  const payload = {
    stripe_customer_id: sub.customer || null,
    stripe_subscription_id: sub.id || subscriptionId,
    subscription_status: status,
    current_period_end: deriveSubscriptionEndIso(sub),
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    plan_price_id: priceId,
    plan_type: mapPriceIdToPlanType(priceId) || metadataPlanType,
    canceled_at: status === "canceled" ? new Date().toISOString() : null,
  };
  await upsertBusinessBilling(businessId, payload);
  return payload;
}

async function dedupeCustomerCardPaymentMethods(customerId, preferredPaymentMethodId = null) {
  if (!customerId) return;
  const pmList = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 100,
  });
  const methods = Array.isArray(pmList?.data) ? pmList.data : [];
  if (methods.length < 2) {
    return {
      customerId,
      totalMethods: methods.length,
      duplicateGroups: 0,
      keptPaymentMethodIds: methods.map((pm) => pm.id).filter(Boolean),
      detachedPaymentMethodIds: [],
    };
  }

  const customer = await stripe.customers.retrieve(customerId);
  const customerDefaultPaymentMethodId =
    customer && !customer.deleted ? customer.invoice_settings?.default_payment_method || null : null;

  const groups = new Map();
  methods.forEach((pm) => {
    const card = pm?.card || {};
    const fingerprint = card.fingerprint || "unknown";
    const key = [
      fingerprint,
      card.brand || "",
      card.last4 || "",
      String(card.exp_month || ""),
      String(card.exp_year || ""),
    ].join(":");
    const group = groups.get(key) || [];
    group.push(pm);
    groups.set(key, group);
  });

  const detachedPaymentMethodIds = [];
  const keptPaymentMethodIds = [];
  let duplicateGroups = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    duplicateGroups += 1;
    const sorted = [...group].sort((a, b) => (b.created || 0) - (a.created || 0));
    const keepId =
      sorted.find((pm) => pm.id === preferredPaymentMethodId)?.id ||
      sorted.find((pm) => pm.id === customerDefaultPaymentMethodId)?.id ||
      sorted[0]?.id ||
      null;
    if (keepId) keptPaymentMethodIds.push(keepId);
    const duplicates = sorted.filter((pm) => pm.id && pm.id !== keepId);
    for (const duplicate of duplicates) {
      try {
        await stripe.paymentMethods.detach(duplicate.id);
        detachedPaymentMethodIds.push(duplicate.id);
      } catch (err) {
        console.warn("[billing] failed to detach duplicate payment method", {
          customerId,
          paymentMethodId: duplicate.id,
          message: err?.message || err,
        });
      }
    }
  }

  return {
    customerId,
    totalMethods: methods.length,
    duplicateGroups,
    keptPaymentMethodIds,
    detachedPaymentMethodIds,
  };
}

function readActiveBillingValue(row, key, fallbackValue = null) {
  if (!row) return fallbackValue;
  const scopedKey = ACTIVE_BILLING_COLUMNS[key];
  const scopedValue = scopedKey ? row?.[scopedKey] : undefined;
  if (scopedValue !== undefined && scopedValue !== null) return scopedValue;
  if (USE_LEGACY_FALLBACK) {
    const legacyValue = row?.[key];
    if (legacyValue !== undefined && legacyValue !== null) return legacyValue;
  }
  return fallbackValue;
}

function projectBillingRow(row) {
  return {
    subscription_status: readActiveBillingValue(row, "subscription_status", "free") || "free",
    plan_type: readActiveBillingValue(row, "plan_type", null),
    plan_price_id: readActiveBillingValue(row, "plan_price_id", null),
    current_period_end: readActiveBillingValue(row, "current_period_end", null),
    trial_end: readActiveBillingValue(row, "trial_end", null),
    cancel_at_period_end: Boolean(readActiveBillingValue(row, "cancel_at_period_end", false)),
    last_invoice_status: readActiveBillingValue(row, "last_invoice_status", null),
    canceled_at: readActiveBillingValue(row, "canceled_at", null),
    last_invoice_id: readActiveBillingValue(row, "last_invoice_id", null),
    last_payment_failed_at: readActiveBillingValue(row, "last_payment_failed_at", null),
    stripe_customer_id: readActiveBillingValue(row, "stripe_customer_id", null),
    stripe_subscription_id: readActiveBillingValue(row, "stripe_subscription_id", null),
    updated_at: row?.updated_at || null,
  };
}

function mapPriceIdToPlanType(priceId) {
  if (!priceId) return null;
  if (priceId === PRICE_BIZZI_HUMAN_REVIEW_ACTIVE) return "bizzi_human_review";
  return null;
}

function mapPlanLabel(planType) {
  if (planType === "bizzi_human_review") return "Core";
  return null;
}

function normalizePlanType(planType) {
  if (!planType) return null;
  if (planType === "bizzi_human_review") return "bizzi_human_review";
  return null;
}

function deriveSubscriptionEndIso(sub) {
  const unixSeconds = sub?.current_period_end || sub?.cancel_at || sub?.ended_at || null;
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

function resolveCheckoutPlanType(planType) {
  if (!planType) return "bizzi_human_review";
  return normalizePlanType(planType);
}

function sendError(res, status, error, message) {
  return res.status(status).json({ ok: false, error, message });
}

async function getOrCreateStripeCustomer(business) {
  if (!business?.id) return null;
  const { data: billingRow } = await supabase
    .from("business_billing")
    .select("*")
    .eq("business_id", business.id)
    .maybeSingle();

  const activeBilling = projectBillingRow(billingRow);
  if (activeBilling.stripe_customer_id) return activeBilling.stripe_customer_id;

  const customer = await stripe.customers.create({
    name: business.business_name || business.name || undefined,
    metadata: { businessId: business.id },
  });

  await upsertBusinessBilling(business.id, { stripe_customer_id: customer.id });
  return customer.id;
}

async function syncAndDedupeBillingFromSubscription(businessId, subscriptionId) {
  if (!businessId || !subscriptionId) return null;
  const payload = await syncBillingFromSubscription(businessId, subscriptionId);
  if (!payload?.stripe_customer_id) return payload;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const preferredPaymentMethodId =
    typeof subscription?.default_payment_method === "string"
      ? subscription.default_payment_method
      : subscription?.default_payment_method?.id || null;
  await dedupeCustomerCardPaymentMethods(payload.stripe_customer_id, preferredPaymentMethodId);
  return payload;
}

function mapSubStatus(status) {
  const allowed = new Set(["trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired"]);
  return allowed.has(status) ? status : status || "unknown";
}

export const billingRouter = express.Router();

// JSON for normal endpoints
billingRouter.use(express.json());

// Lightweight status endpoint
billingRouter.get("/status", requireAuth, async (req, res) => {
  const { business_id, user_id } = readIds(req);
  if (!business_id) return sendError(res, 400, "missing_business_id", "Business id is required.");
  if (!isUuid(business_id)) return sendError(res, 400, "invalid_ids", "Invalid business id.");
  try {
    if (!user_id || !isUuid(user_id)) {
      return sendError(res, 400, "invalid_ids", "Invalid user id.");
    }
    const owns = await assertBusinessOwnership(user_id, business_id);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");
    const { data } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", business_id)
      .maybeSingle();
    const fallback = {
      subscription_status: "free",
      plan_type: null,
      plan_price_id: null,
      current_period_end: null,
      trial_end: null,
      cancel_at_period_end: false,
      last_invoice_status: null,
      canceled_at: null,
      last_invoice_id: null,
      last_payment_failed_at: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      updated_at: null,
    };
    const payload = { ...fallback, ...projectBillingRow(data) };
    if (payload.stripe_subscription_id && !payload.current_period_end) {
      try {
        const stripeSubscription = await stripe.subscriptions.retrieve(payload.stripe_subscription_id);
        const derivedCurrentPeriodEnd = deriveSubscriptionEndIso(stripeSubscription);
        if (derivedCurrentPeriodEnd) {
          payload.current_period_end = derivedCurrentPeriodEnd;
          payload.subscription_status = mapSubStatus(stripeSubscription.status);
          payload.cancel_at_period_end = Boolean(stripeSubscription.cancel_at_period_end);
          await upsertBusinessBilling(business_id, {
            current_period_end: derivedCurrentPeriodEnd,
            subscription_status: payload.subscription_status,
            cancel_at_period_end: payload.cancel_at_period_end,
          });
        }
      } catch (syncErr) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[billing] status fallback sync failed", {
            businessId: business_id,
            subscriptionId: payload.stripe_subscription_id,
            message: syncErr?.message || syncErr,
          });
        }
      }
    }
    const status = payload.subscription_status || "free";
    const hasSubscription = Boolean(payload.stripe_subscription_id);
    const isPaidOrTrial = status === "active" || status === "trialing";
    const hasCustomer = Boolean(payload.stripe_customer_id);
    const blockingCheckoutStatuses = new Set([
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "incomplete",
      "incomplete_expired",
    ]);
    const canStartCheckout = !blockingCheckoutStatuses.has(status);
    const planLabel = mapPlanLabel(payload.plan_type);
    let accessLevel = "blocked";
    if (status === "active" || status === "trialing") accessLevel = "full";
    else if (status === "past_due") accessLevel = "limited";
    else if (status === "canceled") accessLevel = "read_only";
    return res.json({
      ...payload,
      plan_label: planLabel,
      has_subscription: hasSubscription,
      is_paid_or_trial: isPaidOrTrial,
      access_level: accessLevel,
      can_manage_in_portal: hasCustomer,
      can_start_checkout: canStartCheckout,
    });
  } catch (e) {
    console.warn("[billing] status error", e?.message || e);
    return sendError(res, 500, "billing_status_failed", "Failed to load billing status.");
  }
});

// Create Checkout session (14-day trial)
billingRouter.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const { user_id, business_id } = readIds(req);
    const { planType, businessId } = req.body || {};
    const resolvedBusinessId = businessId || business_id;
    if (!user_id || !resolvedBusinessId) {
      return sendError(res, 400, "missing_business_id", "User id and business id are required.");
    }
    if (!isUuid(user_id) || !isUuid(resolvedBusinessId)) {
      return sendError(res, 400, "invalid_ids", "Invalid user id or business id.");
    }
    const resolvedPlanType = resolveCheckoutPlanType(planType);
    if (!resolvedPlanType) {
      return sendError(res, 400, "invalid_plan_type", "Invalid plan type.");
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("[billing] checkout start", {
        stripeMode,
        planType: resolvedPlanType,
        businessId: resolvedBusinessId,
        hasActivePrice: Boolean(PRICE_BIZZI_HUMAN_REVIEW_ACTIVE),
      });
    }

    const owns = await assertBusinessOwnership(user_id, resolvedBusinessId);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");

    const { data: business, error: businessError } = await supabase
      .from("business_profiles")
      .select("id,business_name")
      .eq("id", resolvedBusinessId)
      .maybeSingle();
    if (businessError || !business) {
      return sendError(res, 404, "business_not_found", "Business not found.");
    }

    const { data: billingRow, error: billingError } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", resolvedBusinessId)
      .maybeSingle();
    if (billingError) {
      return sendError(res, 500, "billing_lookup_failed", "Failed to load billing status.");
    }
    const activeBilling = projectBillingRow(billingRow);
    const blockingCheckoutStatuses = new Set([
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "incomplete",
      "incomplete_expired",
    ]);
    if (blockingCheckoutStatuses.has(activeBilling.subscription_status)) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[billing] checkout blocked: existing subscription", {
          businessId: resolvedBusinessId,
          status: activeBilling.subscription_status,
        });
      }
      return sendError(res, 409, "subscription_already_exists", "Subscription already exists.");
    }

    const customerId = await getOrCreateStripeCustomer(business);
    if (!customerId) {
      return sendError(res, 500, "stripe_customer_failed", "Failed to create Stripe customer.");
    }

    const priceId = PRICE_BIZZI_HUMAN_REVIEW_ACTIVE;
    if (!priceId) {
      return sendError(
        res,
        500,
        "stripe_price_missing",
        "Stripe price is missing for the active Stripe mode."
      );
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("[billing] checkout plan", {
        stripeMode,
        planType: resolvedPlanType,
        businessId: resolvedBusinessId,
        hasActivePrice: Boolean(priceId),
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      customer_update: { name: "auto", address: "auto" },
      subscription_data: {
        metadata: { businessId: resolvedBusinessId, planType: resolvedPlanType },
      },
      metadata: { businessId: resolvedBusinessId, planType: resolvedPlanType },
      success_url: `${APP_URL}/dashboard/settings?tab=Billing&checkout=success`,
      cancel_url: `${APP_URL}/dashboard/settings?tab=Billing&checkout=cancel`,
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[billing] create-checkout-session error", err);
    return sendError(res, 500, "checkout_session_failed", "Failed to start checkout.");
  }
});

billingRouter.post("/create-portal-session", requireAuth, async (req, res) => {
  try {
    const { user_id, business_id } = readIds(req);
    const { businessId } = req.body || {};
    const resolvedBusinessId = businessId || business_id;
    if (!user_id || !resolvedBusinessId) {
      return sendError(res, 400, "missing_business_id", "User id and business id are required.");
    }
    if (!isUuid(user_id) || !isUuid(resolvedBusinessId)) {
      return sendError(res, 400, "invalid_ids", "Invalid user id or business id.");
    }

    const owns = await assertBusinessOwnership(user_id, resolvedBusinessId);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");

    const { data: billingRow, error } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", resolvedBusinessId)
      .maybeSingle();
    const activeBilling = projectBillingRow(billingRow);
    if (process.env.NODE_ENV !== "production") {
      console.log("[billing] portal requested", {
        businessId: resolvedBusinessId,
        stripeMode,
        hasCustomer: Boolean(activeBilling.stripe_customer_id),
      });
    }
    if (error || !activeBilling.stripe_customer_id) {
      return sendError(res, 400, "no_billing_customer", "No billing customer found.");
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: activeBilling.stripe_customer_id,
      return_url: `${APP_URL}/dashboard/settings?tab=Billing`,
    });
    return res.json({ ok: true, url: portal.url });
  } catch (err) {
    console.error("[billing] create-portal-session error", err);
    return sendError(res, 500, "portal_session_failed", "Failed to open billing portal.");
  }
});

billingRouter.post("/cleanup-payment-methods", requireAuth, async (req, res) => {
  try {
    const { user_id, business_id } = readIds(req);
    const { businessId } = req.body || {};
    const resolvedBusinessId = businessId || business_id;
    if (!user_id || !resolvedBusinessId) {
      return sendError(res, 400, "missing_business_id", "User id and business id are required.");
    }
    if (!isUuid(user_id) || !isUuid(resolvedBusinessId)) {
      return sendError(res, 400, "invalid_ids", "Invalid user id or business id.");
    }

    const owns = await assertBusinessOwnership(user_id, resolvedBusinessId);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");

    const { data: billingRow, error } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", resolvedBusinessId)
      .maybeSingle();
    const activeBilling = projectBillingRow(billingRow);
    if (error || !activeBilling.stripe_customer_id) {
      return sendError(res, 400, "no_billing_customer", "No billing customer found.");
    }

    let preferredPaymentMethodId = null;
    if (activeBilling.stripe_subscription_id) {
      try {
        const subscription = await stripe.subscriptions.retrieve(activeBilling.stripe_subscription_id);
        preferredPaymentMethodId =
          typeof subscription?.default_payment_method === "string"
            ? subscription.default_payment_method
            : subscription?.default_payment_method?.id || null;
      } catch (err) {
        console.warn("[billing] cleanup-payment-methods failed to load subscription default payment method", {
          businessId: resolvedBusinessId,
          subscriptionId: activeBilling.stripe_subscription_id,
          message: err?.message || err,
        });
      }
    }

    const result = await dedupeCustomerCardPaymentMethods(
      activeBilling.stripe_customer_id,
      preferredPaymentMethodId
    );

    return res.json({
      ok: true,
      customer_id: activeBilling.stripe_customer_id,
      total_methods_before: result?.totalMethods || 0,
      duplicate_groups: result?.duplicateGroups || 0,
      detached_count: result?.detachedPaymentMethodIds?.length || 0,
      detached_payment_method_ids: result?.detachedPaymentMethodIds || [],
      kept_payment_method_ids: result?.keptPaymentMethodIds || [],
    });
  } catch (err) {
    console.error("[billing] cleanup-payment-methods error", err);
    return sendError(
      res,
      500,
      "cleanup_payment_methods_failed",
      "Failed to clean up duplicate payment methods."
    );
  }
});

billingRouter.get("/invoices", requireAuth, async (req, res) => {
  try {
    const { user_id, business_id } = readIds(req);
    if (!business_id) return sendError(res, 400, "missing_business_id", "Business id is required.");
    if (!isUuid(business_id)) return sendError(res, 400, "invalid_ids", "Invalid business id.");
    if (!user_id || !isUuid(user_id)) return sendError(res, 400, "invalid_ids", "Invalid user id.");

    const owns = await assertBusinessOwnership(user_id, business_id);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");

    const { data: billingRow, error } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", business_id)
      .maybeSingle();
    const activeBilling = projectBillingRow(billingRow);
    if (error || !activeBilling.stripe_customer_id) {
      return res.json({ ok: true, rows: [] });
    }

    const invoices = await stripe.invoices.list({
      customer: activeBilling.stripe_customer_id,
      limit: 12,
    });
    const rows = (invoices?.data || []).map((inv) => ({
      id: inv.id || null,
      number: inv.number || null,
      status: inv.status || null,
      amount_paid: inv.amount_paid ?? null,
      amount_due: inv.amount_due ?? null,
      currency: inv.currency || null,
      created_at: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      hosted_invoice_url: inv.hosted_invoice_url || null,
      invoice_pdf: inv.invoice_pdf || null,
    }));

    if (process.env.NODE_ENV !== "production") {
      console.log("[billing] invoices fetched", { count: rows.length, businessId: business_id });
    }

    return res.json({ ok: true, rows });
  } catch (err) {
    console.error("[billing] invoices fetch error", err);
    return sendError(res, 500, "invoice_fetch_failed", "Failed to fetch invoices.");
  }
});

billingRouter.get("/payment-method", requireAuth, async (req, res) => {
  try {
    const { user_id, business_id } = readIds(req);
    if (!business_id) return sendError(res, 400, "missing_business_id", "Business id is required.");
    if (!isUuid(business_id)) return sendError(res, 400, "invalid_ids", "Invalid business id.");
    if (!user_id || !isUuid(user_id)) return sendError(res, 400, "invalid_ids", "Invalid user id.");

    const owns = await assertBusinessOwnership(user_id, business_id);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");

    const { data: billingRow, error } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", business_id)
      .maybeSingle();
    const activeBilling = projectBillingRow(billingRow);
    if (error || !activeBilling.stripe_customer_id) {
      return res.json({ ok: true, payment_method: null });
    }

    const customer = await stripe.customers.retrieve(activeBilling.stripe_customer_id);
    if (!customer || customer.deleted) {
      return res.json({ ok: true, payment_method: null });
    }
    const defaultPmId = customer?.invoice_settings?.default_payment_method || null;
    let card = null;
    if (defaultPmId) {
      const pm = await stripe.paymentMethods.retrieve(defaultPmId);
      card = pm?.card || null;
    }
    if (!card) {
      const pmList = await stripe.paymentMethods.list({
        customer: activeBilling.stripe_customer_id,
        type: "card",
        limit: 1,
      });
      card = pmList?.data?.[0]?.card || null;
    }

    if (!card) {
      return res.json({ ok: true, payment_method: null });
    }

    return res.json({
      ok: true,
      payment_method: {
        brand: card.brand || null,
        last4: card.last4 || null,
        exp_month: card.exp_month || null,
        exp_year: card.exp_year || null,
      },
    });
  } catch (err) {
    console.error("[billing] payment method fetch error", err);
    return sendError(res, 500, "payment_method_fetch_failed", "Failed to fetch payment method.");
  }
});

export async function billingWebhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  const activeSecret = STRIPE_WEBHOOK_SECRET_ACTIVE || "";
  const maskedSecret = activeSecret
    ? `${activeSecret.slice(0, 8)}...${activeSecret.slice(-6)}`
    : null;

  if (process.env.NODE_ENV !== "production") {
    console.log("[billing][webhook] incoming", {
      stripeMode,
      hasSignatureHeader: Boolean(sig),
      signatureHeaderLength: typeof sig === "string" ? sig.length : 0,
      hasActiveWebhookSecret: Boolean(activeSecret),
      activeWebhookSecretLength: activeSecret.length,
      activeWebhookSecretMasked: maskedSecret,
      contentType: req.headers["content-type"] || null,
    });
  }

  if (!STRIPE_WEBHOOK_SECRET_ACTIVE) {
    return res.status(500).json({
      ok: false,
      error: "webhook_secret_missing",
      message: "Stripe webhook secret is missing for the active Stripe mode.",
    });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET_ACTIVE);
  } catch (err) {
    console.error("[stripe] bad signature", {
      message: err.message,
      stripeMode,
      hasSignatureHeader: Boolean(sig),
      signatureHeaderLength: typeof sig === "string" ? sig.length : 0,
      hasActiveWebhookSecret: Boolean(activeSecret),
      activeWebhookSecretLength: activeSecret.length,
      activeWebhookSecretMasked: maskedSecret,
      contentType: req.headers["content-type"] || null,
    });
    return res.status(400).json({
      ok: false,
      error: "invalid_signature",
      message: "Webhook signature verification failed.",
    });
  }

  const touchBilling = async (businessId, fields = {}) => {
    if (!businessId) return;
    await upsertBusinessBilling(businessId, fields);
  };

  const extractBusinessId = async (obj) => {
    const objectMeta = obj?.metadata || {};
    const fromObjectMeta = objectMeta.businessId || objectMeta.business_id || null;
    if (fromObjectMeta) return fromObjectMeta;
    const subMeta = obj?.subscription_metadata || {};
    const fromSubMeta = subMeta.businessId || subMeta.business_id || null;
    if (fromSubMeta) return fromSubMeta;
    if (obj?.subscription) {
      try {
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        return sub?.metadata?.businessId || sub?.metadata?.business_id || null;
      } catch {}
    }
    if (obj?.customer) {
      try {
        const cust = await stripe.customers.retrieve(obj.customer);
        return cust?.metadata?.businessId || cust?.metadata?.business_id || null;
      } catch {}
    }
    return null;
  };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const businessId = await extractBusinessId(session);
        const subId = session.subscription;
        const custId = session.customer;
        const planType = normalizePlanType(session?.metadata?.planType || session?.metadata?.plan_type || null);
        if (process.env.NODE_ENV !== "production") {
          console.log("[billing][webhook] checkout.session.completed", {
            stripeMode,
            eventType: event.type,
            hasBusinessId: Boolean(businessId),
            businessId,
            subscriptionId: subId || null,
            customerId: custId || null,
          });
        }
        if (businessId) {
          await touchBilling(businessId, {
            stripe_customer_id: custId,
            stripe_subscription_id: subId,
            plan_type: planType,
          });
          if (subId) {
            await syncAndDedupeBillingFromSubscription(businessId, subId);
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const businessId = await extractBusinessId(sub);
        const priceId = sub.items?.data?.[0]?.price?.id || null;
        const status = mapSubStatus(sub.status);
        if (process.env.NODE_ENV !== "production") {
          console.log(`[billing][webhook] ${event.type}`, {
            stripeMode,
            eventType: event.type,
            hasBusinessId: Boolean(businessId),
            businessId,
            subscriptionId: sub.id || null,
            customerId: sub.customer || null,
          });
        }
        if (!businessId && process.env.NODE_ENV !== "production") {
          console.warn("[billing][webhook] missing businessId for subscription event", {
            eventType: event.type,
            subscriptionId: sub.id || null,
            customerId: sub.customer || null,
          });
        }
        const metadataPlanType = normalizePlanType(sub?.metadata?.planType || sub?.metadata?.plan_type || null);
        const payload = {
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          subscription_status: status,
          current_period_end: deriveSubscriptionEndIso(sub),
          trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          cancel_at_period_end: Boolean(sub.cancel_at_period_end),
          plan_price_id: priceId,
          plan_type: mapPriceIdToPlanType(priceId) || metadataPlanType,
          canceled_at: status === "canceled" ? new Date().toISOString() : null,
        };
        await touchBilling(businessId, payload);
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object;
        const businessId = await extractBusinessId(inv);
        if (process.env.NODE_ENV !== "production") {
          console.log("[billing][webhook] invoice.paid", {
            stripeMode,
            eventType: event.type,
            hasBusinessId: Boolean(businessId),
            businessId,
            subscriptionId: inv.subscription || null,
            customerId: inv.customer || null,
          });
        }
        await touchBilling(businessId, {
          last_invoice_status: "paid",
          last_invoice_id: inv.id || null,
          last_payment_failed_at: null,
        });
        if (businessId && inv.subscription) {
          await syncAndDedupeBillingFromSubscription(businessId, inv.subscription);
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const businessId = await extractBusinessId(inv);
        if (process.env.NODE_ENV !== "production") {
          console.log("[billing][webhook] invoice.payment_failed", {
            stripeMode,
            eventType: event.type,
            hasBusinessId: Boolean(businessId),
            businessId,
            subscriptionId: inv.subscription || null,
            customerId: inv.customer || null,
          });
        }
        await touchBilling(businessId, {
          last_invoice_status: "payment_failed",
          last_invoice_id: inv.id || null,
          last_payment_failed_at: new Date().toISOString(),
        });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("[stripe] webhook handler error", err);
    return res.status(500).json({
      ok: false,
      error: "webhook_handler_failed",
      message: "Webhook handler failed.",
    });
  }

  return res.json({ received: true });
}
