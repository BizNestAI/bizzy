// File: /src/api/gpt/middlewares/finalize.js
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

export default finalize;
