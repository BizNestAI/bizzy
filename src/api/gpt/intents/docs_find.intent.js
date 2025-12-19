export const key = 'docs_find';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(find|open)\b/.test(s) && /\b(doc|one\-pager|summary)\b/.test(s);
}

export async function recipe({ business_id, supabase, message }) {
  const q = message?.trim() || '';
  const { data: docs } = await supabase
    .from('bizzy_docs')
    .select('id,title,category,tags,created_at')
    .eq('business_id', business_id)
    .ilike('title', `%${q}%`)
    .order('created_at',{ ascending: false })
    .limit(10);
  return { docs: docs || [], query: q };
}
