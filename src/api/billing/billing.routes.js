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
import { requireBusinessAccess } from "../_shared/tenantAuth.js";
import { claimStripeWebhookEventForProcessing } from "./stripeWebhookIdempotency.js";

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
const STRIPE_WEBHOOK_EVENTS_TABLE = "stripe_webhook_events";
const STRIPE_WEBHOOK_LEASE_MS = Number(process.env.STRIPE_WEBHOOK_LEASE_MS || 5 * 60 * 1000);

function normalizeOrigin(value) {
  const raw = String(value || "")
    .split("#")[0]
    .trim()
    .replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseOriginList(...values) {
  const origins = [];
  values
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map(normalizeOrigin)
    .filter(Boolean)
    .forEach((origin) => {
      if (!origins.includes(origin)) origins.push(origin);
    });
  return origins;
}

const CONFIGURED_APP_ORIGINS = parseOriginList(
  APP_URL,
  process.env.APP_BASE_URL,
  process.env.FRONTEND_URL,
  process.env.PUBLIC_APP_URL
);

const CONFIGURED_CORS_ORIGINS = parseOriginList(
  process.env.CORS_ORIGINS,
  process.env.CORS_ORIGIN,
  "https://app.bizzios.com",
  "https://bizzios.com",
  "https://www.bizzios.com",
  "https://bizzi-ten.vercel.app",
  process.env.NODE_ENV !== "production" ? "http://localhost:5173" : null
);

function resolveReturnOrigin(req) {
  const requestOrigin = normalizeOrigin(req.headers?.origin);
  if (requestOrigin && CONFIGURED_CORS_ORIGINS.includes(requestOrigin)) {
    return requestOrigin;
  }
  return CONFIGURED_APP_ORIGINS[0] || "http://localhost:5173";
}

function readIds(req) {
  const q = req.query || {};
  const b = req.body || {};
  const h = req.headers || {};
  const user_id = req.auth?.userId || req.user?.id || null;
  const business_id = req.business?.id || req.auth?.businessId || req.user?.business_id || b.businessId || b.business_id || q.business_id || q.businessId || h["x-business-id"] || null;
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

async function markStripeWebhookEventProcessed(eventId) {
  if (!eventId) return;
  const { error } = await supabase
    .from(STRIPE_WEBHOOK_EVENTS_TABLE)
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
      processing_started_at: null,
      error_code: null,
      error_message: null,
    })
    .eq("event_id", eventId);
  if (error) throw error;
}

