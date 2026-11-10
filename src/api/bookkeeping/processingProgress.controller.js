import { getProcessingRunProgress } from '../../services/bookkeeping/processingRunProgress.js';
export function createProcessingProgressHandler({ getDb = async () => (await import('../../services/supabaseAdmin.js')).supabase } = {}) {
  return async (req,res) => {
    // Only the trusted tenant middleware's resolved context; never body/header fallback.
    const businessId=req.business?.id;
    if(!businessId) return res.status(401).json({ok:false,error:'authentication_required'});
    const accountId=req.query?.account_id;
    const runId=req.query?.run_id;
    if(typeof accountId!=='string'||!accountId||accountId.length>256||(runId!==undefined&&(typeof runId!=='string'||!/^[a-f0-9-]{36}$/i.test(runId)))) return res.status(400).json({ok:false,error:'invalid_progress_scope'});
    res.set('Cache-Control','no-store');res.set('Vary','Authorization, x-business-id, x-bizzi-admin-view');
    try { return res.json(await getProcessingRunProgress({db:await getDb(),businessId,accountId,runId})); }
    catch(error) {return res.status(error.status===404?404:503).json({ok:false,error:error.status===404?'not_found':'processing_progress_unavailable',message:'Processing progress is temporarily unavailable.'});}
  };
}
