router.post('/create-portal-session', async (req, res) => {
  try {
    const { user_id } = req.body;
    const { data: cust, error } = await supabase
      .from('billing_customers')
      .select('stripe_customer_id')
      .eq('user_id', user_id)
      .single();
    if (error || !cust) return res.status(400).json({ error: 'No customer' });

    const session = await stripe.billingPortal.sessions.create({
      customer: cust.stripe_customer_id,
      return_url: `${process.env.APP_URL}/settings/billing`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('[billing] portal error', e);
    res.status(500).json({ error: 'Failed to open portal' });
  }
});