async function markStripeWebhookEventFailed(eventId, err) {
  if (!eventId) return;
  const { error } = await supabase
    .from(STRIPE_WEBHOOK_EVENTS_TABLE)
    .update({
      processing_status: "failed",
      failed_at: new Date().toISOString(),
      error_code: String(err?.code || err?.name || "stripe_webhook_handler_failed").slice(0, 120),
      error_message: String(err?.message || "Stripe webhook handler failed.").slice(0, 500),
    })
    .eq("event_id", eventId);
  if (error) {
    console.error("[stripe] webhook idempotency failure mark failed", error?.message || error);
  }
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

function compactUnique(values = []) {
  const seen = new Set();
  return values
    .map((value) => (typeof value === "string" ? value.trim() : value))
    .filter((value) => typeof value === "string" && value.length > 0)
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function getBillingIdCandidates(row, key) {
  if (!row) return [];
  const activeKey = ACTIVE_BILLING_COLUMNS[key];
  const inactiveSuffix = ACTIVE_SUFFIX === "test" ? "live" : "test";
  const inactiveKey = `${key}_${inactiveSuffix}`;
  return compactUnique([activeKey ? row[activeKey] : null, row[key], row[inactiveKey]]);
}

function getCustomerBusinessId(customer) {
  return customer?.metadata?.businessId || customer?.metadata?.business_id || null;
}

function customerMatchesBusiness(customer, businessId) {
  if (!customer || customer.deleted) return false;
  const customerBusinessId = getCustomerBusinessId(customer);
  return !customerBusinessId || customerBusinessId === businessId;
}

function getSubscriptionBusinessId(subscription) {
  return subscription?.metadata?.businessId || subscription?.metadata?.business_id || null;
}

function subscriptionMatchesBusiness(subscription, businessId) {
  if (!subscription) return false;
  const subscriptionBusinessId = getSubscriptionBusinessId(subscription);
  return !subscriptionBusinessId || subscriptionBusinessId === businessId;
}

async function getUserProfile(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from("user_profiles")
    .select("id,email,full_name,first_name,last_name")
    .eq("id", userId)
    .maybeSingle();
  return data || null;
}

function buildCustomerUpdateParams(business, userProfile = null, customer = null) {
  const businessName = business?.business_name || business?.name || null;
  const profileEmail = userProfile?.email || null;
  const existingMetadata = customer?.metadata || {};
  const metadata = {
    ...existingMetadata,
    businessId: business.id,
    business_id: business.id,
  };
  if (business?.user_id) metadata.userId = business.user_id;

  const params = { metadata };
  if (businessName && customer?.name !== businessName) params.name = businessName;
  if (profileEmail && customer?.email !== profileEmail) params.email = profileEmail;
  return params;
}

async function syncCustomerIdentity(customer, business, userProfile = null) {
  if (!customer?.id || !business?.id) return customer;
  const updateParams = buildCustomerUpdateParams(business, userProfile, customer);
  const needsUpdate =
    updateParams.name !== undefined ||
    updateParams.email !== undefined ||
    getCustomerBusinessId(customer) !== business.id ||
    customer?.metadata?.business_id !== business.id ||
    (business?.user_id && customer?.metadata?.userId !== business.user_id);

  if (!needsUpdate) return customer;
  return await stripe.customers.update(customer.id, updateParams);
}

async function resolveStripeCustomerForBusiness(business, billingRow = null, extraCustomerIds = []) {
  if (!business?.id) return null;
  const userProfile = await getUserProfile(business.user_id);
  const activeBilling = projectBillingRow(billingRow);
  const customerIds = compactUnique([
    activeBilling.stripe_customer_id,
    ...getBillingIdCandidates(billingRow, "stripe_customer_id"),
    ...extraCustomerIds,
  ]);

  for (const customerId of customerIds) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (!customer || customer.deleted) continue;
      if (!customerMatchesBusiness(customer, business.id)) {
        console.warn("[billing] ignoring Stripe customer for different business", {
          businessId: business.id,
          customerId,
          customerBusinessId: getCustomerBusinessId(customer),
        });
        continue;
      }
      const syncedCustomer = await syncCustomerIdentity(customer, business, userProfile);
      if (syncedCustomer?.id !== activeBilling.stripe_customer_id) {
        await upsertBusinessBilling(business.id, { stripe_customer_id: syncedCustomer.id });
      }
      return syncedCustomer;
    } catch (err) {
      console.warn("[billing] customer candidate lookup failed", {
        businessId: business.id,
        customerId,
        message: err?.message || err,
      });
    }
  }

  return null;
}

async function retrieveSubscriptionFromCandidates(subscriptionIds = []) {
  for (const subscriptionId of compactUnique(subscriptionIds)) {
    try {
      return await stripe.subscriptions.retrieve(subscriptionId, {
        expand: [
          "default_payment_method",
          "latest_invoice.default_payment_method",
          "latest_invoice.payment_intent.payment_method",
          "latest_invoice.charge",
        ],
      });
    } catch {
      // Try the next candidate. The active Stripe mode decides which ID will exist.
    }
  }
  return null;
}

function mapPriceIdToPlanType(priceId) {
  if (!priceId) return null;
  if (priceId === PRICE_BIZZI_HUMAN_REVIEW_ACTIVE) return "bizzi_human_review";
  return null;
}

