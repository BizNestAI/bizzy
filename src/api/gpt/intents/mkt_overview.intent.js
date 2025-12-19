export const key = 'mkt_overview';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(marketing|campaigns?)\b/.test(s) && /\b(how (did|are)|overview|summary|last (week|month))\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [postsP, emailsP] = await Promise.allSettled([
    supabase.from('post_metrics')
      .select('post_id,title,reach,engagement,created_at')
      .eq('business_id', business_id)
      .order('created_at',{ ascending:false }).limit(5),
    supabase.from('email_metrics')
      .select('subject,open_rate,ctr,sent_at')
      .eq('business_id', business_id)
      .order('sent_at',{ ascending:false }).limit(5),
  ]);
  return {
    posts: postsP.status === 'fulfilled' ? postsP.value.data || [] : [],
    emails: emailsP.status === 'fulfilled' ? emailsP.value.data || [] : [],
  };
}
