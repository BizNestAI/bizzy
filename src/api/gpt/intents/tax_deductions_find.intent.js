export const key = 'tax_deductions_find';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(deductions?|write.?off|can i deduct)\b/.test(s);
}

export async function recipe({ business_id, supabase, message }) {
  const like = (message?.match(/\b(truck|vehicle|tool|compressor|phone|home office)\b/i)?.[0] || '').toLowerCase();
  const { data: cats } = await supabase
    .from('expense_categories')
    .select('category,amount,month')
    .eq('business_id', business_id)
    .order('amount',{ ascending:false }).limit(8);
  return { expenseCategories: cats || [], candidateHint: like || null };
}
