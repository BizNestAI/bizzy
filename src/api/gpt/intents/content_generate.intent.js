export const key = 'content_generate';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(write|draft|caption|email|newsletter|promo)\b/.test(s);
}

export async function recipe({ business_id, supabase, message }) {
  const subtype = /\b(caption|email|newsletter|promo)\b/i.exec(message || '')?.[1]?.toLowerCase() || 'caption';
  const { data: reviews } = await supabase
    .from('reviews')
    .select('id,author,rating,text,created_at')
    .eq('business_id', business_id)
    .order('created_at',{ ascending:false }).limit(5);
  return { subtype, recentReviews: reviews || [] };
}
