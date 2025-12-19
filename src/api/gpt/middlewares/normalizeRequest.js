// File: /src/api/gpt/middlewares/normalizeRequest.js
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
      intent: b.intent || b.type || null,           // client-forced intent allowed
      context: b.context || b.parsedInput || {},    // client hints flow into finalizeContext
      opts: b.opts || {},
      startedAt: Date.now(),
    };
    next();
  } catch (e) {
    res.json({ responseText: 'Invalid request.', error: 'bad_request' });
  }
}

export default normalizeRequest;
