import {terminalAssignmentAuthority} from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-terminal-authority.ts';
import * as transactions from '../../../../../src/api/capacity/transaction.ts';
import {CapacityWorkdayEventRepository} from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import { assignmentAttemptSchema, compileWorkday, emptyCapacityBudget } from '@treeseed/sdk/agent-capacity';
import { recoveryAssignment } from './architecture/cancellation-fixture.ts';
import { compileCapacityWorkdayRunRecord } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';

const fixture = vi.hoisted(() => ({ assignment: {} as Record<string, unknown>, run: null as Record<string, unknown> | null,
	settle: vi.fn() }));
vi.mock('../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts')>(),
	ProviderAssignmentRepository: class { async getForCancellation() { return fixture.assignment; } },
}));
vi.mock('../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts')>(),
	CapacityWorkdayRunRepository: class { async get() { return fixture.run; } },
}));
vi.mock('../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts', () => ({
	releaseCapacityReservationsExactlyOnce: fixture.settle,
}));
import { OperatorAssignmentService } from '../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';

const boundary = '2026-10-01T01:16:28.362Z';
function setup(ready = true) {
	vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T01:16:29.000Z')); fixture.settle.mockClear();
	const plan = compileWorkday({ id: 'workday', teamId: 'team', executionMode: 'simulation', policyId: 'default', policyRevision: 4,
		startsAt: '2026-10-01T00:56:28.362Z', agentIds: [], policy: { durationSeconds: 3600, planningPercent: 100 / 3,
			allocationWeight: 1, planningTurnMaximumSeconds: 180, maximumConcurrency: 5, communicationConcurrency: 5,
			projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } } });
	fixture.run = { ...compileCapacityWorkdayRunRecord('team', { id: 'workday', status: 'running', executionMode: 'simulation',
		capacityProviderId: 'provider', startedAt: plan.startsAt,
		parameters: { durationSeconds: 3600, scheduledProjectIds: ['project'], appliedPlan: plan } }, { now: plan.startsAt }) };
	const base = recoveryAssignment(false), attempt = assignmentAttemptSchema.parse({ ...base.assignmentAttempt,
		id: 'assignment', idempotencyKey: 'assignment', createdAt: '2026-10-01T01:16:26.270Z', deadline: boundary,
		effectiveProfile: { ...base.assignmentAttempt!.effectiveProfile, activity: 'planning' } });
	const budget = emptyCapacityBudget(boundary, attempt.limits.maximumSeconds);
	fixture.assignment = { ...base, id: 'assignment', teamId: 'team', projectId: 'project', capacityProviderId: 'provider',
		workDayId: 'workday', status: 'returned', leaseState: 'released', stateVersion: 4, reservationId: 'reservation',
		membershipId: 'membership', claimedAt: '2026-10-01T01:16:26.270Z', metadata: {},
		assignmentAttempt: attempt,
		capacityEnvelope: { ...base.capacityEnvelope, budget: { ...budget, time: { ...budget.time,
			preparationStartedAt: '2026-10-01T01:16:26.270Z', authorityDeadlineAt: boundary, preparationDeadlineAt: boundary } } },
		lifecycleOutput: { teardown: { verified: true, completedAt: boundary }, completion: { disposition: 'completed' }, performance: null } };
	const first = vi.fn(async (query: string, params: unknown[]): Promise<Record<string, unknown> | null> => {
		if (query.includes("node.kind IN ('acting','reviewing')")) return ready ? { id: 'actor' } : null;
		if (query.includes('capacity_usage_actuals')) return { active_seconds: 0, elapsed_seconds: 2.635 };
		if (query.startsWith('UPDATE capacity_provider_assignments SET status')) {
			fixture.assignment = {...fixture.assignment,status:'cancelled',leaseState:'released',stateVersion:Number(fixture.assignment.stateVersion)+1,assignmentAttempt:params[0]?JSON.parse(String(params[0])):fixture.assignment.assignmentAttempt,lifecycleCode:params[1],lifecycleReason:params[2],failedAt:fixture.assignment.failedAt??params[3],lifecycleOutput:JSON.parse(String(params[4])),updatedAt:params[5]};
			return { id: 'assignment', params };
		}
		return null;
	});
	const database = { ensureInitialized: vi.fn(),run:vi.fn(async()=>{}), first, batch: vi.fn() };
	return { database, service: new OperatorAssignmentService(database as never) };
}
beforeEach(()=>{vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply(store));vi.spyOn(CapacityWorkdayEventRepository.prototype,'get').mockResolvedValue(null);vi.spyOn(CapacityWorkdayEventRepository.prototype,'create').mockImplementation(async(teamId,runId,value)=>({...value,teamId,runId,eventIndex:0}));});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('operator planning boundary closeout', () => {
 it('retains the original revocation clock on every already revoked handle without rewriting input during later cleanup',()=>{
  const at='2026-10-02T21:00:04.000Z',later='2026-10-02T21:00:05.000Z',handle={id:'original-handle',status:'revoked',revokedAt:at};
  const input={...recoveryAssignment(false),treedxProxyHandle:handle,capabilityHandles:{repository:[handle],treeDx:[handle],workflowOperations:[handle],secrets:[handle]}},held=structuredClone(input);
  const actual=terminalAssignmentAuthority(input,later);expect(actual.proxyHandle).toEqual(handle);
  for(const values of Object.values(actual.capabilityHandles))expect(values).toEqual([handle]);expect(input).toEqual(held);
 });

 it('records one exact scoped active cancellation request without terminalizing or rewriting issued authority',async()=>{
  const {service,database}=setup();fixture.assignment={...recoveryAssignment(false)};const before=structuredClone(fixture.assignment);vi.setSystemTime(new Date('2026-10-02T21:00:04.000Z'));
  Object.assign(database,{run:vi.fn(async()=>{})});const transaction=vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply(store)),read=vi.spyOn(CapacityWorkdayEventRepository.prototype,'get').mockResolvedValue(null);
  database.first.mockImplementation(async(query,params)=>{if(query.startsWith('UPDATE capacity_provider_assignments SET metadata_json')){fixture.assignment={...fixture.assignment,metadata:JSON.parse(String(params[0])),stateVersion:Number(fixture.assignment.stateVersion)+1,lifecycleReason:params[1],updatedAt:params[2]};return{id:fixture.assignment.id};}throw new Error('Unexpected unit cancellation read');});
  const event=vi.spyOn(CapacityWorkdayEventRepository.prototype,'create').mockImplementation(async(teamId,runId,value)=>({...value,teamId,runId,eventIndex:0}));
  try{await service.cancel('team',String(fixture.assignment.id),{idempotencyKey:'unit-request',actorId:'operator',reason:'Original unit request.'});expect(event,'active request must publish its exact owning observation').toHaveBeenCalledOnce();expect(event.mock.calls[0]).toEqual(['team',before.workDayId,{id:'assignment-cancellation-requested:'+before.id,projectId:before.projectId,workdayId:before.workDayId,assignmentId:before.id,eventType:'assignment.cancellation-requested',status:'recorded',title:'Assignment cancellation requested',message:null,parameters:{idempotencyKey:'unit-request',actorId:'operator',reason:'Original unit request.'},metadata:{},refs:{},createdAt:'2026-10-02T21:00:04.000Z',context:{nodeId:before.executionNodeId,nodeRevision:before.executionNodeRevision,graphRevision:before.graphRevision,status:'leased',leaseId:(before.assignmentAttempt as {leaseId:string}).leaseId,reservationId:before.reservationId,runnerId:before.runnerId,stateVersion:2}}]);expect(fixture.assignment.assignmentAttempt).toEqual(before.assignmentAttempt);expect(fixture.settle).not.toHaveBeenCalled();}
  finally{event.mockRestore();transaction.mockRestore();read.mockRestore();}
 });

	it('denies missing malformed and incomplete measured usage before cancelling a released productive attempt', async () => {
		for (const measurements of [null, {}, { active_seconds: 1 }, { elapsed_seconds: 1 },
			{ active_seconds: '1', elapsed_seconds: 1 }, { active_seconds: 1, elapsed_seconds: -1 },
			{ active_seconds: Number.NaN, elapsed_seconds: 1 }, { active_seconds: 1, elapsed_seconds: Number.POSITIVE_INFINITY }]) {
			const { service, database } = setup();
			const budget = emptyCapacityBudget(boundary, 2);
			fixture.assignment.capacityEnvelope = { teamId: 'team', projectId: 'project', mode: 'acting',
				budget: { ...budget, time: { ...budget.time, executionStartedAt: '2026-10-01T01:16:26.270Z' } } };
			const before = structuredClone(fixture.assignment), input = { idempotencyKey: 'original-cancellation' };
			database.first.mockResolvedValueOnce(measurements);
			await expect(service.cancel('team', 'assignment', input)).rejects.toMatchObject({
				code: expect.stringMatching(/^provider_assignment_usage_(required|invalid)$/u) });
			expect(database.first).toHaveBeenCalledOnce(); expect(database.first.mock.calls[0]![0]).toContain('capacity_usage_actuals');
			expect(database.batch).not.toHaveBeenCalled(); expect(fixture.settle).not.toHaveBeenCalled();
			expect(fixture.assignment).toEqual(before); expect(input).toEqual({ idempotencyKey: 'original-cancellation' });
		}
	});
	it('normalizes a claimed returned turn without replacing the provider closure or measured usage', async () => {
		const { service, database } = setup();
		await service.cancel('team', 'assignment', { idempotencyKey: 'ordinary-key' });
		const write = database.first.mock.calls.find(([query]) => query.startsWith('UPDATE capacity_provider_assignments SET status'))!;
		expect(write[0]).toContain('failed_at = COALESCE(failed_at, ?)');
		expect(write[1]).toContain('planning_boundary_cancelled');
		const output = write[1].filter(value => typeof value === 'string').map(value => { try { return JSON.parse(value as string); } catch { return null; } })
			.find(value => value?.performance);
		expect(output).toMatchObject({ teardown: { verified: true, completedAt: boundary },
			completion: { disposition: 'cancelled' }, performance: { disposition: 'cancelled', actual: { activeSeconds: 0, elapsedSeconds: 2.635 } } });
		expect(fixture.settle).toHaveBeenCalledOnce();
	});
	it('does not invent isolation teardown when the provider supplied no receipt', async () => {
		const { service, database } = setup(); fixture.assignment.lifecycleOutput = {};
		await service.cancel('team', 'assignment', { idempotencyKey: 'phase' });
		const write = database.first.mock.calls.find(([query]) => query.startsWith('UPDATE capacity_provider_assignments SET status'))!;
		const output = write[1].filter(value => typeof value === 'string').map(value => { try { return JSON.parse(value as string); } catch { return null; } })
			.find(value => value?.performance);
		expect(output?.teardown).toBeUndefined();
		expect(output?.performance.disposition).toBe('cancelled');
	});
	it.each(['earlier', 'acting', 'fluid', 'wrong-provider'])('preserves ordinary cancellation for %s despite a planning-looking reason or key', async kind => {
		const { service, database } = setup(kind !== 'fluid');
		if (kind === 'earlier') vi.setSystemTime(new Date('2026-10-01T01:16:27.000Z'));
		if (kind === 'acting') {
			const attempt = assignmentAttemptSchema.parse(fixture.assignment.assignmentAttempt);
			fixture.assignment.assignmentAttempt = assignmentAttemptSchema.parse({ ...attempt,
				effectiveProfile: { ...attempt.effectiveProfile, activity: 'acting' } });
		}
		if (kind === 'wrong-provider') fixture.run!.capacityProviderId = 'other';
		await service.cancel('team', 'assignment', { idempotencyKey: 'planning-boundary:workday', reason: 'Planning window ended.' });
		const write = database.first.mock.calls.find(([query]) => query.startsWith('UPDATE capacity_provider_assignments SET status'))!;
		expect(write[1]).toContain('operator_cancelled');
		expect(write[1]).not.toContain('planning_boundary_cancelled');
	});
});