function mapPlanLabel(planType) {
  if (planType === "bizzi_human_review") return "Bizzi Accounting";
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

  const existingCustomer = await resolveStripeCustomerForBusiness(business, billingRow);
  if (existingCustomer?.id) return existingCustomer.id;

  const userProfile = await getUserProfile(business.user_id);
  const createParams = buildCustomerUpdateParams(business, userProfile, { metadata: {} });
  const customer = await stripe.customers.create({
    name: createParams.name,
    email: createParams.email,
    metadata: createParams.metadata,
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
const requireVerifiedBillingBusiness = [requireAuth, requireBusinessAccess()];

// JSON for normal endpoints
billingRouter.use(express.json());

// Lightweight status endpoint
billingRouter.get("/status", ...requireVerifiedBillingBusiness, async (req, res) => {
  const { business_id, user_id } = readIds(req);
  if (!business_id) return sendError(res, 400, "missing_business_id", "Business id is required.");
  if (!isUuid(business_id)) return sendError(res, 400, "invalid_ids", "Invalid business id.");
  try {
    if (!user_id || !isUuid(user_id)) {
      return sendError(res, 400, "invalid_ids", "Invalid user id.");
    }
    const owns = await assertBusinessOwnership(user_id, business_id);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");
    const { data: business, error: businessError } = await supabase
      .from("business_profiles")
      .select("id,user_id,business_name")
      .eq("id", business_id)
      .maybeSingle();
    if (businessError || !business) {
      return sendError(res, 404, "business_not_found", "Business not found.");
    }
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
    const customer = await resolveStripeCustomerForBusiness(business, data);
    payload.stripe_customer_id = customer?.id || null;

    if (payload.stripe_subscription_id) {
      try {
        const stripeSubscription = await stripe.subscriptions.retrieve(payload.stripe_subscription_id);
        const subscriptionCustomerId =
          typeof stripeSubscription?.customer === "string"
            ? stripeSubscription.customer
            : stripeSubscription?.customer?.id || null;
        const subscriptionBelongsHere =
          subscriptionMatchesBusiness(stripeSubscription, business_id) &&
          (!payload.stripe_customer_id || !subscriptionCustomerId || subscriptionCustomerId === payload.stripe_customer_id);

        if (!subscriptionBelongsHere) {
          console.warn("[billing] ignoring Stripe subscription for different business", {
            businessId: business_id,
            subscriptionId: payload.stripe_subscription_id,
            subscriptionBusinessId: getSubscriptionBusinessId(stripeSubscription),
            subscriptionCustomerId,
            customerId: payload.stripe_customer_id,
          });
          payload.stripe_subscription_id = null;
          payload.subscription_status = "free";
          payload.plan_type = null;
          payload.plan_price_id = null;
          payload.current_period_end = null;
          payload.trial_end = null;
          payload.cancel_at_period_end = false;
        } else {
          const priceId = stripeSubscription.items?.data?.[0]?.price?.id || null;
          const derivedCurrentPeriodEnd = deriveSubscriptionEndIso(stripeSubscription);
          payload.current_period_end = derivedCurrentPeriodEnd;
          payload.subscription_status = mapSubStatus(stripeSubscription.status);
          payload.cancel_at_period_end = Boolean(stripeSubscription.cancel_at_period_end);
          payload.plan_price_id = priceId;
          payload.plan_type =
            mapPriceIdToPlanType(priceId) ||
            normalizePlanType(stripeSubscription?.metadata?.planType || stripeSubscription?.metadata?.plan_type || null);
          await upsertBusinessBilling(business_id, {
            current_period_end: derivedCurrentPeriodEnd,
            subscription_status: payload.subscription_status,
            cancel_at_period_end: payload.cancel_at_period_end,
            plan_price_id: payload.plan_price_id,
            plan_type: payload.plan_type,
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
billingRouter.post("/create-checkout-session", ...requireVerifiedBillingBusiness, async (req, res) => {
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
      .select("id,user_id,business_name")
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
    const existingCustomer = await resolveStripeCustomerForBusiness(business, billingRow);
    let hasBlockingSubscription = false;
    if (blockingCheckoutStatuses.has(activeBilling.subscription_status) && activeBilling.stripe_subscription_id) {
      try {
        const existingSubscription = await stripe.subscriptions.retrieve(activeBilling.stripe_subscription_id);
        const subscriptionCustomerId =
          typeof existingSubscription?.customer === "string"
            ? existingSubscription.customer
            : existingSubscription?.customer?.id || null;
        hasBlockingSubscription =
          subscriptionMatchesBusiness(existingSubscription, resolvedBusinessId) &&
          (!existingCustomer?.id || !subscriptionCustomerId || subscriptionCustomerId === existingCustomer.id);
      } catch {
        hasBlockingSubscription = false;
      }
    }
    if (hasBlockingSubscription) {
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

    const returnOrigin = resolveReturnOrigin(req);

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
      success_url: `${returnOrigin}/dashboard/settings?tab=Billing&checkout=success`,
      cancel_url: `${returnOrigin}/dashboard/settings?tab=Billing&checkout=cancel`,
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[billing] create-checkout-session error", err);
    return sendError(res, 500, "checkout_session_failed", "Failed to start checkout.");
  }
});

billingRouter.post("/create-portal-session", ...requireVerifiedBillingBusiness, async (req, res) => {
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

    const { data: business, error: businessError } = await supabase
      .from("business_profiles")
      .select("id,user_id,business_name")
      .eq("id", resolvedBusinessId)
      .maybeSingle();
    if (businessError || !business) {
      return sendError(res, 404, "business_not_found", "Business not found.");
    }

    const { data: billingRow, error } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", resolvedBusinessId)
      .maybeSingle();
    const customer = await resolveStripeCustomerForBusiness(business, billingRow);
    if (process.env.NODE_ENV !== "production") {
      console.log("[billing] portal requested", {
        businessId: resolvedBusinessId,
        stripeMode,
        hasCustomer: Boolean(customer?.id),
      });
    }
    if (error || !customer?.id) {
      return sendError(res, 400, "no_billing_customer", "No billing customer found.");
    }

    const returnOrigin = resolveReturnOrigin(req);

    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${returnOrigin}/dashboard/settings?tab=Billing`,
    });
    return res.json({ ok: true, url: portal.url });
  } catch (err) {
    console.error("[billing] create-portal-session error", err);
    return sendError(res, 500, "portal_session_failed", "Failed to open billing portal.");
  }
});

billingRouter.post("/cleanup-payment-methods", ...requireVerifiedBillingBusiness, async (req, res) => {
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

    const { data: business, error: businessError } = await supabase
      .from("business_profiles")
      .select("id,user_id,business_name")
      .eq("id", resolvedBusinessId)
      .maybeSingle();
    if (businessError || !business) {
      return sendError(res, 404, "business_not_found", "Business not found.");
    }

    const { data: billingRow, error } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", resolvedBusinessId)
      .maybeSingle();
    const activeBilling = projectBillingRow(billingRow);
    const customer = await resolveStripeCustomerForBusiness(business, billingRow);
    if (error || !customer?.id) {
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
      customer.id,
      preferredPaymentMethodId
    );

    return res.json({
      ok: true,
      customer_id: customer.id,
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

billingRouter.get("/invoices", ...requireVerifiedBillingBusiness, async (req, res) => {
  try {
    const { user_id, business_id } = readIds(req);
    if (!business_id) return sendError(res, 400, "missing_business_id", "Business id is required.");
    if (!isUuid(business_id)) return sendError(res, 400, "invalid_ids", "Invalid business id.");
    if (!user_id || !isUuid(user_id)) return sendError(res, 400, "invalid_ids", "Invalid user id.");

    const owns = await assertBusinessOwnership(user_id, business_id);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");

    const { data: business, error: businessError } = await supabase
      .from("business_profiles")
      .select("id,user_id,business_name")
      .eq("id", business_id)
      .maybeSingle();
    if (businessError || !business) {
      return sendError(res, 404, "business_not_found", "Business not found.");
    }

    const { data: billingRow, error } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", business_id)
      .maybeSingle();
    const customer = await resolveStripeCustomerForBusiness(business, billingRow);
    if (error || !customer?.id) {
      return res.json({ ok: true, rows: [] });
    }

    const invoices = await stripe.invoices.list({
      customer: customer.id,
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

billingRouter.get("/payment-method", ...requireVerifiedBillingBusiness, async (req, res) => {
  try {
    const { user_id, business_id } = readIds(req);
    if (!business_id) return sendError(res, 400, "missing_business_id", "Business id is required.");
    if (!isUuid(business_id)) return sendError(res, 400, "invalid_ids", "Invalid business id.");
    if (!user_id || !isUuid(user_id)) return sendError(res, 400, "invalid_ids", "Invalid user id.");

    const owns = await assertBusinessOwnership(user_id, business_id);
    if (!owns) return sendError(res, 403, "forbidden", "You do not own this business.");

    const { data: business, error: businessError } = await supabase
      .from("business_profiles")
      .select("id,user_id,business_name")
      .eq("id", business_id)
      .maybeSingle();
    if (businessError || !business) {
      return sendError(res, 404, "business_not_found", "Business not found.");
    }

    const { data: billingRow, error } = await supabase
      .from("business_billing")
      .select("*")
      .eq("business_id", business_id)
      .maybeSingle();
    if (error || !billingRow) {
      return res.json({ ok: true, payment_method: null });
    }

    const activeBilling = projectBillingRow(billingRow);
    const customerIdCandidates = compactUnique([
      activeBilling.stripe_customer_id,
      ...getBillingIdCandidates(billingRow, "stripe_customer_id"),
    ]);
    const subscriptionIdCandidates = compactUnique([
      activeBilling.stripe_subscription_id,
      ...getBillingIdCandidates(billingRow, "stripe_subscription_id"),
    ]);

    let subscription = await retrieveSubscriptionFromCandidates(subscriptionIdCandidates);
    let subscriptionCustomerId =
      typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id || null;
    const customer = await resolveStripeCustomerForBusiness(
      business,
      billingRow,
      compactUnique([subscriptionCustomerId, ...customerIdCandidates])
    );
    if (!customer) return res.json({ ok: true, payment_method: null });
    if (
      subscription &&
      (!subscriptionMatchesBusiness(subscription, business_id) ||
        (subscriptionCustomerId && subscriptionCustomerId !== customer.id))
    ) {
      console.warn("[billing] ignoring payment-method subscription for different business", {
        businessId: business_id,
        subscriptionId: subscription.id,
        subscriptionBusinessId: getSubscriptionBusinessId(subscription),
        subscriptionCustomerId,
        customerId: customer.id,
      });
      subscription = null;
      subscriptionCustomerId = null;
    }

    let card = null;

    const setCardFromPaymentMethod = (paymentMethod) => {
      if (!card && paymentMethod?.card) card = paymentMethod.card;
    };
    const setCardFromSource = (source) => {
      if (!card && source?.object === "card") card = source;
    };
    const setCardFromCharge = (charge) => {
      if (!card && charge?.payment_method_details?.card) {
        card = charge.payment_method_details.card;
      }
    };
    const retrievePaymentMethod = async (paymentMethodRef) => {
      const paymentMethodId =
        typeof paymentMethodRef === "string" ? paymentMethodRef : paymentMethodRef?.id || null;
      if (!paymentMethodId) return null;
      try {
        return await stripe.paymentMethods.retrieve(paymentMethodId);
      } catch (err) {
        console.warn("[billing] payment method retrieve failed", {
          paymentMethodId,
          message: err?.message || err,
        });
        return null;
      }
    };

    const customerDefaultPaymentMethod = await retrievePaymentMethod(
      customer?.invoice_settings?.default_payment_method || null
    );
    setCardFromPaymentMethod(customerDefaultPaymentMethod);

    if (!card && customer?.default_source) {
      try {
        const sourceRef =
          typeof customer.default_source === "string" ? customer.default_source : customer.default_source?.id || null;
        const source = sourceRef ? await stripe.customers.retrieveSource(customer.id, sourceRef) : null;
        setCardFromSource(source);
      } catch (err) {
        console.warn("[billing] customer source lookup failed", {
          customerId: customer.id,
          message: err?.message || err,
        });
      }
    }

    if (!card) {
      setCardFromPaymentMethod(subscription?.default_payment_method);
      setCardFromPaymentMethod(subscription?.latest_invoice?.default_payment_method);
      setCardFromCharge(subscription?.latest_invoice?.charge);

      const invoicePaymentMethod = subscription?.latest_invoice?.payment_intent?.payment_method || null;
      if (!card && invoicePaymentMethod) {
        const paymentMethod = invoicePaymentMethod?.card
          ? invoicePaymentMethod
          : await retrievePaymentMethod(invoicePaymentMethod);
        setCardFromPaymentMethod(paymentMethod);
      }
    }

    if (!card) {
      const invoiceQueries = [
        subscription?.id ? { customer: customer.id, subscription: subscription.id } : null,
        { customer: customer.id },
      ].filter(Boolean);

      for (const invoiceQuery of invoiceQueries) {
        const invoiceList = await stripe.invoices.list({
          ...invoiceQuery,
          limit: 5,
          expand: ["data.default_payment_method", "data.payment_intent.payment_method", "data.charge"],
        });
        const invoices = Array.isArray(invoiceList?.data) ? invoiceList.data : [];
        for (const invoice of invoices) {
          setCardFromPaymentMethod(invoice?.default_payment_method);
          setCardFromCharge(invoice?.charge);
          const invoicePaymentMethod = invoice?.payment_intent?.payment_method || null;
          if (!card && invoicePaymentMethod) {
            const paymentMethod = invoicePaymentMethod?.card
              ? invoicePaymentMethod
              : await retrievePaymentMethod(invoicePaymentMethod);
            setCardFromPaymentMethod(paymentMethod);
          }
          if (card) break;
        }
        if (card) break;
      }
    }

    if (!card) {
      const pmList = await stripe.paymentMethods.list({
        customer: customer.id,
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

  let eventClaim;
  try {
    eventClaim = await claimStripeWebhookEventForProcessing({
      supabaseClient: supabase,
      event,
      stripeMode,
      leaseMs: STRIPE_WEBHOOK_LEASE_MS,
      tableName: STRIPE_WEBHOOK_EVENTS_TABLE,
    });
  } catch (err) {
    console.error("[stripe] webhook idempotency claim failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "webhook_idempotency_failed",
      message: "Webhook replay protection failed.",
    });
  }

  if (!eventClaim?.claimed) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[billing][webhook] duplicate Stripe event skipped", {
        eventId: event.id || null,
        eventType: event.type || null,
      });
    }
    return res.json({ received: true, duplicate: true });
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
    await markStripeWebhookEventFailed(event.id, err);
    console.error("[stripe] webhook handler error", err);
    return res.status(500).json({
      ok: false,
      error: "webhook_handler_failed",
      message: "Webhook handler failed.",
    });
  }

  try {
    await markStripeWebhookEventProcessed(event.id);
  } catch (err) {
    console.error("[stripe] webhook idempotency mark processed failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "webhook_idempotency_update_failed",
      message: "Webhook replay protection update failed.",
    });
  }

  return res.json({ received: true });
}
