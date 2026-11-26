import { IngestionError, validateRequest } from './domain.ts';
import { ingest } from './ingest.ts';

export async function ingestBatch(input:unknown,options:Parameters<typeof ingest>[1]){
  if(!Array.isArray(input)||input.length<1||input.length>100)throw new IngestionError('batch_requires_1_to_100_requests');
  const requests=input.map(validateRequest),ids=new Set<string>();
  for(const request of requests){if(ids.has(request.requestId))throw new IngestionError('duplicate_batch_request_id');ids.add(request.requestId);}
  const results:Record<string,unknown>[]=[];
  // Serial requests avoid introducing cross-provider concurrency before quota coordination.
  for(const request of requests){
    try {results.push({requestId:request.requestId,...await ingest(request,options)});}
    catch(error){results.push({requestId:request.requestId,error:error instanceof IngestionError?error.code:'ingestion_failed'});}
  }
  return {processed:results.length,results};
}
