import { IngestionError, object, list, text } from './domain.ts';
import type { JsonGet } from './http.ts';

const properties = [
  {property:'P434',provider:'musicbrainz',kind:'artist_id',pattern:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i},
  {property:'P1902',provider:'spotify',kind:'artist_id',pattern:/^[A-Za-z0-9]{22}$/},
  {property:'P2397',provider:'youtube',kind:'channel_id',pattern:/^UC[A-Za-z0-9_-]{22}$/},
  {property:'P3040',provider:'soundcloud',kind:'handle',pattern:/^[A-Za-z0-9_-]{1,100}$/}
] as const;

export function parseIdentity(payload:unknown,entityId:string,collectedAt:string) {
  if(!/^Q[1-9]\d*$/.test(entityId))throw new IngestionError('invalid_wikidata_id');
  const body=object(payload),entities=object(body.entities),entity=object(entities[entityId]);
  if(entity.missing!==undefined)throw new IngestionError('identity_not_found');
  if(entity.id!==entityId||entity.type!=='item')throw new IngestionError('identity_mismatch');
  if(!Number.isSafeInteger(entity.lastrevid)||entity.lastrevid<1)throw new IngestionError('invalid_provider_payload');
  const claims=object(entity.claims??{});
  const candidates:{provider:string;kind:string;externalId:string;property:string;statementId:string;referenceCount:number;rank:string;reviewRequired:true}[]=[];
  for(const p of properties){
    for(const raw of list(claims[p.property]??[])){
      const claim=object(raw);
      if(claim.rank==='deprecated')continue;
      if(!['normal','preferred'].includes(claim.rank))throw new IngestionError('invalid_provider_payload');
      const snak=object(claim.mainsnak);
      if(snak.snaktype!=='value')continue;
      const value=object(snak.datavalue).value;
      if(snak.property!==p.property||typeof value!=='string'||!p.pattern.test(value))throw new IngestionError('invalid_identity_claim');
      candidates.push({provider:p.provider,kind:p.kind,externalId:value,property:p.property,statementId:text(claim.id),referenceCount:list(claim.references??[]).length,rank:claim.rank,reviewRequired:true});
    }
  }
  const languageValue=(values:unknown):string|null=>{
    if(values===undefined)return null;const en=object(values).en;return en===undefined?null:text(object(en).value);
  };
  const timestamp=(value:unknown):string=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))throw new IngestionError('invalid_identity_timestamp');
    const normalized=value.includes('.')?value:value.replace('Z','.000Z'),date=new Date(normalized);
    if(!Number.isFinite(date.getTime())||date.toISOString()!==normalized)throw new IngestionError('invalid_identity_timestamp');
    return normalized;
  };
  return {
    source:'wikidata',entityId,sourceUrl:`https://www.wikidata.org/wiki/${entityId}`,revision:entity.lastrevid,
    sourceUpdatedAt:entity.modified===undefined?null:timestamp(entity.modified),collectedAt:timestamp(collectedAt),
    label:languageValue(entity.labels),description:languageValue(entity.descriptions),candidates,
    automaticallyLinked:false,
    warnings:['Community-maintained identity candidates require verification. Conflicting identities are retained for review. SoundCloud handles must be resolved to stable user URNs before ingestion. No follower-count qualifiers are imported.']
  };
}

export async function resolveIdentity(entityId:string,options:{get:JsonGet;now?:()=>Date;userAgent?:string}){
  if(!/^Q[1-9]\d*$/.test(entityId))throw new IngestionError('invalid_wikidata_id');
  const url=new URL(`https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`);
  const payload=await options.get(url,{userAgent:options.userAgent??'FoldTheory/0.2.0 (local artist identity research)'});
  return parseIdentity(payload,entityId,(options.now??(()=>new Date()))().toISOString());
}

export async function searchIdentities(query:string,options:{get:JsonGet;userAgent?:string}){
  if(typeof query!=='string'||query.trim().length<2||query.length>120||/[\x00-\x1f\x7f]/.test(query))throw new IngestionError('invalid_identity_search');
  const url=new URL('https://www.wikidata.org/w/api.php');
  url.search=new URLSearchParams({action:'wbsearchentities',search:query.trim(),language:'en',uselang:'en',type:'item',limit:'10',format:'json',maxlag:'5'}).toString();
  const body=object(await options.get(url,{userAgent:options.userAgent??'FoldTheory/0.2.0 (local artist identity research)'}));
  if(body.error)throw new IngestionError('identity_search_unavailable');
  return {query,candidates:list(body.search).map(item=>{
    const candidate=object(item);if(typeof candidate.id!=='string'||!/^Q[1-9]\d*$/.test(candidate.id))throw new IngestionError('invalid_provider_payload');
    return {entityId:candidate.id,label:text(candidate.label),description:candidate.description===undefined?null:text(candidate.description),reviewRequired:true};
  }),automaticallyLinked:false};
}
