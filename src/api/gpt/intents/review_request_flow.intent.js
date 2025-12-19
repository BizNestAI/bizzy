export const key = 'review_request_flow';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(ask for reviews|send review requests|request reviews)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [jobsP, contactsP] = await Promise.allSettled([
    supabase.from('jobs')
      .select('id,job_name,completed_at,customer_id')
      .eq('business_id', business_id).order('completed_at',{ ascending:false }).limit(10),
    supabase.from('contacts')
      .select('id,name,email,phone').eq('business_id', business_id).limit(50),
  ]);
  return {
    recentJobs: jobsP.status === 'fulfilled' ? jobsP.value.data || [] : [],
    contacts: contactsP.status === 'fulfilled' ? contactsP.value.data || [] : [],
  };
}
