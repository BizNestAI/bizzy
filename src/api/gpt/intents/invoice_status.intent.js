export const key = 'invoice_status';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(what.?s outstanding|receivables|who owes|ar|aging)\b/.test(s);
}

export async function recipe({ business_id, supabase, message }) {
  const over = /\b(>|\bover\b)\s*(\d{2})\s*days?\b/i.exec(message || '')?.[2] || 30;
  const { data: ar } = await supabase
    .from('ar_aging')
    .select('client,invoice_id,amount,days')
    .eq('business_id', business_id)
    .gte('days', Number(over))
    .order('days',{ ascending:false }).limit(25);
  return { aging: ar || [], thresholdDays: Number(over) };
}
