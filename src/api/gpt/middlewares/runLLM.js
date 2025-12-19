// File: /src/api/gpt/middlewares/runLLM.js
import { generateBizzyResponse } from '../brain/generateBizzyResponse.js';

export async function runLLM(req, _res, next) {
  const t0 = Date.now();
  try {
    req.bizzy = req.bizzy || {};
    const user_id  = req.bizzy.user_id || req.body?.user_id || req.header('x-user-id') || 'demo-user';
    const message  = req.bizzy.message || req.body?.message || '';
    const intent   = req.bizzy.intent || req.body?.intent || req.body?.type || 'general';

    // Inputs prepared by earlier middlewares
    const parsedInput    = req.bizzy.contextBundle || {};
    const styleMessages  = Array.isArray(req.bizzy?.systemMessages) ? req.bizzy.systemMessages : [];
    const personaMessage = typeof req.bizzy?.personaMessage === 'string' ? req.bizzy.personaMessage : null;

    const result = await generateBizzyResponse({
      user_id,
      message,
      type: intent,
      parsedInput,
      styleMessages,
      personaMessage,
    });

    req.bizzy.llmResult = result;
    req.bizzy.llmMeta = { intent, ms: Date.now() - t0 };
    next();
  } catch (e) {
     
    console.error('[runLLM] failed:', e);
    req.bizzy.llmResult = {
      responseText: 'Something went wrong, but I’m still here. Try again.',
      suggestedActions: [],
      followUpPrompt: '',
      error: 'llm_failed',
    };
    req.bizzy.llmMeta = { intent: req.bizzy?.intent || 'general', ms: Date.now() - t0, error: true };
    next();
  }
}

export default runLLM;
