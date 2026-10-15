import * as transactions from '../../../../../../src/api/capacity/transaction.ts';
import * as assignmentRecords from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import * as settlement from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import {recoveryAssignment} from '../../../providers/assignments/architecture/cancellation-fixture.ts';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
beforeEach(()=>{vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply(store));});
afterEach(()=>vi.restoreAllMocks());
import { terminalizeCapacityWorkdayAssignments } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';
import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';

describe('workday terminalization graph custody', () => {
 it('requires each exact workday terminal observation and rejects missing or conflicting scope before reporting closure',async()=>{
  for(const field of [undefined,null,'id','teamId','runId','projectId','workdayId','assignmentId','eventType','createdAt','context']as const){
   const base=recoveryAssignment(false),original:typeof base={...base,status:'returned',leaseState:'released',leaseToken:null,leaseExpiresAt:null},now='2026-10-02T21:00:04.000Z',held=structuredClone(original);
   const written:typeof base={...original,status:'failed',stateVersion:2,updatedAt:now,lifecycleCode:'workday_terminalized',assignmentAttempt:assignmentRecords.advanceAssignmentAttemptLifecycle(original.assignmentAttempt!,'failed',now)};
   vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply(store));
   vi.spyOn(assignmentRecords.ProviderAssignmentRepository.prototype,'get').mockResolvedValueOnce(original).mockResolvedValueOnce(written);
   vi.spyOn(settlement,'releaseCapacityReservationsExactlyOnce').mockResolvedValue([]);
   const published=vi.spyOn(CapacityWorkdayEventRepository.prototype,'create').mockImplementation(async(teamId,runId,value)=>field===null?null:field===undefined?{...value,teamId,runId,eventIndex:0}:{...value,teamId,runId,eventIndex:0,[field]:field==='context'?{}:'foreign'});
   let scans=0;const database={ensureInitialized:async()=>{},run:vi.fn(async(_sql:string,_params?:unknown[])=>{}),batch:vi.fn(async(_operations:Array<{query:string;params?:unknown[]}>)=>{}),all:vi.fn(async(_sql:string,_params?:unknown[])=>scans++===0?[{id:original.id,membership_id:original.membershipId,reservation_id:original.reservationId,state_version:1,lifecycle_output_json:'{}'}]:[]),first:async(sql:string)=>sql.includes('capacity_usage_actuals')?{active_seconds:0,elapsed_seconds:0}:null};
   try{
    const pending=terminalizeCapacityWorkdayAssignments(database as never,original.teamId,original.workDayId!,{now});
    if(field===undefined)await expect(pending).resolves.toMatchObject({settlementErrorCount:0});else await expect(pending).rejects.toThrow('workday_assignment_observation_conflict');
    expect(published).toHaveBeenCalledOnce();expect(published.mock.calls[0]).toEqual([original.teamId,original.workDayId,{id:'assignment-terminal:'+original.id+':2',projectId:original.projectId,workdayId:original.workDayId,assignmentId:original.id,eventType:'assignment.failed',status:'recorded',title:'Assignment failed',message:null,parameters:{},metadata:{},refs:{},createdAt:now,context:{nodeId:original.assignmentAttempt!.nodeId,nodeRevision:original.assignmentAttempt!.nodeRevision,graphRevision:original.assignmentAttempt!.graphRevision,status:'failed',leaseId:original.assignmentAttempt!.leaseId,reservationId:original.assignmentAttempt!.reservationId,runnerId:written.runnerId,resultId:null}}]);
    expect(database.all.mock.calls[0]![0]).toContain('FOR UPDATE OF assignment');expect(original).toEqual(held);
   }finally{vi.restoreAllMocks();}
  }
 });

	it('retains an orphan active graph node as unfinished even when no assignment row remains', async () => {
		const database: CapacityGovernanceDatabase = {
			ensureInitialized: async () => undefined,
			first: async <T extends Record<string, unknown>>(): Promise<T | null> => null,
			all: async <T extends Record<string, unknown>>(): Promise<T[]> => [],
			run: async () => undefined, batch: async () => undefined,
		};
		vi.spyOn(database, 'first').mockResolvedValue({ total: 1 });
		vi.spyOn(database, 'run'); vi.spyOn(database, 'batch');
		const result = await terminalizeCapacityWorkdayAssignments(database, 'team', 'run', { now: '2026-09-20T00:00:00.000Z' });
		expect(result.unfinishedAssignmentCount).toBe(1);
		expect(database.first).toHaveBeenCalledWith(expect.stringContaining("node.status IN ('assigned','running')"), ['team', 'run']);
		expect(database.run).toHaveBeenCalledTimes(1); expect(database.batch).not.toHaveBeenCalled();
	});
	it('keeps an in-flight lease outside immediate stop terminalization until provider teardown can report', async () => {
		const now = '2026-09-28T09:14:15.670Z';
		const preserveActiveLeasesUntil = '2026-09-28T09:19:15.670Z';
		const database = {
			ensureInitialized: vi.fn(async () => undefined),
			first: vi.fn(async (_sql: string, _params?: unknown[]) => ({ assignment_count: 1, completed_assignments: 0, failed_assignments: 0, unfinished_assignments: 1 })),
			all: vi.fn(async (_sql: string, _params?: unknown[]) => []),
			run: vi.fn(async () => ({})),
		};
		await terminalizeCapacityWorkdayAssignments(database as never, 'team', 'run', { now, preserveActiveLeasesUntil });
		const activeSelection = database.all.mock.calls.find(([sql]) => sql.includes('assignment.status NOT IN'));
		expect(activeSelection).toBeDefined();
		expect(activeSelection?.[0]).toContain("assignment.status = 'leased' AND assignment.lease_state = 'leased'");
		expect(activeSelection?.[1]).toEqual(['team', 'run', preserveActiveLeasesUntil, now, now, MAX_CAPACITY_PAGE_LIMIT]);
		expect(database.run).toHaveBeenCalledWith(expect.stringContaining("status IN ('proposed','blocked','ready')"),
			[now, 'team', 'run']);
	});

	it('cancels unclaimed graph nodes without touching retired demand rows', async () => {
		const run = vi.fn(async (_sql: string, _params?: unknown[]) => ({}));
		const database = {
			ensureInitialized: vi.fn(async () => undefined),
			first: vi.fn(async (_sql: string, _params?: unknown[]) => ({ assignment_count: 0, completed_assignments: 0, failed_assignments: 0, unfinished_assignments: 0 })),
			all: vi.fn(async (_sql: string, _params?: unknown[]) => []), run,
		};
		await terminalizeCapacityWorkdayAssignments(database as never, 'team', 'run', { now: '2026-09-20T00:00:00.000Z' });
		expect(run).toHaveBeenCalledOnce();
		const [sql, params] = run.mock.calls[0]!;
		expect(sql).toContain("UPDATE execution_nodes SET status='cancelled'");
		expect(sql).toContain("status IN ('proposed','blocked','ready')");
		expect(params).toEqual(['2026-09-20T00:00:00.000Z', 'team', 'run']);
		for (const [query] of [...database.first.mock.calls, ...database.all.mock.calls]) {
			expect(query).not.toContain('envelope.id = assignment.work_day_id');
			if (query.includes('capacity_provider_assignments assignment')) expect(query).toContain('run.id = assignment.work_day_id');
		}
	});
});
