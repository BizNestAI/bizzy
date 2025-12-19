// File: /src/api/chats/chats.routes.js
import { Router } from 'express';
import { supabase } from '../../services/supabaseAdmin.js';
import { generateThreadTitle } from './title.util.js';

const router = Router();

/* ───────────────── helpers ───────────────── */

function readTenant(req) {
  const user_id =
    req.header('x-user-id') ||
    req.query.user_id ||
    req.body?.user_id ||
    null;

  const business_id =
    req.header('x-business-id') ||
    req.query.business_id ||
    req.body?.business_id ||
    null;

  return { user_id, business_id };
}

async function assertMembership(user_id, business_id) {
  if (!user_id || !business_id) return false;
  const { data, error } = await supabase
    .from('user_business_link')
    .select('user_id,business_id')
    .eq('user_id', user_id)
    .eq('business_id', business_id)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

async function tenantGuard(req, res, next) {
  try {
    const { user_id, business_id } = readTenant(req);
    if (!user_id || !business_id) {
      return res.status(400).json({ error: 'missing_user_or_business' });
    }
    const ok = await assertMembership(user_id, business_id);
    if (!ok) return res.status(403).json({ error: 'forbidden' });
    req.tenant = { user_id, business_id };
    next();
  } catch (e) {
    return res.status(500).json({ error: 'tenant_check_failed', details: e.message });
  }
}

function buildThreadQuery({ business_id, archived, q, pinnedOnly }) {
  let query = supabase
    .from('gpt_threads')
    .select(
      'id,title,first_intent,module,pinned,archived,updated_at,created_at,last_message_excerpt,last_message_at',
      { count: 'exact' }
    )
    .eq('business_id', business_id)
    .eq('archived', archived);

  if (pinnedOnly) query = query.eq('pinned', true);
  if (q) query = query.ilike('title', `%${q}%`);

  query = query.order('pinned', { ascending: false }).order('updated_at', { ascending: false });
  return query;
}

/* ───────────────── routes ───────────────── */

router.get('/', tenantGuard, async (req, res) => {
  try {
    const { business_id } = req.tenant;
    const q = (req.query.q || '').toString().trim();
    const limit  = Math.min(Number(req.query.limit  || 50), 200);
    const offset = Math.max (Number(req.query.offset || 0), 0);
    const pinnedOnly = req.query.pinned   === 'true';
    const archived   = req.query.archived === 'true';

    const { data, error, count } = await buildThreadQuery({ business_id, archived, q, pinnedOnly })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    res.json({ threads: data || [], total: count ?? 0, limit, offset });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', details: e.message });
  }
});

router.post('/', tenantGuard, async (req, res) => {
  try {
    const { user_id, business_id } = req.tenant;
    const { title, first_intent, module } = req.body || {};
    const { data, error } = await supabase
      .from('gpt_threads')
      .insert({
        user_id,
        business_id,
        title: (title && String(title).trim()) || 'Untitled',
        first_intent: first_intent || null,
        module: module || 'bizzy',
      })
      .select('id')
      .single();
    if (error) throw error;
    res.json({ id: data.id });
  } catch (e) {
    res.status(500).json({ error: 'create_failed', details: e.message });
  }
});

router.patch('/:id', tenantGuard, async (req, res) => {
  try {
    const { business_id } = req.tenant;
    const id = req.params.id;

    const { data: t, error: tErr } = await supabase
      .from('gpt_threads')
      .select('id,business_id')
      .eq('id', id)
      .single();
    if (tErr) return res.status(404).json({ error: 'not_found' });
    if (t.business_id !== business_id) return res.status(403).json({ error: 'forbidden' });

    const patch = { updated_at: new Date().toISOString() };
    if ('title'    in req.body) patch.title    = String(req.body.title || '').trim() || 'Untitled';
    if ('pinned'   in req.body) patch.pinned   = !!req.body.pinned;
    if ('archived' in req.body) patch.archived = !!req.body.archived;

    const { error } = await supabase.from('gpt_threads').update(patch).eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'patch_failed', details: e.message });
  }
});

router.get('/:id', tenantGuard, async (req, res) => {
  try {
    const { business_id } = req.tenant;
    const id    = req.params.id;
    const limit = Math.min(Number(req.query.limit || 100), 500);

    const { data: thread, error: tErr } = await supabase
      .from('gpt_threads')
      .select('*')
      .eq('id', id)
      .single();
    if (tErr) return res.status(404).json({ error: 'not_found' });
    if (thread.business_id !== business_id) return res.status(403).json({ error: 'forbidden' });

    const { data: msgs, error: mErr } = await supabase
      .from('gpt_messages')
      .select('id,role,content,created_at')
      .eq('thread_id', id)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (mErr) throw mErr;

    res.json({ thread, messages: msgs || [] });
  } catch (e) {
    res.status(500).json({ error: 'get_failed', details: e.message });
  }
});

router.get('/:id/messages', tenantGuard, async (req, res) => {
  try {
    const { business_id } = req.tenant;
    const id    = req.params.id;
    const before = req.query.before ? new Date(req.query.before) : null;
    const after  = req.query.after  ? new Date(req.query.after)  : null;
    const limit  = Math.min(Number(req.query.limit || 50), 200);

    const { data: thread, error: tErr } = await supabase
      .from('gpt_threads')
      .select('id,business_id')
      .eq('id', id)
      .single();
    if (tErr) return res.status(404).json({ error: 'not_found' });
    if (thread.business_id !== business_id) return res.status(403).json({ error: 'forbidden' });

    let q = supabase.from('gpt_messages')
      .select('id,role,content,created_at')
      .eq('thread_id', id);

    if (before) q = q.lt('created_at', before.toISOString());
    if (after)  q = q.gt('created_at', after.toISOString());

    q = q.order('created_at', { ascending: false }).limit(limit);

    const { data, error } = await q;
    if (error) throw error;

    res.json({ messages: data || [] });
  } catch (e) {
    res.status(500).json({ error: 'messages_failed', details: e.message });
  }
});

// Manual re-title (concise)
router.post('/:id/auto-title', tenantGuard, async (req, res) => {
  try {
    const { business_id } = req.tenant;
    const id = req.params.id;

    const { data: thread, error: tErr } = await supabase
      .from('gpt_threads')
      .select('id,business_id,title')
      .eq('id', id)
      .single();
    if (tErr) return res.status(404).json({ error: 'not_found' });
    if (thread.business_id !== business_id) return res.status(403).json({ error: 'forbidden' });

    const { data: msgs } = await supabase
      .from('gpt_messages')
      .select('role,content')
      .eq('thread_id', id)
      .order('created_at', { ascending: true })
      .limit(8);

    const userText = (msgs || []).filter(m => m.role === 'user').map(m => m.content).join('\n').slice(0, 1000);
    const assistantText = (msgs || []).filter(m => m.role === 'assistant').map(m => m.content).join('\n').slice(0, 1000);

    const title = await generateThreadTitle({ userText, assistantText });

    await supabase.from('gpt_threads')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', id);

    res.json({ ok: true, title });
  } catch (e) {
    res.status(500).json({ error: 'auto_title_failed', details: e.message });
  }
});

export default router;
