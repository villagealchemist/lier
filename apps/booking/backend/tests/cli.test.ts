import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
function workspace(){
  const dir=mkdtempSync(join(tmpdir(),'lier-cli-'));
  const run=(args:string[],extraEnv:Record<string,string>={})=>{
    const env={...process.env,LIER_DB_PATH:join(dir,'test.sqlite'),LIER_POLICY_FILE:'',YOUTUBE_API_KEY:'',LASTFM_API_KEY:'',TICKETMASTER_API_KEY:'',SPOTIFY_ACCESS_TOKEN:'',SOUNDCLOUD_ACCESS_TOKEN:'',...extraEnv};
    const result=spawnSync(process.execPath,[resolve(root,'src/cli.ts'),...args],{cwd:root,env,encoding:'utf8',timeout:5000});
    assert.equal(result.error,undefined);return {status:result.status,data:JSON.parse(result.stdout),stdout:result.stdout,stderr:result.stderr};
  };
  return {dir,run,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('source readiness lists five providers without leaking tokens or creating a DB',()=>{
  const w=workspace();try{const r=w.run(['sources'],{SPOTIFY_ACCESS_TOKEN:'never-print-me'});assert.equal(r.status,0);assert.equal(r.data.sources.length,5);assert.equal(r.data.sources.find(s=>s.source==='spotify').credentialConfigured,true);assert.ok(!r.stdout.includes('never-print-me'));assert.equal(existsSync(join(w.dir,'test.sqlite')),false);}finally{w.close();}
});
test('unknown policy sources fail closed before provider requests',()=>{
  const w=workspace();try{const policy=join(w.dir,'policy.json');writeFileSync(policy,JSON.stringify({spoof:{enabled:true,retentionDays:7}}));const r=w.run(['sources'],{LIER_POLICY_FILE:policy});assert.equal(r.status,1);assert.equal(r.data.error,'unknown_policy_source');}finally{w.close();}
});
test('disabled ingestion persists blocked status, supports inspection and explicit retry',()=>{
  const w=workspace();try{const path=join(w.dir,'request.json');writeFileSync(path,JSON.stringify({requestId:'cli-run',artistId:'cli-artist',source:'youtube',externalId:'UCabcdefghijklmnopqrstuv'}));
    const first=w.run(['ingest',path]);assert.equal(first.status,2);assert.equal(first.data.run.status,'blocked');assert.equal(w.run(['status','cli-run']).data.attempt_count,1);
    assert.equal(w.run(['ingest',path]).data.replayed,true);const retried=w.run(['ingest',path,'--retry']);assert.equal(retried.status,2);assert.equal(retried.data.run.attempt_count,2);assert.equal(w.run(['runs','cli-artist']).data.length,1);
  }finally{w.close();}
});
test('CLI batch processes independent blocked requests with durable run records',()=>{
  const w=workspace();try{const path=join(w.dir,'batch.json');writeFileSync(path,JSON.stringify(['r1','r2'].map(requestId=>({requestId,artistId:'cli-artist',source:'youtube',externalId:'UCabcdefghijklmnopqrstuv'}))));const r=w.run(['batch',path]);assert.equal(r.status,2);assert.equal(r.data.processed,2);assert.equal(w.run(['runs','cli-artist']).data.length,2);}finally{w.close();}
});
test('CLI import is opt-in for synthetic data, query visibility and deletion work end to end',()=>{
  const w=workspace();try{const evidence=JSON.parse(readFileSync(resolve(root,'examples/artist-audience.synthetic.json'),'utf8'));
    evidence.provenance.sourceGeneratedAt='2000-02-01T00:00:00.000Z';evidence.provenance.authorization.retainUntil='2099-01-01T00:00:00.000Z';
    evidence.records.forEach(r=>r.observedPeriod={start:'2000-01-01',end:'2000-01-31'});
    const path=join(w.dir,'evidence.json');writeFileSync(path,JSON.stringify(evidence));
    assert.equal(w.run(['import',path]).status,1);assert.equal(w.run(['import',path,'--allow-synthetic']).status,0);
    assert.equal(w.run(['audience','artist-demo-001']).data.audience.length,0);
    const query=w.run(['evidence','artist-demo-001','--include-synthetic']);assert.equal(query.status,0);assert.equal(query.data.audience.length,2);assert.equal(query.data.observations.length,0);
    assert.equal(w.run(['delete-import',evidence.importId]).status,0);assert.equal(w.run(['audience','artist-demo-001','--include-synthetic']).data.audience.length,0);
  }finally{w.close();}
});
test('unknown commands and unsupported flags cannot silently execute',()=>{
  const w=workspace();try{assert.equal(w.run(['deploy']).data.error,'unknown_command_use_help');assert.equal(w.run(['sources','--enable-everything']).data.error,'invalid_command_arguments');assert.equal(w.run(['help']).data.version,'0.2.0');}finally{w.close();}
});
