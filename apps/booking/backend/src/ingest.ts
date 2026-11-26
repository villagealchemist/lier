import { IngestionError, validateRequest } from './domain.ts';
import type { IngestRequest, Snapshot, Policies } from './domain.ts';
import type { Store } from './store.ts';
export interface IngestOptions {
  store:Store;
  policies:Policies;
  collect:(r:IngestRequest)=>Promise<Snapshot>;
  now?:()=>Date;
  lastFmCommercialApproved?:boolean;
  leaseDurationMs?:number;
  retryFailed?:boolean;
}
export async function ingest(input:unknown,options:IngestOptions){
  const request=validateRequest(input),clock=options.now??(()=>new Date()),now=clock();
  const policy=options.policies[request.source];
  if(!policy||typeof policy.enabled!=='boolean'||!Number.isInteger(policy.retentionDays)||policy.retentionDays<1||policy.retentionDays>30)throw new IngestionError('invalid_source_policy');
  const expires=new Date(now.getTime()+policy.retentionDays*86400000).toISOString();
  options.store.purge(now.toISOString());
  const claim=options.store.begin(request,now.toISOString(),expires,{leaseDurationMs:options.leaseDurationMs,retryFailed:options.retryFailed});
  if(!claim.claimed)return {replayed:true,leaseLost:false,run:options.store.run(request.requestId)};
  let leaseLost=false;
  try {
    if(!policy.enabled)throw new IngestionError('source_disabled');
    if(request.source==='lastfm'&&!options.lastFmCommercialApproved)throw new IngestionError('commercial_access_not_confirmed');
    const snapshot=await options.collect(request);
    options.store.finish(request,snapshot,clock().toISOString(),claim.leaseToken);
  } catch(error) {
    const safe=error instanceof IngestionError?error:new IngestionError('ingestion_failed');
    if(safe.code==='lease_lost')leaseLost=true;
    else leaseLost=!options.store.fail(request.requestId,safe.code,clock().toISOString(),safe.retryAfterMs,claim.leaseToken);
  }
  return {replayed:false,leaseLost,run:options.store.run(request.requestId)};
}
