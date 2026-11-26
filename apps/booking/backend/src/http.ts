import { setTimeout as delay } from 'node:timers/promises';
import { IngestionError } from './domain.ts';
const hosts=new Set(['www.googleapis.com','ws.audioscrobbler.com','app.ticketmaster.com','api.spotify.com','api.soundcloud.com','www.wikidata.org']);
export interface JsonGetOptions { authorization?: string; userAgent?: string }
export type JsonGet = (url: URL, requestOptions?: JsonGetOptions) => Promise<unknown>;
export function createJsonGet(options: {fetcher?: typeof fetch; sleep?: (ms:number)=>Promise<unknown>; now?:()=>number}={}): JsonGet {
  const fetcher=options.fetcher??fetch,sleep=options.sleep??delay,now=options.now??Date.now;
  return async (url,requestOptions={})=>{
    if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.port||url.username||url.password)throw new IngestionError('disallowed_provider_url');
    const headers:Record<string,string>={Accept:'application/json','User-Agent':'FoldTheory-Ingestion/0.2.0'};
    if(requestOptions.userAgent!==undefined){
      if(typeof requestOptions.userAgent!=='string'||!requestOptions.userAgent.trim()||!/^([\x20-\x7e]){3,256}$/.test(requestOptions.userAgent))throw new IngestionError('invalid_user_agent');
      headers['User-Agent']=requestOptions.userAgent;
    }
    if(requestOptions.authorization!==undefined){
      const scheme=url.hostname==='api.spotify.com'?'Bearer':url.hostname==='api.soundcloud.com'?'OAuth':null;
      if(!scheme||typeof requestOptions.authorization!=='string'||!new RegExp(`^${scheme} [A-Za-z0-9._~+\\/=-]+$`).test(requestOptions.authorization))throw new IngestionError('invalid_provider_authorization');
      headers.Authorization=requestOptions.authorization;
    }
    for(let attempt=0;attempt<3;attempt++){
      let response: Response;
      try { response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(10000),headers}); }
      catch { if(attempt<2){await sleep(500*2**attempt);continue;}throw new IngestionError('provider_unreachable'); }
      if(response.status===401||response.status===403){await response.body?.cancel();throw new IngestionError('provider_access_denied');}
      if(response.status===404){await response.body?.cancel();throw new IngestionError('provider_not_found');}
      if(response.status===429||response.status>=500){
        const retry=response.headers.get('retry-after');
        const ms=retry===null?500*2**attempt:/^\d+$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-now());
        const wait=Number.isFinite(ms)?ms:500*2**attempt;
        await response.body?.cancel();
        if(attempt===2||wait>30000)throw new IngestionError(response.status===429?'rate_limited':'provider_unavailable',wait);
        await sleep(wait);continue;
      }
      if(!response.ok){await response.body?.cancel();throw new IngestionError('provider_request_rejected');}
      const length=Number(response.headers.get('content-length')??0);
      if(length>2_000_000){await response.body?.cancel();throw new IngestionError('provider_payload_too_large');}
      if(!response.body)throw new IngestionError('invalid_provider_payload');
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      try{
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000){await reader.cancel();throw new IngestionError('provider_payload_too_large');}chunks.push(value);}
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }catch(error){if(error instanceof IngestionError)throw error;throw new IngestionError('invalid_provider_payload');}
    }
    throw new IngestionError('provider_unavailable');
  };
}
