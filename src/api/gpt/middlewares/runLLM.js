// File: /src/api/gpt/middlewares/runLLM.js
import { generateBizzyResponse } from '../brain/generateBizzyResponse.js';

export async function runLLM(req, _res, next) {
  const t0 = Date.now();
  try {
    req.bizzy = req.bizzy || {};
    const user_id  = req.auth?.userId || req.user?.id || req.bizzy.user_id || req.body?.user_id || req.header('x-user-id') || 'demo-user';
    const message  = req.bizzy.message || req.body?.message || '';
    const intent   = req.bizzy.intent || req.body?.intent || req.body?.type || 'general';

    // Inputs prepared by earlier middlewares
    const parsedInput    = req.bizzy.contextBundle || {};
    const result = await generateBizzyResponse({
      user_id,
      message,
      type: intent,
      parsedInput,
      business_id: req.business?.id || req.auth?.businessId || req.bizzy.business_id || null,
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
