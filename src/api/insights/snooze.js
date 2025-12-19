// /api/insights/snooze.js (POST {id, until})
export default async function handler(req, res) {
  const { id, until } = req.body;
  const { error } = await supabase
    .from('insights')
    .update({ snoozed_until: until })
    .eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}