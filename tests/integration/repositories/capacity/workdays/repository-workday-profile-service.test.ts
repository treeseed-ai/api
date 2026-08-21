import { describe,expect,it } from 'vitest';
import type { CapacityDatabaseOperation,CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { RepositoryWorkdayProfileService,REPOSITORY_WORKDAY_PROFILE_PATH } from '../../../../../src/api/capacity/services/capacity/workdays/policy/repository-workday-profile-service.ts';

type Row=Record<string,unknown>;

const commit='a'.repeat(40);
const profile={
	schemaVersion:'treeseed.workday-allocation-profile/v1',id:'sdk-balanced',version:'1.0.0',projects:['sdk'],
	classes:[
		{classSlug:'engineering',minimumPercent:30,targetPercent:60,maximumPercent:80,mayLend:true,mayBorrow:true},
		{classSlug:'review',minimumPercent:20,targetPercent:40,maximumPercent:70,mayLend:true,mayBorrow:true},
	],
	demandSources:['approved-decisions','planning-inputs'],actingDecisionRequired:true,defaultDurationSeconds:3600,maxConcurrency:2,reservePercent:10,
	prioritization:{strategy:'weighted-fair',starvationLimitSeconds:1800},
};

class FakeDatabase {
	receipts:Row[]=[];
	allocations:Row[]=[];
	classes:Row[]=[
		{id:'class-engineering',team_id:'team-a',project_id:'project-sdk',slug:'engineering',status:'active',handler_refs_json:JSON.stringify({agents:[{slug:'engineer'}]})},
		{id:'class-review',team_id:'team-a',project_id:'project-sdk',slug:'review',status:'active',handler_refs_json:JSON.stringify({agents:[{slug:'reviewer'}]})},
	];
	async ensureInitialized() {}
	async first<T extends Row=Row>(query:string,params:unknown[]=[]):Promise<T|null> {
		if(query.includes('project_remote_repository_bindings')) return {id:'binding-a',team_id:'team-a',project_id:'project-sdk',owner:'treeseed-ai',name:'sdk',publication_ref:'staging'} as T;
		if(query.includes('capacity_operation_receipts')&&query.includes('idempotency_key')) {
			const row=this.receipts.find((entry)=>entry.team_id===params[0]&&entry.operation===params[1]&&entry.idempotency_key===params[2]);
			return row as T??null;
		}
		if(query.includes('capacity_operation_receipts')&&query.includes('resource_id')) {
			const row=[...this.receipts].reverse().find((entry)=>entry.team_id===params[0]&&entry.resource_id===params[1]);
			return row as T??null;
		}
		if(query.includes('MAX(version)')) return {version:this.allocations.length+1} as T;
		return null;
	}
	async all<T extends Row=Row>(query:string):Promise<T[]> {
		if(query.includes('FROM projects')) return [{id:'project-sdk',slug:'sdk'}] as T[];
		if(query.includes('FROM project_agent_classes')) return this.classes as T[];
		return [];
	}
	async batch(operations:CapacityDatabaseOperation[]) {
		for(const operation of operations) {
			if(operation.query.includes('INSERT INTO capacity_allocation_sets')) this.allocations.push({id:operation.params?.[0],version:operation.params?.[2],status:'active',metadata_json:operation.params?.[7]});
			if(operation.query.includes('INSERT INTO capacity_operation_receipts')) this.receipts.push({team_id:operation.params?.[1],operation:operation.params?.[2],idempotency_key:operation.params?.[3],request_digest:operation.params?.[4],resource_type:operation.params?.[5],resource_id:operation.params?.[6],response_json:operation.params?.[7]});
		}
	}
}

function observation(overrides:Record<string,unknown>={}) { return {repository:'treeseed-ai/sdk',ref:'refs/heads/staging',commit,path:REPOSITORY_WORKDAY_PROFILE_PATH,content:JSON.stringify(profile),observedAt:'2026-08-21T09:00:00.000Z',...overrides}; }

describe('repository workday profile indexing',()=>{
	it('indexes one immutable accepted generation and replays the exact observation',async()=>{
		const database=new FakeDatabase();
		const service=new RepositoryWorkdayProfileService(database as unknown as CapacityGovernanceDatabase);
		const first=await service.reconcile(observation());
		expect(first).toMatchObject({schemaVersion:'treeseed.repository-profile-reconciliation/v1',repository:'treeseed-ai/sdk',observedCommit:commit,previousGeneration:null,acceptedGeneration:1,status:'created',generation:{profileId:'sdk-balanced',profileVersion:'1.0.0',generation:1}});
		expect(first.receiptDigest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
		expect(database.allocations).toHaveLength(1);
		expect(await service.reconcile(observation())).toEqual(first);
		expect(database.allocations).toHaveLength(1);
	});

	it('records a new accepted commit with unchanged profile bytes without duplicating allocation state',async()=>{
		const database=new FakeDatabase();
		const service=new RepositoryWorkdayProfileService(database as unknown as CapacityGovernanceDatabase);
		const first=await service.reconcile(observation());
		const second=await service.reconcile(observation({commit:'b'.repeat(40),observedAt:'2026-08-21T09:05:00.000Z'}));
		expect(second).toMatchObject({status:'unchanged',previousGeneration:1,acceptedGeneration:1,allocationSetId:(first as any).allocationSetId,generation:{commit:'b'.repeat(40),generation:1}});
		expect(database.allocations).toHaveLength(1);
	});

	it('creates a superseding allocation generation when normalized profile content changes',async()=>{
		const database=new FakeDatabase();
		const service=new RepositoryWorkdayProfileService(database as unknown as CapacityGovernanceDatabase);
		await service.reconcile(observation());
		const changed={...profile,version:'1.1.0',classes:[{...profile.classes[0],targetPercent:70},{...profile.classes[1],targetPercent:30}]};
		const second=await service.reconcile(observation({commit:'d'.repeat(40),content:JSON.stringify(changed),observedAt:'2026-08-21T09:10:00.000Z'}));
		expect(second).toMatchObject({status:'updated',previousGeneration:1,acceptedGeneration:2,generation:{profileVersion:'1.1.0',generation:2}});
		expect(database.allocations).toHaveLength(2);
	});

	it('rejects a non-publication ref before creating an allocation',async()=>{
		const database=new FakeDatabase();
		await expect(new RepositoryWorkdayProfileService(database as unknown as CapacityGovernanceDatabase).reconcile(observation({ref:'refs/heads/main'}))).rejects.toMatchObject({code:'repository_workday_profile_ref_not_accepted'});
		expect(database.allocations).toHaveLength(0);
	});

	it('rejects an agent appearing in more than one allocation class',async()=>{
		const database=new FakeDatabase();
		database.classes[1]={...database.classes[1],handler_refs_json:JSON.stringify({agents:[{slug:'engineer'}]})};
		await expect(new RepositoryWorkdayProfileService(database as unknown as CapacityGovernanceDatabase).reconcile(observation())).rejects.toMatchObject({code:'repository_workday_profile_invalid',details:{diagnostics:expect.arrayContaining([expect.objectContaining({code:'agent_class_membership_multiple'})])}});
		expect(database.allocations).toHaveLength(0);
	});
});
