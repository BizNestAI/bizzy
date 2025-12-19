// File: /src/api/gpt/pipeline/contextBuilder.js
import { supabase } from '../../../services/supabaseAdmin.js';

const MAX_ARRAY  = 100;
const MAX_STRING = 8000;

/** Defensive string/array/object pruning so the LLM context stays bounded */
function prune(value) {
  const seen = new WeakSet();
  function _prune(v) {
    if (!v || typeof v !== 'object') {
      if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
      return v;
    }
    if (seen.has(v)) return v;
    seen.add(v);

    if (Array.isArray(v)) {
      const arr = v.length > MAX_ARRAY ? v.slice(0, MAX_ARRAY) : v;
      return arr.map(_prune);
    }

    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string') out[k] = val.length > MAX_STRING ? val.slice(0, MAX_STRING) : val;
      else if (Array.isArray(val)) out[k] = (val.length > MAX_ARRAY ? val.slice(0, MAX_ARRAY) : val).map(_prune);
      else if (val && typeof val === 'object') out[k] = _prune(val);
      else out[k] = val;
    }
    return out;
  }
  return _prune(value);
}

/** Map stored roles → OpenAI-safe roles */
function sanitizeRole(r) {
  const v = String(r || '').toLowerCase();
  if (v === 'bizzy') return 'assistant';
  if (v === 'assistant' || v === 'user' || v === 'system' || v === 'developer') return v;
  return 'assistant';
}

/**
 * Read last N messages from gpt_messages.
 * Prefers a specific thread when threadId is present; otherwise falls back to the
 * latest messages for this user & business. This ensures the LLM sees a short
 * conversational window without dragging in unrelated memory/doc tables.
 */
async function readRecentChat({ user_id, business_id, threadId = null, limit = 6, _supabase = supabase }) {
  try {
    let q = _supabase
      .from('gpt_messages')
      .select('role,content,created_at');

    if (threadId) {
      q = q.eq('thread_id', threadId);
    } else {
      q = q.eq('user_id', user_id);
      if (business_id) q = q.eq('business_id', business_id);
    }

    const { data, error } = await q
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    // Return oldest→newest to read naturally in prompts
    const chronological = (data || []).slice().reverse();
    return chronological
      .map((m) => ({
        role   : sanitizeRole(m.role),
        content: String(m.content || '').slice(0, MAX_STRING),
      }))
      .filter((m) => !!m.content);
  } catch (_e) {
    // Fail-soft: no recent chat
    return [];
  }
}

export async function buildContext({
  user_id,
  business_id,
  intent,
  message,
  hint,
  bundle = {},
  _supabase = supabase,
}) {
  const out = { user_id, business_id, intent };

  // Prefer thread-scoped context if available from hint or bundle
  const threadId =
    hint?.threadId ??
    bundle?.threadId ??
    bundle?.email?.threadId ??
    null;

  // Always-light recent chat (from gpt_messages only)
  out.recentChat = await readRecentChat({
    user_id,
    business_id,
    threadId,
    limit: 6,
    _supabase,
  });

  // Intent-scoped lightweight hints (no heavy joins here)
  switch (intent) {
    // ===== Email (existing & new) =====
    case 'email_summarize':
    case 'email_reply':
    case 'email_template': {
      out.emailHint = {
        message  : message || '',
        threadId : hint?.threadId || bundle?.email?.threadId || null,
        accountId: hint?.accountId || bundle?.email?.accountId || null,
      };
      break;
    }
    case 'email_search': {
      out.emailHint = {
        message    : message || '',
        searchQuery: hint?.searchQuery || (message || ''),
        accountId  : hint?.accountId || null,
        fromEmail  : hint?.fromEmail  || null,
        toEmail    : hint?.toEmail    || null,
      };
      break;
    }
    case 'email_extract_tasks': {
      out.emailHint = {
        message  : message || '',
        threadId : hint?.threadId || bundle?.email?.threadId || null,
        accountId: hint?.accountId || bundle?.email?.accountId || null,
      };
      break;
    }
    case 'email_followup': {
      out.emailHint = {
        message     : message || '',
        threadId    : hint?.threadId || bundle?.email?.threadId || null,
        accountId   : hint?.accountId || bundle?.email?.accountId || null,
        followupDelay: hint?.followupDelay || null,
      };
      break;
    }
    case 'email_find_contact': {
      out.emailHint = {
        message    : message || '',
        accountId  : hint?.accountId  || null,
        fromEmail  : hint?.fromEmail  || null,
        contactName: hint?.contactName|| null,
      };
      break;
    }

    // ===== Other modules =====
    case 'calendar_schedule': {
      out.scheduleHint = message || '';
      break;
    }
    case 'affordability_check': {
      out.affordHint = hint || {};
      break;
    }
    case 'fin_variance_explain':
    case 'metric_explain': {
      if (hint?.metric) out.metricHint = hint.metric;
      if (hint?.period) out.periodHint = hint.period;
      break;
    }
    default:
      break;
  }

  // Merge caller-provided bundle without losing our safe base
  const merged = { ...out, ...(bundle || {}) };
  return prune(merged);
}

export default buildContext;
