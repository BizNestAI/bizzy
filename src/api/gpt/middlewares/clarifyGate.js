// File: /src/api/gpt/middlewares/clarifyGate.js
export function clarifyGate(req, res, next) {
  if (req.bizzy?.needsClarify && req.bizzy?.clarify) {
    const { question, options, note } = req.bizzy.clarify;
    return res.json({
      responseText: `**${question}**`,
      suggestedActions: options.map(o => ({ type: 'intent', label: o.label, intent: o.intent })),
      followUpPrompt: '',
      meta: { clarify: { question, options, note } },
    });
  }
  next();
}
export default clarifyGate;
