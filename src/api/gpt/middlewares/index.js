// File: /src/api/gpt/middlewares/index.js
// -----------------------------------------------------------------------------
// Barrel for GPT middlewares used by the router. Order in the router:
// normalizeRequest → attachIntent → attachContext → finalizeContext
// → attachStyle → attachPersona → clarifyGate → runLLM → postProcess → finalize
// -----------------------------------------------------------------------------

// Re-export specialized middlewares (each lives in its own file)
export { attachIntent }     from './attachIntent.js';
export { attachContext }    from './attachContext.js';
export { finalizeContext }  from './finalizeContext.js';
export { attachStyle }      from './attachStyle.js';
export { attachPersona }    from './attachPersona.js';
export { clarifyGate }      from './clarifyGate.js';
export { postProcess }      from './postProcess.js';
export { runLLM }           from './runLLM.js';       // keep ONLY this, do not also define runLLM inline
// NOTE: Do NOT also: export { finalize } from './finalize.js';  // avoid duplicate export

// ───────────────────────────────────────────────────────────────────────────────
// normalizeRequest: parse body/headers and set req.bizzy baseline
// ───────────────────────────────────────────────────────────────────────────────
export function normalizeRequest(req, res, next) {
  try {
    const b = req.body ?? {};
    const user_id     = b.user_id || req.header('x-user-id') || 'demo-user';
    const business_id = b.business_id || req.header('x-business-id') || null;
    const message     = (b.message || '').toString().trim();

    if (!message) return res.status(400).json({ error: 'missing_message' });

    req.bizzy = {
      ...(req.bizzy || {}),
      user_id,
      business_id,
      message,
      // intent is resolved later by attachIntent; allow client to force it
      intent: b.intent || b.type || null,
      // client-provided hints (metric/period/etc.) flow into context finalizer
      context: b.context || b.parsedInput || {},
      opts: b.opts || {},
      startedAt: Date.now(),
    };
    next();
  } catch (e) {
    res.json({ responseText: 'Invalid request.', error: 'bad_request' });
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// finalize: send the final payload, attach helpful meta for observability
// ───────────────────────────────────────────────────────────────────────────────
export function finalize(req, res) {
  try {
    const took_ms = Date.now() - (req.bizzy?.startedAt || Date.now());
    const out =
      req.bizzy?.llmResult ||
      { responseText: 'No response.', suggestedActions: [], followUpPrompt: '' };

    out.meta = {
      ...(out.meta || {}),
      intent: req.bizzy?.intent || 'general',
      depth: req.bizzy?.style?.depth || 'standard',
      style_version: req.bizzy?.style?.version || 'v1',
      took_ms,
    };

    return res.json(out);
  } catch (e) {
     
    console.error('[finalize] error:', e);
    return res.json({
      responseText: 'Something went wrong, but I’m still here. Try again in a moment.',
      suggestedActions: [],
      followUpPrompt: '',
      error: 'finalize_failed',
    });
  }
}
