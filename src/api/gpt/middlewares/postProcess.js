// File: /src/api/gpt/middlewares/postProcess.js
import { getIntentModule } from '../registry/intentRegistry.js';
import { supabase } from '../../../services/supabaseAdmin.js';

// Ensure we always return a stable payload shape.
function normalizePayload(payload) {
  // If a module returned a raw string, wrap it.
  if (typeof payload === 'string') {
    return { responseText: payload, suggestedActions: [], followUpPrompt: '', meta: {} };
  }

  const out = {
    responseText:
      typeof payload?.responseText === 'string'
        ? payload.responseText
        : (payload?.reply ?? 'OK'), // legacy alias safeguard
    suggestedActions: Array.isArray(payload?.suggestedActions) ? payload.suggestedActions : [],
    followUpPrompt: payload?.followUpPrompt || '',
    meta: { ...(payload?.meta || {}) },
  };

  // Map common aliases if a module returns them
  if (payload?.chips && Array.isArray(payload.chips)) {
    out.suggestedActions.push(...payload.chips);
  }
  if (payload?.navigateTo) {
    out.suggestedActions.push({ type: 'nav', to: payload.navigateTo, label: 'Open' });
  }
  if (payload?.cta && typeof payload.cta === 'object') {
    out.suggestedActions.push(payload.cta);
  }

  // Merge any extra meta fields
  for (const k of Object.keys(payload || {})) {
    if (!(k in out) && k !== 'chips' && k !== 'navigateTo' && k !== 'cta') {
      // tuck unknown keys under meta to avoid ballooning the prompt later
      out.meta[k] = payload[k];
    }
  }

  return out;
}

export async function postProcess(req, res, next) {
  const t0 = Date.now();
  try {
    const intent = req.bizzy?.intent || 'general';
    const mod = getIntentModule(intent);

    // Pick the source payload:
    //  - middleware flow: req.bizzy.llmResult (set by runLLM)
    //  - handler flow: res.locals.payload (set by a handler before sending)
    const hasReqResult = req.bizzy?.llmResult != null;
    const hasLocalsPayload = res.locals && res.locals.payload != null;
    if (!mod || typeof mod.postProcess !== 'function' || (!hasReqResult && !hasLocalsPayload)) {
      return next();
    }

    const incoming = hasReqResult ? req.bizzy.llmResult : res.locals.payload;

    // Context for the intent's postProcess hook
    const ctx = {
      intent,
      user_id: req.body?.user_id || req.header('x-user-id') || null,
      business_id: req.body?.business_id || req.header('x-business-id') || null,
      bundle: req.bizzy?.contextBundle || {},
      supabase,  // allow side-effects if the intent needs to store something
      req,       // in case the intent needs headers, route, etc.
      res,       // (rarely)
    };

    let transformed = incoming;
    try {
      transformed = await mod.postProcess({ llmResult: incoming, ctx });
    } catch (e) {
      // Module-specific postProcess failed; fail-soft with original payload
      if (process.env.NODE_ENV !== 'production') {
         
        console.warn(`[postProcess] intent "${intent}" postProcess error:`, e?.message || e);
      }
      transformed = incoming;
    }

    const normalized = normalizePayload(transformed);

    // Stash result back for downstream finalize or for the handler to return
    if (hasReqResult) req.bizzy.llmResult = normalized;
    if (hasLocalsPayload) res.locals.payload = normalized;

    // Attach small observability
    req.bizzy = req.bizzy || {};
    req.bizzy.postProcessMeta = {
      intent,
      ms: Date.now() - t0,
      transformed: transformed !== incoming,
    };

    return next();
  } catch (_e) {
    // Fail-soft
    return next();
  }
}

export default postProcess;
