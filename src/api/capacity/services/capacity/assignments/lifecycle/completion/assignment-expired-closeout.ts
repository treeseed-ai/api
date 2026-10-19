import { isDeepStrictEqual } from 'node:util';
import { settleCapacityReservationExactlyOnce } from '../../../accounting/settlement-service.ts';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../../database.ts';
import { ProviderAssignmentRepository, type DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';
import { CapacityWorkdayEventRepository, type CapacityWorkdayEventWrite } from '../../../../../repositories/capacity/workdays/workday-event.ts';
import type { ProviderLeasePrincipal } from '../../../../accounts/lease-authority-service.ts';
import { record, terminalPerformance, type ExtendedProviderAssignmentLifecycleRequest } from './assignment-terminal-performance.ts';
import { composeAssignmentLifecycleOutput } from '../assignment-lifecycle-output.ts';

/** Nonproductive acknowledgement through the existing failure operation. The
 * original expiration, immutable attempt and accepted charge remain authority.
 * No new result, settlement, successful review or productive lease is issued. */
export async function acknowledgeExpiredCloseout(database: CapacityGovernanceDatabase,
	assignment: DurableProviderAssignment, principal: ProviderLeasePrincipal,
	input: ExtendedProviderAssignmentLifecycleRequest, now: string) {
	const recovery = record(record(assignment.metadata).leaseRecovery), attempt = assignment.assignmentAttempt;
	const deny = (): never => { throw new CapacityGovernanceError('provider_expired_closeout_conflict',
		'Original closed measured output and settled expired authority are required.', 409); };
	if (assignment.status !== 'expired' || !['expired', 'released'].includes(assignment.leaseState)
		|| assignment.teamId !== principal.teamId || assignment.capacityProviderId !== principal.capacityProviderId
		|| assignment.membershipId !== principal.membershipId || assignment.assignmentResult != null
		|| assignment.leaseToken || assignment.runnerId || !attempt || !assignment.workDayId
		|| attempt.id !== assignment.id || attempt.teamId !== assignment.teamId || attempt.projectId !== assignment.projectId
		|| attempt.workdayId !== assignment.workDayId || attempt.provider.providerId !== assignment.capacityProviderId
		|| attempt.reservationId !== assignment.reservationId || attempt.status !== 'expired'
		|| recovery.disposition !== 'operator-action' || !['expired_lease_settlement_without_success_evidence','expired_lease_side_effect_evidence_present'].includes(String(recovery.reasonCode))
		|| assignment.lifecycleCode !== recovery.reasonCode || typeof input.runnerId !== 'string' || !input.runnerId
		|| input.runnerId !== recovery.priorRunnerId || input.code !== 'assignment_timeout' || input.retryable !== false
		|| input.completion != null || record(input).assignmentResult != null || input.performance != null || input.fallbackOutput != null) return deny();
	const output = record(input.output), teardown = record(output.teardown), parsed = assignmentResultSchema.safeParse(output.assignmentResult);
	if (!parsed.success || !isDeepStrictEqual(parsed.data, output.assignmentResult) || parsed.data.assignmentId !== assignment.id
		|| teardown.verified !== true || typeof output.sandboxId !== 'string' || !output.sandboxId.trim()) return deny();
	const produced = Date.parse(parsed.data.completedAt), closed = Date.parse(String(teardown.completedAt ?? ''));
	if (!Number.isFinite(produced) || !Number.isFinite(closed) || produced < Date.parse(attempt.createdAt)
		|| produced > Date.parse(attempt.deadline) || produced > closed || closed > Date.parse(now)) return deny();
	const native = record(parsed.data.usage.native), positive = (value: unknown): value is number =>
		typeof value === 'number' && Number.isFinite(value) && value > 0;
	if (!positive(native.activeSeconds) || !positive(native.elapsedSeconds) || native.activeSeconds > native.elapsedSeconds
		|| Math.ceil(native.elapsedSeconds) !== parsed.data.usage.elapsedSeconds) return deny();
	const count=(value:unknown):number=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)return deny();return value;};
	const expected = { active_seconds: Math.ceil(native.activeSeconds), elapsed_seconds: parsed.data.usage.elapsedSeconds,
		input_tokens: parsed.data.usage.modelInputTokens ?? 0, output_tokens: parsed.data.usage.modelOutputTokens ?? 0,
		cached_input_tokens: count(native.cachedInputTokens ?? 0), reasoning_tokens: count(native.reasoningTokens ?? 0) };
	let reservation = await database.first('SELECT * FROM capacity_reservations WHERE id=? AND team_id=? FOR UPDATE',
		[assignment.reservationId, assignment.teamId]);
	let entries = await database.all("SELECT * FROM capacity_ledger_entries WHERE reservation_id=? AND phase='task_completed_actual_settlement'",
		[assignment.reservationId]);
	let usages = await database.all("SELECT * FROM capacity_usage_actuals WHERE assignment_id=? AND accounting_mode='aggregate'", [assignment.id]);

	// A retained diagnostic is not a settlement. Transfer only the original
	// provider/attempt's matching native observation through the same exactly-once
	// accounting service; unknown, conflicting or incremental usage stays held.
	if(recovery.reasonCode==='expired_lease_side_effect_evidence_present' && reservation?.state==='consuming' && entries.length===0 && usages.length===0){
		if(reservation.settlement_token || reservation.usage_report_token)return deny();
		const reports=await database.all("SELECT * FROM capacity_usage_actuals WHERE assignment_id=?",[assignment.id]);
		const report=reports[0];
		if(reports.length!==1 || !report || report.id!==`usage:${assignment.id}:${attempt.attempt}:diagnostic-0`
			|| report.idempotency_key!==`usage:${assignment.id}:${input.runnerId}:0` || report.assignment_attempt!==attempt.attempt
			|| report.accounting_mode!=='informational' || report.usage_dimension!=='diagnostic-0'
			|| report.active_seconds!==0 || report.elapsed_seconds!==0
			|| report.capacity_provider_id!==assignment.capacityProviderId || report.execution_provider_id!==assignment.executionProviderId
			|| report.project_id!==assignment.projectId || report.work_day_id!==assignment.workDayId
			|| !isDeepStrictEqual(record(report.native_usage_json),native)
			|| !Object.entries(expected).filter(([key])=>key.endsWith('_tokens')).every(([key,value])=>(report[key]??0)===value))return deny();
		await settleCapacityReservationExactlyOnce(database,{settlementKey:`assignment-settlement:${assignment.id}:${input.runnerId}`,
			teamId:assignment.teamId,membershipId:assignment.membershipId,reservationId:assignment.reservationId!,assignmentId:assignment.id,assignmentAttempt:attempt.attempt,
			activeSeconds:expected.active_seconds,elapsedSeconds:expected.elapsed_seconds,
			providerUnits:report.provider_units==null?null:Number(report.provider_units),usd:report.actual_usd==null?null:Number(report.actual_usd),
			usageActual:{inputTokens:expected.input_tokens,outputTokens:expected.output_tokens,cachedInputTokens:expected.cached_input_tokens,reasoningTokens:expected.reasoning_tokens,nativeUsage:native},
			source:'provider_assignment_fail',existingSettlementPolicy:'require-match',metadata:{code:'assignment_timeout',originalRecoveryCode:assignment.lifecycleCode}});
		reservation=await database.first('SELECT * FROM capacity_reservations WHERE id=? AND team_id=? FOR UPDATE',[assignment.reservationId,assignment.teamId]);
		entries=await database.all("SELECT * FROM capacity_ledger_entries WHERE reservation_id=? AND phase='task_completed_actual_settlement'",[assignment.reservationId]);
		usages=await database.all("SELECT * FROM capacity_usage_actuals WHERE assignment_id=? AND accounting_mode='aggregate'",[assignment.id]);
	}
	const entry = entries[0], usage = usages[0];
	if (!reservation || !entry || !usage || entries.length !== 1 || usages.length !== 1 || reservation.state !== 'consumed'
		|| !reservation.settlement_token || reservation.usage_report_token
		|| entry.settlement_key !== `assignment-settlement:${assignment.id}:${input.runnerId}`
		|| usage.assignment_attempt !== attempt.attempt || usage.id !== `usage:${assignment.id}:${attempt.attempt}:aggregate`) return deny();
	const scope = { team_id: assignment.teamId, assignment_id: assignment.id, membership_id: assignment.membershipId,
		capacity_provider_id: assignment.capacityProviderId, execution_provider_id: assignment.executionProviderId,
		project_id: assignment.projectId, work_day_id: assignment.workDayId };
	if (!Object.entries(scope).every(([key, value]) => reservation[key] === value && entry[key] === value
		&& (!['team_id', 'membership_id'].includes(key) ? usage[key] === value : true))) return deny();

	if (!Object.entries(expected).every(([key, value]) => Number.isSafeInteger(value) && Number(value) >= 0
		&& (key.endsWith('_tokens') ? usage[key] ?? 0 : usage[key]) === value)
		|| !['active_seconds', 'elapsed_seconds'].every(key => entry[key] === usage[key] && reservation[key] === usage[key])
		|| !Object.entries(record(usage.native_usage_json)).every(([key, value]) => native[key] === value)) return deny();
	const prior = record(assignment.lifecycleOutput);
	if (assignment.leaseState === 'released') {
		const { performance: _performance, completion, ...retained } = prior;
		if (completion !== null || !isDeepStrictEqual(retained, output)) return deny();
		return { assignment, leaseToken: null, leaseSeconds: null };
	}
	if (Object.keys(prior).length) return deny();
	const performance = terminalPerformance(assignment, { code: 'provider_closeout_recovery', reason: 'Retained measured output of original expired attempt.' }, 'failed', now, usage);
	const serialized = JSON.stringify(composeAssignmentLifecycleOutput({ output }, performance));
	const lifecycleOutput: Record<string, unknown> = JSON.parse(serialized);
	const changed = await database.first(`UPDATE capacity_provider_assignments SET lease_state='released',lifecycle_output_json=?,state_version=state_version+1,updated_at=?
		WHERE id=? AND team_id=? AND capacity_provider_id=? AND membership_id=? AND state_version=? AND status='expired' AND lease_state='expired' RETURNING id`,
		[serialized, now, assignment.id, principal.teamId, principal.capacityProviderId, principal.membershipId, assignment.stateVersion]);
	if (!changed) return deny();
	const actual = await new ProviderAssignmentRepository(database).get(principal.teamId, assignment.id);
	if (!actual || actual.stateVersion !== assignment.stateVersion + 1 || actual.leaseState !== 'released'
		|| !isDeepStrictEqual(actual, { ...assignment, leaseState: 'released', lifecycleOutput, stateVersion: assignment.stateVersion + 1, updatedAt: now })) return deny();
	const event: CapacityWorkdayEventWrite = { id: `assignment-terminal:${assignment.id}:${actual.stateVersion}`, projectId: assignment.projectId,
		workdayId: assignment.workDayId, assignmentId: assignment.id, eventType: 'assignment.expired', status: 'recorded',
		title: 'Expired assignment failed output retained', message: null, parameters: {}, metadata: {}, refs: {}, createdAt: now,
		context: { nodeId: attempt.nodeId, nodeRevision: attempt.nodeRevision, graphRevision: attempt.graphRevision,
			status: 'expired', leaseId: attempt.leaseId, reservationId: assignment.reservationId, runnerId: null,
			resultId: null, stateVersion: actual.stateVersion, recoveryDisposition: 'operator-action', recoveryReasonCode: assignment.lifecycleCode } };
	const observed = await new CapacityWorkdayEventRepository(database).create(principal.teamId, assignment.workDayId, event);
	if (!observed || Object.entries(event).some(([key, value]) => !isDeepStrictEqual(Reflect.get(observed, key), value))) return deny();
	return { assignment: actual, leaseToken: null, leaseSeconds: null };
}
