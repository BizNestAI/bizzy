// SERVER-ONLY
import { supabase } from '../supabaseAdmin.js';
import { log } from '../../utils/reviews/logger.js';

export async function emitInsights(business_id, insights = []) {
  try {
    if (!business_id || !Array.isArray(insights) || insights.length === 0) return;

    const rows = insights.map(i => ({
      business_id,
      module: i.module || 'marketing',
      type: i.type || 'insight',
      severity: i.severity || 'medium',
      title: i.title,
      body: i.body || '',
      primary_cta: i.primary_cta ?? null,
      secondary_cta: i.secondary_cta ?? null,
      tags: i.tags ?? [],
      created_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from('insights').insert(rows);
    if (error) log.error('[insights] insert failed', error);
  } catch (e) {
    log.error('[insights] emitInsights threw', e);
  }
}
