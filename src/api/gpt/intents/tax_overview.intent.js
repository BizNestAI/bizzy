export const key = 'tax_overview';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(tax (situation|overview|posture))\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [ytdP, paidP] = await Promise.allSettled([
    supabase.from('financial_metrics').select('ytd_profit').eq('business_id', business_id).maybeSingle(),
    supabase.from('tax_payments').select('period,amount,paid_at').eq('business_id', business_id).order('paid_at',{ ascending:false }).limit(4),
  ]);
  return {
    ytdProfit: ytdP.status === 'fulfilled' ? ytdP.value.data?.ytd_profit ?? null : null,
    estimatesPaid: paidP.status === 'fulfilled' ? paidP.value.data || [] : [],
  };
}
