import { describe, expect, it } from 'vitest';
import { postgresGraph } from './execution/graph/architecture/living/living-postgres-fixture.ts';
import { upsertCapacityExecutionProviderOperations } from '../../../../src/api/capacity/repositories/capacity/providers/execution-provider.ts';

describe('provider availability reconciliation', () => {
	it('pauses lanes and providers omitted from the authoritative snapshot', () => {
		const operations = upsertCapacityExecutionProviderOperations({
			providerId: 'provider-1', createdAt: '2026-08-23T00:00:00.000Z',
			executionProviders: [{ id: 'codex-local', status: 'active', lanes: [{ id: 'communication', purpose: 'communication' }] }],
		});
		expect(operations[0]?.query).toContain("status = 'unavailable'");
		expect(operations[0]?.params).toContain('codex-local');
		expect(operations[1]?.query).toContain("status = 'paused'");
		expect(operations[1]?.params).toContain('communication');
	});
});

it('native seed provider lane readback follows changed adapter ownership and preserves exact replay on independent connections',async()=>{
 const f=await postgresGraph();
 try{
  const now=new Date().toISOString();
  await f.left.pool.query("INSERT INTO capacity_providers(id,fingerprint,display_name,created_at,updated_at) VALUES('provider','seed-reset-test','Seed reset regression',$1,$1)",[now]);
  const write=async(id:string)=>{
   const operations=upsertCapacityExecutionProviderOperations({providerId:'provider',createdAt:now,executionProviders:[{id,status:'active',capabilities:['source.read'],lanes:[{id:'communication',purpose:'communication',capabilities:['source.read']}]}]});
   await f.left.batch(operations);
  };
  await write('retired-adapter');
  const old=(await f.right.pool.query("SELECT execution_provider_id FROM capacity_provider_lanes WHERE capacity_provider_id='provider' AND id='communication'")).rows;
  expect(old).toEqual([{execution_provider_id:'retired-adapter'}]);
  await write('current-adapter');
  const read=async()=> (await f.right.pool.query("SELECT l.id,l.execution_provider_id,l.status,p.status AS execution_status FROM capacity_provider_lanes l JOIN capacity_execution_providers p ON p.capacity_provider_id=l.capacity_provider_id AND p.id=l.execution_provider_id WHERE l.capacity_provider_id='provider' ORDER BY l.id")).rows;
  const observed=await read();expect(observed).toEqual([{id:'communication',execution_provider_id:'current-adapter',status:'active',execution_status:'active'}]);
  await write('current-adapter');expect(await read()).toEqual(observed);
  expect((await f.right.pool.query("SELECT status FROM capacity_execution_providers WHERE capacity_provider_id='provider' AND id='retired-adapter'")).rows).toEqual([{status:'unavailable'}]);
  expect(await f.snapshot()).toEqual({nodes:[],edges:[],revisions:[],assignments:[],reservations:[]});
 }finally{await f.close();}
});
