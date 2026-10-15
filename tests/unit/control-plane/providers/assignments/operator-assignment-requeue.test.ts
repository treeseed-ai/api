import * as transactions from '../../../../../src/api/capacity/transaction.ts';
import {CapacityWorkdayEventRepository} from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import {recoveryAssignment} from './architecture/cancellation-fixture.ts';
import {afterEach,describe,expect,it,vi} from 'vitest';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';

const { getAssignment } = vi.hoisted(() => ({ getAssignment: vi.fn() }));

vi.mock('../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts', async importOriginal => ({
 ...await importOriginal<typeof import('../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts')>(),
	ProviderAssignmentRepository: class {
		get = getAssignment;
	},
}));

import { OperatorAssignmentService } from '../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';

describe('operator assignment requeue', () => {
	it('reopens a returned graph node without requiring its reusable reservation to be settled', async () => {
  vi.useFakeTimers({toFake:['Date']});const now='2026-10-02T21:00:04.000Z';vi.setSystemTime(new Date(now));
  const assignment={...recoveryAssignment(false),status:'returned',leaseState:'released',stateVersion:4,metadata:{retained:true}},written={...assignment,stateVersion:5,updatedAt:now,metadata:{...assignment.metadata,operatorRetry:{requestedAt:now,requestedBy:null,reason:null}}};
  getAssignment.mockReset().mockResolvedValueOnce(assignment).mockResolvedValueOnce(assignment).mockResolvedValueOnce(written);
  vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply(store));
  const observation=vi.spyOn(CapacityWorkdayEventRepository.prototype,'create').mockImplementation(async(teamId,runId,value)=>({...value,teamId,runId,eventIndex:0}));
		const unexpected = async () => { throw new Error('Unexpected requeue database operation'); };
        let reopened=false;
        const all=vi.fn(async(sql:string,params:unknown[])=>{
         if(sql.startsWith('SELECT from_node_id,to_node_id'))return[];
         if(!sql.startsWith('SELECT id,team_id AS "teamId"')||JSON.stringify(params)!==JSON.stringify([assignment.workDayId,assignment.teamId,assignment.executionNodeId]))throw new Error('Unexpected unit retry node read');
         return [{id:assignment.executionNodeId,teamId:assignment.teamId,projectId:assignment.projectId,workdayId:assignment.workDayId,status:reopened?'ready':'failed',nodeRevision:reopened?2:1,graphRevisionUpdated:assignment.graphRevision}];
        });
		const database = {
			ensureInitialized: vi.fn(),
			first: vi.fn(async()=>{reopened=true;return{node_revision:2,status:'ready'};}),
			run: vi.fn(async()=>{}), all, batch: unexpected,
		} satisfies CapacityGovernanceDatabase;

		const result = await new OperatorAssignmentService(database).requeue(assignment.teamId, assignment.id, {
			idempotencyKey: 'retry-1',
		});

		expect(result).toMatchObject({ demand: null, alreadyLeasable: false });
  expect(result.assignment).toEqual(written);expect(database.run).toHaveBeenCalledOnce();expect(observation.mock.calls.filter(([, , value])=>value.eventType==='assignment.retry-requested')).toHaveLength(1);expect(observation.mock.calls.filter(([, , value])=>value.eventType==='execution.node.state')).toHaveLength(1);expect(observation.mock.calls[1]![2].context).toEqual({nodeId:assignment.executionNodeId,nodeRevision:2,graphRevision:assignment.graphRevision,status:'ready',previousStatus:'failed'});expect(observation.mock.calls[0]).toEqual([assignment.teamId,assignment.workDayId,{id:'assignment-retry:'+assignment.id+':5',projectId:assignment.projectId,workdayId:assignment.workDayId,assignmentId:assignment.id,eventType:'assignment.retry-requested',status:'recorded',title:'Assignment retry requested',message:null,parameters:{idempotencyKey:'retry-1',actorId:null,reason:null},metadata:{},refs:{},createdAt:now,context:{nodeId:assignment.executionNodeId,nodeRevision:2,graphRevision:assignment.graphRevision,status:'returned',stateVersion:5,leaseId:assignment.assignmentAttempt!.leaseId,reservationId:assignment.reservationId,runnerId:assignment.runnerId}}]);
		expect(database.first).toHaveBeenCalledOnce();
		expect(database.first.mock.calls[0]?.[0]).toContain("target.status='ready'");
		expect(database.first.mock.calls[0]?.[0]).toContain('marked_assignment');
		expect(database.first.mock.calls[0]?.[0]).toContain("reopened.pair_role='actor'");
		expect(database.first.mock.calls[0]?.[0]).toContain("reviewer.pair_role='reviewer'");
		expect(JSON.parse(String(database.first.mock.calls[0]?.[1]?.[3]))).toMatchObject({
			retained: true, operatorRetry: { requestedAt: expect.any(String) },
		});
	});
});
