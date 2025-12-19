// src/api/billing/billing.controller.js
import { stripe } from './stripe.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
dayjs.extend(utc);

// Helpers
function nextFirstOfMonthUnix() {
  const now = dayjs.utc();
  const nextMonth = now.date() === 1 ? now : now.add(1, 'month');
  return nextMonth.startOf('month').unix();
}

export async function createCheckoutSession(req, res, next) {
  try {
    const { user_id, business_id } = req.body || {};
    if (!user_id || !business_id) {
      return res.status(400).json({ error: 'user_id and business_id are required' });
    }

    // Lookup or create Stripe customer (store stripe_customer_id on your profiles table)
    // In MVP we simply create every time if not saved.
    const customer = await stripe.customers.create({
      metadata: { user_id, business_id },
    });

    // Trial until the 1st to align billing date
    const trialEnd = nextFirstOfMonthUnix();

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      success_url: `${process.env.APP_URL}/settings?billing=success`,
      cancel_url: `${process.env.APP_URL}/settings?billing=cancel`,
      customer: customer.id,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // one monthly plan
          quantity: 1,
        },
      ],
      subscription_data: {
        // Using trial_end to align first charge to next 1st (Stripe charges when trial ends)
        trial_end: trialEnd,
        // Optional—no proration surprises if you later change tiers
        proration_behavior: 'none',
        metadata: { user_id, business_id },
      },
      metadata: { user_id, business_id },
    });

    return res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
}

export async function createPortalSession(req, res, next) {
  try {
    const { user_id, stripe_customer_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    // If you store stripe_customer_id on the user profile, read it here instead of creating.
    const customerId = stripe_customer_id || (await stripe.customers.create({
      metadata: { user_id },
    })).id;

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.APP_URL}/settings?billing=return`,
    });

    return res.json({ url: portal.url });
  } catch (err) {
    next(err);
  }
}

// Webhook to keep Supabase in sync
export async function stripeWebhook(req, res, next) {
  try {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody, // IMPORTANT: body must be raw for Stripe verification
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Example events to handle
    switch (event.type) {
      case 'checkout.session.completed': {
        // Persist customer/subscription ids on your user/business
        const s = event.data.object;
        // TODO: upsert into Supabase (profiles/subscriptions tables)
        // s.customer, s.subscription
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        // TODO: upsert status & current_period_end into Supabase
        // sub.id, sub.status, sub.current_period_end, sub.customer
        break;
      }
      default: break;
    }

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}
