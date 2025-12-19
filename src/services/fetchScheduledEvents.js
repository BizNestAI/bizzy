import { supabase } from './supabaseClient';

export async function fetchScheduledEvents(userId, businessId) {
  const allEvents = [];
  try {
    // Posts
    {
      const { data: posts, error } = await supabase
        .from('post_gallery')
        .select('id, caption, platform, status, scheduled_at')
        .eq('user_id', userId)
        .eq('business_id', businessId)
        .eq('status', 'scheduled');
      if (!error) {
        posts?.forEach(p => {
          if (p.scheduled_at) {
            allEvents.push({
              id: `post-${p.id}`,
              title: (p.caption || '').slice(0, 40),
              date: new Date(p.scheduled_at).toISOString().slice(0, 10),
              type: 'marketing',
            });
          }
        });
      }
    }

    // Email campaigns
    {
      const { data: emails, error } = await supabase
        .from('email_campaigns')
        .select('id, subject_line, status, send_date')
        .eq('user_id', userId)
        .eq('business_id', businessId)
        .eq('status', 'scheduled');
      if (!error) {
        emails?.forEach(e => {
          if (e.send_date) {
            allEvents.push({
              id: `email-${e.id}`,
              title: (e.subject_line || '').slice(0, 40),
              date: new Date(e.send_date).toISOString().slice(0, 10),
              type: 'email',
            });
          }
        });
      }
    }

    // Tax deadlines
    {
      const { data: tax } = await supabase
        .from('tax_deadlines')
        .select('id, label, due_date')
        .eq('business_id', businessId);
      tax?.forEach(t => {
        if (t.due_date) {
          allEvents.push({
            id: `tax-${t.id}`,
            title: t.label,
            date: new Date(t.due_date).toISOString().slice(0, 10),
            type: 'tax',
          });
        }
      });
    }

    // Meetings
    {
      const { data: meetings } = await supabase
        .from('meetings')
        .select('id, title, date')
        .eq('business_id', businessId);
      meetings?.forEach(m => {
        if (m.date) {
          allEvents.push({
            id: `meeting-${m.id}`,
            title: m.title,
            date: new Date(m.date).toISOString().slice(0, 10),
            type: 'meeting',
          });
        }
      });
    }

    return { data: allEvents, error: null };
  } catch (err) {
    console.error('[Calendar Fetch] Error loading events:', err);
    return { data: [], error: err };
  }
}
