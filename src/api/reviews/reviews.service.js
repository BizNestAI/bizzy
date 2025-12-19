import { supabase } from '../../services/supabaseAdmin.js';
import { extractThemesDeterministic } from './gpt/themeExtractor.js';

export async function upsertNormalizedReviews(business_id, source, items = []) {
  if (!items.length) return { inserted: 0 };
  const rows = items.map(it => {
    const themes = extractThemesDeterministic(it.body || '');
    return {
      business_id,
      source,
      source_id: it.source_id || null,
      external_review_id: it.external_review_id,
      rating: it.rating,
      author_name: it.author_name || null,
      body: it.body || '',
      language: it.language || 'en',
      created_at_utc: it.created_at_utc,
      fetched_at: new Date().toISOString(),
      sentiment: it.rating >= 4 ? 'positive' : it.rating === 3 ? 'neutral' : 'negative',
      themes,
      job_id: null,
      owner_replied: !!it.owner_replied,
      reply_text: it.reply_text || null,
      replied_at: it.replied_at || null,
    };
  });

  const { data, error } = await supabase
    .from('reviews')
    .upsert(rows, { onConflict: 'business_id,source,external_review_id' })
    .select('id');
  if (error) throw error;
  return { inserted: data?.length || 0 };
}

export async function listReviews(params) {
  const {
    business_id, source, rating_min, rating_max,
    sentiment, replied, since, until, q, limit, offset,
  } = params;

  let qy = supabase.from('reviews')
    .select('*', { count: 'exact' })
    .eq('business_id', business_id)
    .order('created_at_utc', { ascending: false })
    .range(offset, offset + limit - 1);

  if (source) qy = qy.eq('source', source);
  if (rating_min) qy = qy.gte('rating', rating_min);
  if (rating_max) qy = qy.lte('rating', rating_max);
  if (sentiment) qy = qy.eq('sentiment', sentiment);
  if (typeof replied === 'boolean') qy = qy.eq('owner_replied', replied);
  if (since) qy = qy.gte('created_at_utc', since);
  if (until) qy = qy.lte('created_at_utc', until);
  if (q) qy = qy.ilike('body', `%${q}%`);

  const { data, error, count } = await qy;
  if (error) throw error;
  return { data, count };
}

export async function importCsvBase64({ business_id, csv_base64 }) {
  const text = Buffer.from(csv_base64, 'base64').toString('utf8');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { inserted: 0 };

  const header = lines[0].split(',').map(s => s.trim());
  const idx = (k) => header.indexOf(k);

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < header.length) continue;
    items.push({
      source: cols[idx('source')],
      external_review_id: cols[idx('external_review_id')],
      rating: Number(cols[idx('rating')]),
      author_name: cols[idx('author_name')],
      body: cols[idx('body')],
      created_at_utc: cols[idx('created_at_utc')],
      language: 'en',
    });
  }
  const groups = items.reduce((acc, it) => {
    acc[it.source] = acc[it.source] || [];
    acc[it.source].push(it);
    return acc;
  }, {});
  let inserted = 0;
  for (const [source, arr] of Object.entries(groups)) {
    const res = await upsertNormalizedReviews(business_id, source, arr);
    inserted += res.inserted;
  }
  return { inserted };
}
