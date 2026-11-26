import { readFileSync, mkdirSync, chmodSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { sources, IngestionError, object } from './domain.ts';
import type { Policies, Source } from './domain.ts';
import { createJsonGet } from './http.ts';
import { providerCollector } from './providers.ts';
import { Store } from './store.ts';
import { ingest } from './ingest.ts';
import { ingestBatch } from './batch.ts';
import { resolveIdentity, searchIdentities } from './identity.ts';
import { importEvidence, queryAudienceEvidence, queryShowOutcomes, purgeExpiredEvidence, deleteEvidenceImport } from './imports.ts';

const [command='help',...argv]=process.argv.slice(2);
const emit=(value:unknown)=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
const readJson=(path:string):unknown=>{if(statSync(path).size>4_000_000)throw new IngestionError('input_file_too_large');return JSON.parse(readFileSync(path,'utf8'));};
const dbPath=resolve(process.env.FOLD_DB_PATH??'data/fold-theory.sqlite');
let store:Store|undefined;
function database(){
  if(!store){mkdirSync(dirname(dbPath),{recursive:true,mode:0o700});store=new Store(dbPath);chmodSync(dbPath,0o600);}
  return store;
}
function argumentsFor(count:number,allowedFlags:string[]=[]){
  const flags=argv.filter(a=>a.startsWith('--')),args=argv.filter(a=>!a.startsWith('--'));
  if(args.length!==count||flags.some(f=>!allowedFlags.includes(f))||new Set(flags).size!==flags.length)throw new IngestionError('invalid_command_arguments');
  return {args,flags:new Set(flags)};
}
function loadPolicies():Policies{
  const policies=Object.fromEntries(sources.map(s=>[s.source,{enabled:false,retentionDays:s.source==='youtube'?30:7}])) as Policies;
  if(!process.env.FOLD_POLICY_FILE)return policies;
  const configured=object(readJson(process.env.FOLD_POLICY_FILE));
  for(const [key,value]of Object.entries(configured)){
    if(!sources.some(s=>s.source===key))throw new IngestionError('unknown_policy_source');
    const policy=object(value);
    if(Object.keys(policy).sort().join(',')!=='enabled,retentionDays'||typeof policy.enabled!=='boolean'||!Number.isInteger(policy.retentionDays)||policy.retentionDays<1||policy.retentionDays>30)throw new IngestionError('invalid_source_policy');
    policies[key as Source]={enabled:policy.enabled,retentionDays:policy.retentionDays};
  }
  return policies;
}
try{
  if(command==='help'||command==='--help'){
    emit({product:'Fold Theory ingestion',version:'0.2.0',commands:{
      sources:'Configured access and last recorded run per provider; never prints credentials.',
      'identity-search "artist name"':'Find review candidates in Wikidata. No automatic identity linking.',
      'identity Q123':'Fetch cross-platform identity candidates for an explicit Wikidata item.',
      'ingest request.json [--retry]':'Ingest one verified artist/provider mapping. Retry terminal failures explicitly.',
      'batch requests.json [--retry]':'Process 1–100 requests serially; isolate independent failures.',
      'status request_id':'Inspect durable ingestion run and lease state.',
      'runs artist_id':'Inspect up to 100 recent runs for an artist.',
      'observations artist_id':'Query unexpired provider observations, events, and profiles.',
      'import evidence.json [--allow-synthetic]':'Import authorized report or organizer outcomes; synthetic examples are opt-in.',
      'audience artist_id [--include-synthetic]':'Read current imported audience evidence.',
      'shows artist_id [--include-synthetic]':'Read current whole-event outcomes involving an artist.',
      'evidence artist_id [--include-synthetic]':'Combine provenance-preserving evidence without creating scores.',
      'delete-import import_id':'Delete an imported document and retain its revision tombstones.',
      purge:'Delete expired provider and imported values.'
    }});
  }else if(command==='identity'||command==='identity-search'){
    const {args}=argumentsFor(1);const options={get:createJsonGet(),userAgent:process.env.FOLD_USER_AGENT};
    emit(command==='identity'?await resolveIdentity(args[0],options):await searchIdentities(args[0],options));
  }else if(command==='sources'){
    argumentsFor(0);const policies=loadPolicies();
    const persisted=existsSync(dbPath)?database():undefined;
    emit({sources:sources.map(s=>{
      const lastRun=persisted?.db.prepare('SELECT request_id,status,collected_at,completed_at,error_code,coverage FROM runs WHERE source=? ORDER BY collected_at DESC,request_id DESC LIMIT 1').get(s.source)??null;
      return {...s,enabled:policies[s.source].enabled,credentialConfigured:Boolean(process.env[s.credentialEnv]),lastRun,verification:lastRun?.status==='succeeded'?'recorded_success_review_coverage':'no_successful_latest_run'};
    }),identityDiscovery:{provider:'wikidata',credentialsRequired:false,automaticLinking:false},notice:'Configured credentials and enabled access are not proof of live coverage.'});
  }else if(command==='ingest'||command==='batch'){
    const {args,flags}=argumentsFor(1,['--retry']);const input=readJson(args[0]);
    const options={store:database(),policies:loadPolicies(),collect:providerCollector(createJsonGet(),process.env),lastFmCommercialApproved:process.env.LASTFM_COMMERCIAL_APPROVED==='true',retryFailed:flags.has('--retry')};
    if(command==='ingest'){const result=await ingest(input,options);emit(result);if(result.run?.status!=='succeeded'||result.leaseLost)process.exitCode=2;}
    else {const result=await ingestBatch(input,options);emit(result);if(result.results.some(r=>(r.run as any)?.status!=='succeeded'||r.leaseLost))process.exitCode=2;}
  }else if(command==='status'||command==='runs'){
    const {args}=argumentsFor(1);const db=database();const result=command==='status'?db.run(args[0]):db.listRuns(args[0]);
    if(!result)throw new IngestionError('run_not_found');emit(result);
  }else if(command==='observations'||command==='evidence'||command==='audience'||command==='shows'){
    const {args,flags}=argumentsFor(1,command==='observations'?[]:['--include-synthetic']);
    const db=database(),now=new Date(),instant=now.toISOString(),filters={artistId:args[0],includeSynthetic:flags.has('--include-synthetic'),now};
    db.purge(instant);purgeExpiredEvidence(db,now);
    const platform=()=>({observations:db.observations(args[0],instant),events:db.events(args[0],instant),profiles:db.profiles(args[0],instant)});
    if(command==='audience')emit({artistId:args[0],audience:queryAudienceEvidence(db,filters)});
    else if(command==='shows')emit({artistId:args[0],shows:queryShowOutcomes(db,filters)});
    else if(command==='observations')emit({artistId:args[0],...platform()});
    else emit({artistId:args[0],...platform(),audience:queryAudienceEvidence(db,filters),shows:queryShowOutcomes(db,filters),notice:'Different platforms and event outcomes remain separate. No unique-audience total, artist-level ticket attribution, ranking, or prediction is inferred.'});
  }else if(command==='import'){
    const {args,flags}=argumentsFor(1,['--allow-synthetic']);emit(importEvidence(readJson(args[0]),{store:database(),allowSynthetic:flags.has('--allow-synthetic')}));
  }else if(command==='delete-import'){
    const {args}=argumentsFor(1);emit(deleteEvidenceImport(database(),args[0]));
  }else if(command==='purge'){
    argumentsFor(0);const db=database(),now=new Date();emit({providerData:db.purge(now.toISOString()),importedEvidence:purgeExpiredEvidence(db,now)});
  }else throw new IngestionError('unknown_command_use_help');
}catch(error){emit({error:error instanceof IngestionError?error.code:'configuration_or_storage_error'});process.exitCode=1;}
finally{store?.close();}
