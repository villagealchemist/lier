import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.ts';
import { importEvidence, queryAudienceEvidence, queryShowOutcomes, purgeExpiredEvidence, deleteEvidenceImport, validateEvidenceImport } from '../src/imports.ts';
const now=()=>new Date('2026-11-26T07:00:00.000Z');
const audience=()=>({schemaVersion:1,importId:'audience-report-1',kind:'artist_audience',synthetic:false,provenance:{provider:'artist_report',sourceAccountId:'artist-team-1',documentReference:'report-2026-11',sourceGeneratedAt:'2026-11-25T12:00:00.000Z',authorization:{declared:true,basis:'artist_authorized_export',reference:'consent-1',declaredBy:'operator-1',retainUntil:'2026-12-26T07:00:00.000Z'}},records:[{recordId:'row-1',artistId:'artist-1',platform:'spotify',metric:'listeners',value:0,availability:'reported',precision:'reported',observedPeriod:{start:'2026-10-27',end:'2026-11-25'},geography:{city:'Philadelphia',region:'PA',countryCode:'US'}}]});
const show=()=>({schemaVersion:1,importId:'settlement-1',kind:'show_outcomes',synthetic:false,provenance:{provider:'organizer_export',sourceAccountId:'organizer-1',documentReference:'settlement-2026-11-14',sourceGeneratedAt:'2026-11-25T12:00:00.000Z',authorization:{declared:true,basis:'organizer_owned_export',reference:'organizer-records-1',declaredBy:'operator-1',retainUntil:'2027-11-26T07:00:00.000Z'}},records:[{recordId:'event-row-1',eventId:'event-42',eventDate:'2026-11-14',venue:{name:'Example Venue',geography:{city:'Philadelphia',region:'PA',countryCode:'US'}},lineupArtistIds:['artist-2','artist-1'],paidAttendance:381,refundedTickets:8,complimentaryAttendance:19,sellableCapacity:500,netTicketRevenueMinor:1023425,currency:'USD'}]});
test('audience imports preserve platform, period, geography, zero and provenance',()=>{
  const store=new Store(':memory:');try{
    const result=importEvidence(audience(),{store,now});assert.equal(result.recordCount,1);
    const rows=queryAudienceEvidence(store,{artistId:'artist-1',now:now()});assert.equal(rows.length,1);assert.equal(rows[0].record.value,0);assert.equal(rows[0].record.platform,'spotify');assert.equal(rows[0].record.geography.city,'Philadelphia');assert.equal(rows[0].provenance.documentReference,'report-2026-11');assert.equal(rows[0].verification,'self_declared_not_independently_verified');assert.equal(rows[0].scoringAllowed,false);
    assert.equal(store.observations('artist-1',now().toISOString()).length,0);
  }finally{store.close();}
});
test('unknown and suppressed values stay null; contradictions are rejected',()=>{
  const input=audience() as any;input.records[0].value=null;input.records[0].availability='suppressed';assert.equal((validateEvidenceImport(input).records[0] as any).value,null);
  input.records[0].value=0;assert.throws(()=>validateEvidenceImport(input),/contradictory_audience_availability/);
  input.records[0].availability='reported';input.records[0].value=null;assert.throws(()=>validateEvidenceImport(input),/contradictory_audience_availability/);
});
test('imports are idempotent across JSON field and row ordering, conflicts fail',()=>{
  const store=new Store(':memory:');try{
    const input=audience();input.records.push({...input.records[0],recordId:'row-2',artistId:'artist-2',value:5});importEvidence(input,{store,now});
    const reordered=Object.fromEntries(Object.entries(input).reverse());reordered.records=[...input.records].reverse();assert.equal(importEvidence(reordered,{store,now}).replayed,true);
    const conflict=structuredClone(input);conflict.records[0].value=123;assert.throws(()=>importEvidence(conflict,{store,now}),/import_idempotency_conflict/);assert.equal(queryAudienceEvidence(store,{now:now()}).length,2);
  }finally{store.close();}
});
test('duplicate factual rows fail even with different row IDs',()=>{
  const input=audience();input.records.push({...input.records[0],recordId:'different-row'});assert.throws(()=>validateEvidenceImport(input),/duplicate_import_record/);
  const events=show();events.records.push({...events.records[0],recordId:'different-event-row'});assert.throws(()=>validateEvidenceImport(events),/duplicate_import_record/);
});
test('strict input rejects undeclared authorization, unknown fields and attendee PII payloads',()=>{
  for(const mutate of [(x:any)=>{x.provenance.authorization.declared=false;},(x:any)=>{x.records[0].attendees=[{email:'person@example.test'}];},(x:any)=>{x.operatorSecret='secret';}]){const input=show();mutate(input);assert.throws(()=>validateEvidenceImport(input));}
  const input=audience();input.provenance.authorization.basis='organizer_owned_export';assert.throws(()=>validateEvidenceImport(input),/incompatible_authorization_basis/);
});
test('invalid dates, periods, geographies and fractional counts are rejected',()=>{
  for(const mutate of [(x:any)=>{x.records[0].observedPeriod.end='2026-02-30';},(x:any)=>{x.records[0].observedPeriod.end='2026-01-01';},(x:any)=>{x.records[0].geography.countryCode='ZZ';},(x:any)=>{x.records[0].value=1.5;},(x:any)=>{x.records[0].value='100';},(x:any)=>{x.records[0].metric=['listeners'];},(x:any)=>{x.provenance.authorization.basis=['artist_authorized_export'];}]){const input=audience();mutate(input);assert.throws(()=>validateEvidenceImport(input));}
});
test('synthetic templates require opt-in and are excluded from ordinary queries',()=>{
  const store=new Store(':memory:');try{
    const input=audience();input.synthetic=true;assert.throws(()=>importEvidence(input,{store,now}),/synthetic_import_requires_explicit_opt_in/);importEvidence(input,{store,now,allowSynthetic:true});assert.equal(queryAudienceEvidence(store,{now:now()}).length,0);assert.equal(queryAudienceEvidence(store,{now:now(),includeSynthetic:true})[0].synthetic,true);
  }finally{store.close();}
});
test('event outcomes preserve minor units and entire lineup without artist attribution',()=>{
  const store=new Store(':memory:');try{
    importEvidence(show(),{store,now});for(const artistId of ['artist-1','artist-2']){const r=queryShowOutcomes(store,{artistId,now:now()})[0];assert.equal(r.record.netTicketRevenueMinor,1023425);assert.deepEqual(r.record.lineupArtistIds,['artist-1','artist-2']);assert.equal(r.attribution,'whole_event_not_individual_artist');assert.equal(r.record.paidAttendance,381);assert.equal(r.record.refundedTickets,8);}
    assert.equal(queryShowOutcomes(store,{artistId:'unrelated',now:now()}).length,0);
  }finally{store.close();}
});
test('currency and integer minor units are required while negative net settlements are preserved',()=>{
  const input=show();input.records[0].netTicketRevenueMinor=-500;assert.equal((validateEvidenceImport(input).records[0] as any).netTicketRevenueMinor,-500);
  input.records[0].netTicketRevenueMinor=5.5;assert.throws(()=>validateEvidenceImport(input),/invalid_import_number/);input.records[0].netTicketRevenueMinor=0;input.records[0].currency='ZZZ';assert.throws(()=>validateEvidenceImport(input),/invalid_currency/);
});
test('query correction view replaces an earlier event revision without double counting',()=>{
  const store=new Store(':memory:');try{
    const first=show();importEvidence(first,{store,now});const correction=show();correction.importId='settlement-correction';correction.records[0].paidAttendance=390;
    importEvidence(correction,{store,now:()=>new Date('2026-11-26T08:00:00.000Z')});const rows=queryShowOutcomes(store,{now:new Date('2026-11-26T09:00:00.000Z')});assert.equal(rows.length,1);assert.equal(rows[0].record.paidAttendance,390);assert.equal(rows[0].importId,'settlement-correction');
  }finally{store.close();}
});
test('provider account namespaces prevent unrelated event IDs from replacing one another',()=>{
  const store=new Store(':memory:');try{
    importEvidence(show(),{store,now});const other=show();other.importId='other-organizer';other.provenance.sourceAccountId='organizer-2';importEvidence(other,{store,now});assert.equal(queryShowOutcomes(store,{now:now()}).length,2);
  }finally{store.close();}
});
test('late imports of older source reports cannot overwrite newer evidence',()=>{
  const store=new Store(':memory:');try{
    const latest=show();latest.provenance.sourceGeneratedAt='2026-11-26T06:00:00.000Z';importEvidence(latest,{store,now});
    const older=show();older.importId='late-old-report';older.records[0].paidAttendance=1;importEvidence(older,{store,now:()=>new Date('2026-11-26T08:00:00.000Z')});
    assert.equal(queryShowOutcomes(store,{now:new Date('2026-11-26T09:00:00.000Z')})[0].record.paidAttendance,381);
  }finally{store.close();}
});
test('unknown source time cannot be ordered against known or other unknown revision time',()=>{
  for(const dates of [
    ['2026-11-25T12:00:00.000Z',null],
    [null,'2026-11-26T06:00:00.000Z'],
    [null,null]
  ]){
    const store=new Store(':memory:');try{
      const first=show() as any;first.provenance.sourceGeneratedAt=dates[0];importEvidence(first,{store,now});assert.equal(importEvidence(first,{store,now}).replayed,true);
      const second=show() as any;second.importId='ambiguous-revision';second.provenance.sourceGeneratedAt=dates[1];second.records[0].paidAttendance=999;
      assert.throws(()=>importEvidence(second,{store,now:()=>new Date('2026-11-26T08:00:00.000Z')}),/ambiguous_source_time_revision/);
      const rows=queryShowOutcomes(store,{now:new Date('2026-11-26T09:00:00.000Z')});assert.equal(rows.length,1);assert.equal(rows[0].record.paidAttendance,381);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM evidence_imports WHERE import_id='ambiguous-revision'").get()?.n,0);
    }finally{store.close();}
  }
});
test('source generation UTC date cannot precede audience period end or event date',()=>{
  const report=audience();report.provenance.sourceGeneratedAt='2026-11-24T23:59:59.999Z';assert.throws(()=>validateEvidenceImport(report),/source_generation_precedes_observation/);
  report.provenance.sourceGeneratedAt='2026-11-25T00:00:00.000Z';assert.doesNotThrow(()=>validateEvidenceImport(report));
  const outcome=show();outcome.provenance.sourceGeneratedAt='2026-11-13T23:59:59.999Z';assert.throws(()=>validateEvidenceImport(outcome),/source_generation_precedes_observation/);
  outcome.provenance.sourceGeneratedAt='2026-11-14T00:00:00.000Z';assert.doesNotThrow(()=>validateEvidenceImport(outcome));
});
test('expiry or deletion of a correction never resurrects the older event revision',()=>{
  const store=new Store(':memory:');try{
    importEvidence(show(),{store,now});const correction=show();correction.importId='short-retained-correction';correction.provenance.authorization.retainUntil='2026-11-27T00:00:00.000Z';
    importEvidence(correction,{store,now:()=>new Date('2026-11-26T08:00:00.000Z')});const expired=new Date('2026-11-28T00:00:00.000Z');assert.equal(queryShowOutcomes(store,{now:expired}).length,0);purgeExpiredEvidence(store,expired);assert.equal(queryShowOutcomes(store,{now:expired}).length,0);
    const replacement=show();replacement.importId='replacement';replacement.provenance.sourceGeneratedAt='2026-11-26T06:00:00.000Z';importEvidence(replacement,{store,now});assert.equal(queryShowOutcomes(store,{now:now()}).length,1);deleteEvidenceImport(store,'replacement');assert.equal(queryShowOutcomes(store,{now:now()}).length,0);
  }finally{store.close();}
});
test('expired authorization, future outcomes and future source timestamps cannot be imported',()=>{
  const store=new Store(':memory:');try{
    for(const mutate of [(x:any)=>{x.provenance.authorization.retainUntil=now().toISOString();},(x:any)=>{x.records[0].eventDate='2026-12-01';},(x:any)=>{x.provenance.sourceGeneratedAt='2026-12-01T00:00:00.000Z';}]){const input=show();mutate(input);assert.throws(()=>importEvidence(input,{store,now}));}
  }finally{store.close();}
});
test('expiry hides and purges records and a scoped deletion cascades lineup records',()=>{
  const store=new Store(':memory:');try{
    importEvidence(audience(),{store,now});assert.equal(queryAudienceEvidence(store,{now:new Date('2026-12-26T07:00:00.000Z')}).length,0);assert.deepEqual(purgeExpiredEvidence(store,new Date('2026-12-26T07:00:00.000Z')),{importsDeleted:1});
    importEvidence(show(),{store,now});assert.deepEqual(deleteEvidenceImport(store,'settlement-1'),{importsDeleted:1});assert.equal(queryShowOutcomes(store,{now:now(),includeSynthetic:true}).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM evidence_lineup').get()?.n,0);
  }finally{store.close();}
});
test('invalid records reject the entire import before any records persist',()=>{
  const store=new Store(':memory:');try{
    const input=audience();input.records.push({...input.records[0],recordId:'bad',artistId:'artist-2',value:-1});assert.throws(()=>importEvidence(input,{store,now}));assert.equal(queryAudienceEvidence(store,{now:now()}).length,0);
  }finally{store.close();}
});
test('shipped examples validate and remain synthetic, with no implicit import',()=>{
  const store=new Store(':memory:');try{
    for(const filename of ['artist-audience.synthetic.json','show-outcomes.synthetic.json']){
      const example=JSON.parse(readFileSync(new URL(`../examples/${filename}`,import.meta.url),'utf8'));
      assert.equal(validateEvidenceImport(example).synthetic,true);assert.throws(()=>importEvidence(example,{store,now}),/synthetic_import_requires_explicit_opt_in/);
      importEvidence(example,{store,now,allowSynthetic:true});
    }
    assert.equal(queryAudienceEvidence(store,{now:now()}).length,0);assert.equal(queryShowOutcomes(store,{now:now()}).length,0);
  }finally{store.close();}
});
