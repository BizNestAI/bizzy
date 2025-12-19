// File: /src/api/gpt/middlewares/finalizeContext.js
import buildContext from '../pipeline/contextBuilder.js';

export async function finalizeContext(req, _res, next) {
  const t0 = Date.now();
  try {
    req.bizzy = req.bizzy || {};

    const bundle = req.bizzy.contextBundle || {};
    const user_id =
      req.body?.user_id || req.header('x-user-id') || 'demo-user';
    const business_id =
      req.body?.business_id || req.header('x-business-id') || null;
    const intent  = req.bizzy.intent || req.body?.intent || req.body?.type || 'general';
    const message = req.body?.message || '';
    const hint    = req.body?.context || req.body?.parsedInput || null;

    const ctxFinal = await buildContext({
      user_id,
      business_id,
      intent,
      message,
      hint,
      bundle,
    });

    req.bizzy.contextBundle = ctxFinal; // overwrite with composed+pruned context
    req.bizzy.contextMeta = {
      ...(req.bizzy.contextMeta || {}),
      intent,
      composed: true,
      ms: Date.now() - t0,
      keys: Object.keys(ctxFinal || {}),
    };
  } catch (err) {
    // fail-soft; keep original bundle in place
    req.bizzy.contextMeta = {
      ...(req.bizzy.contextMeta || {}),
      composed: false,
      ms: Date.now() - t0,
      error: process.env.NODE_ENV !== 'production' ? (err?.message || String(err)) : undefined,
    };
  }
  next();
}

export default finalizeContext;
