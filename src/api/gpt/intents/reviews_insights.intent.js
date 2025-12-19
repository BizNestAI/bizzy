export const key = 'reviews_insights';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(reviews?|reply|respond)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const { data: revs } = await supabase
    .from('reviews')
    .select('id,author,rating,text,created_at,replied')
    .eq('business_id', business_id)
    .order('created_at',{ ascending:false }).limit(10);
  return { reviews: revs || [] };
}
