import { useEffect, useState } from 'react';
import { getBookkeepingRunProgress } from '../services/bookkeeping/bookkeepingClient.js';
import { acceptProgress, processingProgressView, startProgressPolling } from '../utils/processingProgressView.js';
export default function useProcessingRunProgress(businessId,accountId,enabled=true){
  const [snapshot,setSnapshot]=useState(null);
  const [error,setError]=useState(null);
  useEffect(()=>{
    setSnapshot(null);setError(null);
    if(!enabled||!businessId||!accountId)return undefined;
    let stop,active=false;
    const discover=()=>{
      if(active)return;
      stop?.();active=true;
      stop=startProgressPolling({fetchStatus:options=>getBookkeepingRunProgress(businessId,accountId,options),
        onChange:run=>{
          active=Boolean(run&&!processingProgressView(run).stopped);
          setSnapshot(previous=>({businessId,accountId,run:previous?.businessId===businessId&&previous?.accountId===accountId&&previous?.run?.run_id===run?.run_id?acceptProgress(previous.run,run):run}));
        },onError:setError});
    };
    discover();
    // A user returning to an already mounted tab gets one durable rediscovery, not continuous terminal polling.
    const visible=()=>{if(typeof document==='undefined'||document.visibilityState==='visible')discover();};
    if(typeof window!=='undefined')window.addEventListener('focus',visible);
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',visible);
    return ()=>{stop?.();if(typeof window!=='undefined')window.removeEventListener('focus',visible);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',visible);};
  },[businessId,accountId,enabled]);
  return {run:snapshot?.businessId===businessId&&snapshot?.accountId===accountId?snapshot.run:null,error};
}
