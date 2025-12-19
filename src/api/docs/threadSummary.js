import express from 'express';
import { body } from 'express-validator';
import { tenantGuard } from '../middleware/tenantGuard.js';
import { supabase } from '../../services/supabaseClient.js';
import { generateThreadSummaryLLM } from '../gpt/brain/generateThreadSummary.js';

const router = express.Router();

router.post('/thread-summary', tenantGuard, [body('thread_id').optional(), body('snippet').optional()], async (req, res) => {
  try {
    const { thread_id, business_name, snippet } = req.body || {};
    let messages = [];
    if (thread_id) {
      const { data, error } = await supabase
        .from('gpt_messages')
        .select('role,content')
        .eq('thread_id', thread_id)
        .order('created_at', { ascending: true })
        .limit(10);
      if (error) throw error;
      messages = data || [];
    }
    const summary = await generateThreadSummaryLLM({ messages, snippet, businessName: business_name });
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: 'summary_failed', message: e.message });
  }
});

export default router;
