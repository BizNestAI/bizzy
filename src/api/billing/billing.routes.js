// src/api/billing/billing.routes.js
import express from 'express';
import Stripe from 'stripe';
import { supabase } from '../../services/supabaseAdmin.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

const PRICE_ID = process.env.PRICE_ID;              // e.g. price_123
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

export const billingRouter = express.Router();

// Parse JSON for normal endpoints on THIS router.
// (The webhook uses raw body; see below.)
billingRouter.use(express.json());

/** Utility: unix timestamp for the first day of next month at 00:00 UTC */
function nextMonthFirst() {
  const d = new Date();
  // move to next month, day 1
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * POST /api/billing/create-checkout-session
 * body: { user_id, business_id }
 * Creates (or reuses) a Stripe customer, starts Checkout for a subscription,
 * anchors billing on the 1st of the next month, with a trial until that date.
 */
billingRouter.post('/create-checkout-session', async (req, res) => {
  try {
    const { user_id, business_id } = req.body || {};
    if (!user_id || !business_id) {
      return res.status(400).json({ error: 'Missing user_id or business_id' });
    }

    // 1) fetch or create customer for this user
    let { data: record, error: fetchErr } = await supabase
      .from('billing_customers')
      .select('stripe_customer_id')
      .eq('user_id', user_id)
      .maybeSingle();

    if (fetchErr) {
      console.error('[billing] fetch billing_customers error', fetchErr);
    }

    let customerId = record?.stripe_customer_id;
    if (!customerId) {
      const created = await stripe.customers.create({
        metadata: { user_id },
      });
      customerId = created.id;
      const { error: insertErr } = await supabase
        .from('billing_customers')
        .insert({ user_id, stripe_customer_id: customerId });
      if (insertErr) console.error('[billing] insert billing_customers error', insertErr);
    }

    // 2) anchor + trial to the 1st of next month
    const anchor = nextMonthFirst();

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      subscription_data: {
        metadata: { business_id, user_id },
        billing_cycle_anchor: anchor,
        proration_behavior: 'none',
        trial_end: anchor, // no charge until anchor
      },
      success_url: `${APP_URL}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/settings?billing=cancel`,
      allow_promotion_codes: false,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] create-checkout-session error', err);
    return res.status(500).json({ error: 'Failed to start checkout' });
  }
});

/**
 * POST /api/billing/create-portal-session
 * body: { user_id }
 * Creates a Stripe customer portal session for the user.
 */
billingRouter.post('/create-portal-session', async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

    const { data: record, error } = await supabase
      .from('billing_customers')
      .select('stripe_customer_id')
      .eq('user_id', user_id)
      .single();

    if (error || !record) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: record.stripe_customer_id,
      return_url: `${APP_URL}/settings?billing=portal_return`,
    });

    return res.json({ url: portal.url });
  } catch (err) {
    console.error('[billing] create-portal-session error', err);
    return res.status(500).json({ error: 'Failed to open customer portal' });
  }
});

/**
 * Stripe webhook (raw body)
 * Mount as /api/billing/webhook with express.raw({ type: 'application/json' })
 * in server.js or here (see export below).
 */
export const billingWebhookHandler = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe] bad signature', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // optional: look up session.customer / session.subscription if you need
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const business_id = sub.metadata?.business_id;
        if (business_id) {
          await supabase
            .from('subscriptions')
            .upsert({
              business_id,
              stripe_subscription_id: sub.id,
              status: sub.status,
              current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
              price_id: sub.items?.data?.[0]?.price?.id || null,
            }, { onConflict: 'business_id' });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const business_id = sub.metadata?.business_id;
        if (business_id) {
          await supabase
            .from('subscriptions')
            .update({ status: 'canceled' })
            .eq('business_id', business_id);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const subId = inv.subscription;
        if (subId) {
          // Find business via subscription row (if you store it)
          const { data: subRec } = await supabase
            .from('subscriptions')
            .select('business_id')
            .eq('stripe_subscription_id', subId)
            .maybeSingle();
          if (subRec?.business_id) {
            await supabase.from('invoices').insert({
              stripe_invoice_id: inv.id,
              business_id: subRec.business_id,
              amount_due: inv.amount_due,
              amount_paid: inv.amount_paid,
              status: inv.status,
              hosted_invoice_url: inv.hosted_invoice_url,
            });
          }
        }
        break;
      }
      case 'invoice.payment_failed': {
        // optional: mark dunning / notify user
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[stripe] webhook handler error', err);
    return res.status(500).send('Webhook handler failed');
  }

  return res.json({ received: true });
};
