import * as assignmentRecords from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import * as transactions from '../../../../../../src/api/capacity/transaction.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import {afterEach,describe,expect,it,vi} from 'vitest';
afterEach(()=>vi.restoreAllMocks());
import {recoverExpiredProviderAssignments, decideAssignmentRecovery, type RecoveryEvidence } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import { recoveryAssignment as assignment } from './cancellation-fixture.ts';
const evidence: RecoveryEvidence = { reservation: { id: 'reservation' }, settlement: null, usageCount: 0,
	hasAssignmentResult: false, proxyEvents: 0, fallbackOutputs: 0, node: { id: 'report-node', status: 'running' },
	failoverAllowed: true, failoverCount: 1, invocationFinalMessageRef: null };
// UNIT pure recovery classification/serializer. Missing measurements are not proof of zero execution.
describe('recovery respects immutable executed-attempt and measurement authority', () => {
 it('requires exact scoped recovery observations and refuses missing or conflicting reports without changing supplied terminal authority',async()=>{
  for(const field of [undefined,null,'id','teamId','runId','projectId','workdayId','assignmentId','eventType','createdAt','context']as const){
   const original=assignment(true),held=structuredClone(original),now=new Date(Date.parse(original.leaseExpiresAt!)+90_001).toISOString();
   const terminal={...original,status:'expired',leaseState:'expired',leaseToken:null,leaseExpiresAt:null,leaseRenewedAt:null,runnerId:null,stateVersion:original.stateVersion+1,updatedAt:now,lifecycleCode:'expired_lease_execution_usage_unknown',assignmentAttempt:assignmentRecords.advanceAssignmentAttemptLifecycle(original.assignmentAttempt!,'expired',now)};
   vi.spyOn(assignmentRecords,'serializeProviderAssignmentRow').mockReturnValue(original);
   vi.spyOn(assignmentRecords.ProviderAssignmentRepository.prototype,'get').mockResolvedValueOnce(original).mockResolvedValueOnce(terminal);
   vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply(store));
   const published=vi.spyOn(CapacityWorkdayEventRepository.prototype,'create').mockImplementation(async(teamId,runId,value)=>field===null?null:field===undefined?{...value,teamId,runId,eventIndex:0}:{...value,teamId,runId,eventIndex:0,[field]:field==='context'?{}:'foreign'});
   const database={ensureInitialized:async()=>{},run:vi.fn(async()=>{}),all:vi.fn(async()=>[{}]),batch:vi.fn(async()=>{}),first:async(sql:string)=>sql.includes('SELECT COUNT')?{total:0}:sql.includes('SELECT id,status,node_revision')?{id:original.executionNodeId,status:'running',node_revision:original.executionNodeRevision}:null};
   try{
    const pending=recoverExpiredProviderAssignments(database as never,{now,teamId:original.teamId});
    if(field===undefined)await expect(pending).resolves.toMatchObject({recovered:1,operatorActions:1});else await expect(pending).rejects.toThrow('assignment_recovery_observation_conflict');
    expect(published).toHaveBeenCalledOnce();expect(published.mock.calls[0]).toEqual([original.teamId,original.workDayId,{id:'assignment-terminal:'+original.id+':2',projectId:original.projectId,workdayId:original.workDayId,assignmentId:original.id,eventType:'assignment.expired',status:'recorded',title:'Assignment expired',message:null,parameters:{},metadata:{},refs:{},createdAt:now,context:{nodeId:original.executionNodeId,nodeRevision:original.executionNodeRevision,graphRevision:original.graphRevision,status:'expired',leaseId:original.assignmentAttempt!.leaseId,reservationId:original.reservationId,runnerId:null,resultId:null,recoveryDisposition:'operator-action',recoveryReasonCode:'expired_lease_execution_usage_unknown'}}]);
    expect(original).toEqual(held);expect(database.run).toHaveBeenCalledOnce();expect(database.batch).toHaveBeenCalledOnce();
   }finally{vi.restoreAllMocks();}
  }
 });

	it('does not authorize a zero-cost safe retry when an execution clock started but terminal usage is unknown', () => {
		const input = assignment(true), before = structuredClone(input), observed = structuredClone(evidence);
		expect(decideAssignmentRecovery(input, observed).disposition).toBe('operator-action');
		expect(input).toEqual(before); expect(observed).toEqual(evidence);
	});
	it('preserves no-execution retry and financial uncertainty side-effect result and bounded failover denials', () => {
		const input = assignment(false), before = structuredClone(input);
		expect(decideAssignmentRecovery(input, evidence)).toMatchObject({ disposition: 'safe-retry', status: 'failed' });
		for (const change of [{ reservation: { settlement_token: 'pending' } }, { usageCount: 1 },
			{ hasAssignmentResult: true }, { proxyEvents: 1 }, { fallbackOutputs: 1 }]) {
			expect(decideAssignmentRecovery(input, { ...evidence, ...change }).disposition).toBe('operator-action');
		}
		expect(decideAssignmentRecovery(input, { ...evidence, failoverAllowed: false }).disposition).toBe('terminal-failure');
		expect(decideAssignmentRecovery(input, { ...evidence, failoverCount: 3 }).reasonCode).toBe('expired_lease_retry_exhausted');
		expect(input).toEqual(before);
	});
});
