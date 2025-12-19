// /api/insights/mark-read.js (POST {id, userId})
export default async function handler(req, res) {
  const { id, userId } = req.body;
  const { data, error } = await supabase
    .from('insight_reads')
    .upsert({ insight_id: id, user_id: userId }, { onConflict: 'insight_id,user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}