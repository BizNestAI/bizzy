// src/api/billing/stripe.js
import Stripe from 'stripe';

function resolveStripeMode() {
  const requestedMode = String(process.env.STRIPE_MODE || '').trim().toLowerCase();
  if (requestedMode === 'test' || requestedMode === 'live') return requestedMode;
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
}

export const stripeMode = resolveStripeMode();

const ACTIVE_SECRET_KEY =
  stripeMode === 'test'
    ? process.env.STRIPE_SECRET_KEY_TEST
    : process.env.STRIPE_SECRET_KEY;

export const PRICE_BIZZI_HUMAN_REVIEW_ACTIVE =
  stripeMode === 'test'
    ? process.env.STRIPE_PRICE_BIZZI_HUMAN_REVIEW_TEST
    : process.env.STRIPE_PRICE_BIZZI_HUMAN_REVIEW;

export const STRIPE_WEBHOOK_SECRET_ACTIVE =
  stripeMode === 'test'
    ? process.env.STRIPE_WEBHOOK_SECRET_TEST
    : process.env.STRIPE_WEBHOOK_SECRET;

if (!ACTIVE_SECRET_KEY) {
  throw new Error(`Missing Stripe secret key for active mode "${stripeMode}"`);
}

if (process.env.NODE_ENV !== 'production') {
  console.log('[billing] stripe config', {
    stripeMode,
    hasActiveSecretKey: Boolean(ACTIVE_SECRET_KEY),
    hasActiveWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET_ACTIVE),
    hasActivePrice: Boolean(PRICE_BIZZI_HUMAN_REVIEW_ACTIVE),
  });
}

export const stripe = new Stripe(ACTIVE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});
