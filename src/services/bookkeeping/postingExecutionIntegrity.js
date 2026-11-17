// Wrap mutating QBO methods only. Reads retain their original binding. Callback
// and Promise clients are both supported; a rejected guard never calls QBO.
export function guardQboWrites(client,check) {
  const cache=new WeakMap();
  const wrap=target=>{
    if(!target||typeof target!=="object")return target;
    if(cache.has(target))return cache.get(target);
    const proxy=new Proxy(target,{get(object,key){
      const value=Reflect.get(object,key,object);
      if(typeof value!=="function")return value&&typeof value==="object"?wrap(value):value;
      if(!/^(create|update|delete|void|send|batch|upload|attach|post)/i.test(String(key)))return value.bind(object);
      return (...args)=>{
        const callback=typeof args.at(-1)==="function"?args.at(-1):null;
        const operation=Promise.resolve().then(check).then(()=>Reflect.apply(value,object,args));
        if(callback){operation.catch(error=>callback(error));return undefined;}
        return operation;
      };
    }});
    cache.set(target,proxy);return proxy;
  };
  return wrap(client);
}

export function postingLockContext(meta = {}) {
  return {
    generation: meta.posting_generation ?? null,
    cancelled_at: meta.posting_cancelled_at ?? null,
    lock_started_at: meta.posting_started_at ?? null,
    lock_key: meta.post_idempotency_key ?? null,
  };
}

export function postingAttemptEvidence(context, nowMs = Date.now()) {
  const claimedMs = Date.parse(context.claimed_at);
  if (!Number.isFinite(claimedMs)) throw new Error("posting_claim_timestamp_required");
  return {
    // Preserve PostgreSQL's sub-millisecond precision when the claim wins.
    attemptedAt: nowMs > claimedMs ? new Date(nowMs).toISOString() : context.claimed_at,
    payloadSummary: {
      posting_execution_owner: context.owner,
      posting_request_id: context.request_id,
      posting_claimed_at: context.claimed_at,
      posting_generation: context.generation,
    },
  };
}

export async function assertPostingExecutionIntegrity({db,businessId,transactionId,env,context}) {
  const {data,error}=await db.rpc("check_auto_post_technical_integrity",{p_business_id:businessId,p_transaction_id:transactionId,p_env:env,p_context:context});
  if(error||data){const failure=new Error("Posting technical integrity changed");failure.code=error?"technical_recheck_unavailable":data;failure.qbo_write_may_have_occurred=false;throw failure;}
}
