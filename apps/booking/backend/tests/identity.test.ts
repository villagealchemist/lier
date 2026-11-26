import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentity, resolveIdentity, searchIdentities } from '../src/identity.ts';
function fixture(){return {entities:{Q123:{id:'Q123',type:'item',lastrevid:99,modified:'2026-11-26T00:00:00Z',labels:{en:{value:'Example artist'}},claims:{P1902:[{id:'Q123$abc',rank:'normal',mainsnak:{snaktype:'value',property:'P1902',datavalue:{value:'abcdefghijklmnopqrstuv'}},qualifiers:{P3744:[{datavalue:{value:999999}}]}}],P3040:[{id:'Q123$sc',rank:'normal',mainsnak:{snaktype:'value',property:'P3040',datavalue:{value:'example-artist'}}}]}}}};}
test('identity discovery preserves provenance and does not convert qualifiers to fresh metrics',()=>{
  const r=parseIdentity(fixture(),'Q123','2026-11-26T01:00:00.000Z');assert.equal(r.revision,99);assert.equal(r.automaticallyLinked,false);assert.equal(r.candidates.length,2);assert.equal(r.candidates[1].kind,'handle');assert.ok(r.candidates.every(c=>c.reviewRequired));assert.ok(!JSON.stringify(r).includes('999999'));
});
test('conflicting nondeprecated identities are retained rather than silently picking one',()=>{
  const f=fixture();const claims=f.entities.Q123.claims.P1902;claims.push({...claims[0],id:'Q123$other',mainsnak:{...claims[0].mainsnak,datavalue:{value:'1234567890123456789012'}}});claims.push({...claims[0],id:'Q123$old',rank:'deprecated'});
  const r=parseIdentity(f,'Q123','2026-11-26T00:00:00.000Z');assert.equal(r.candidates.filter(c=>c.provider==='spotify').length,2);
});
test('malformed identities and wrong response entity fail',()=>{
  const f=fixture();f.entities.Q123.claims.P1902[0].mainsnak.datavalue.value='not-a-spotify-id';assert.throws(()=>parseIdentity(f,'Q123','now'),/invalid_identity_claim/);assert.throws(()=>parseIdentity(f,'../123','now'),/invalid_wikidata_id/);
});
test('resolver uses fixed Wikidata entity URL and a bounded request',async()=>{
  let requested='';const r=await resolveIdentity('Q123',{get:async url=>{requested=url.toString();return fixture();},now:()=>new Date('2026-11-26T00:00:00Z')});assert.equal(requested,'https://www.wikidata.org/wiki/Special:EntityData/Q123.json');assert.equal(r.entityId,'Q123');
});
test('identity timestamps cannot silently misrepresent invalid source dates',()=>{
  const f=fixture();f.entities.Q123.modified='2026-02-30T00:00:00Z';assert.throws(()=>parseIdentity(f,'Q123','2026-11-26T00:00:00.000Z'),/invalid_identity_timestamp/);
});
test('search returns review candidates without automatic matching',async()=>{
  const r=await searchIdentities('example artist',{get:async url=>{assert.equal(url.searchParams.get('maxlag'),'5');return {search:[{id:'Q123',label:'Example artist',description:'Music duo'}]};}});assert.equal(r.candidates[0].reviewRequired,true);assert.equal(r.automaticallyLinked,false);
});
