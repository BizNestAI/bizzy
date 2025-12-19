import bodyParser from 'body-parser';

router.post('/webhook',
  bodyParser.raw({ type: 'application/json' }), // raw for Stripe signature
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[stripe] bad signature', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          // Subscription created; you can fetch the sub
          const session = event.data.object;
          // session.customer, session.subscription, metadata from sub
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
                price_id: sub.items.data[0]?.price?.id || null,
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
          const business_id = inv.lines.data?.[0]?.subscription_details?.metadata?.business_id
            || inv.metadata?.business_id; // depending on your setup
          if (business_id) {
            await supabase.from('invoices').insert({
              stripe_invoice_id: inv.id,
              business_id,
              amount_due: inv.amount_due,
              amount_paid: inv.amount_paid,
              status: inv.status,
              hosted_invoice_url: inv.hosted_invoice_url
            });
          }
          break;
        }
        case 'invoice.payment_failed': {
          // Notify user / mark dunning banner in app
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.error('[stripe] webhook handling error', e);
      return res.status(500).send('Webhook handler failed');
    }

    res.json({ received: true });
  }
);
