import { vi } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema, type AssignmentCompletionEvidence } from '@treeseed/sdk/agent-capacity';
import { ProviderAssignmentLifecycleService } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { CapacityRuntimeEvidenceRepository } from '../../../../../../../src/api/capacity/repositories/runtime/runtime-evidence.ts';
import { executePostgresBatch } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { createProviderAssignmentService } from '../../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { terminalUsage } from '../../../../capacity/accounting/architecture/settlement-fixture.ts';
import { workspaceCleanupFixture } from '../../architecture/workspace-cleanup-fixture.ts';
import { cancellationDatabase, cancelNow } from '../../architecture/cancellation-fixture.ts';
import { recoverExpiredProviderAssignments } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';

export const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
export const report = { leaseToken: 'lease-token', code: 'assignment_timeout', retryable: false,
	activeSeconds: 2, elapsedSeconds: 3, usage: { inputTokens: 7, nativeUsage: { activeSeconds: 2, tokens: 7 } } };
export const returnedCompletion: AssignmentCompletionEvidence = { disposition: 'blocked',
	acceptanceChecks: [{ id: 'isolated-work-item', passed: false }], durableArtifactRefs: [], remainingBudget: {},
	completionReason: 'Isolated provider return input; unfinished work requires a later authorized attempt.', noUsefulScopedWorkRemaining: false };
export async function fixture() {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(cancelNow));
	const native = await workspaceCleanupFixture();
	return { ...native, ...await lifecycle(native) };
}
export async function lifecycle(native: Awaited<ReturnType<typeof cancellationDatabase>>) {
	await native.query('UPDATE execution_nodes SET source_ref_json=?,authority_refs_json=?,estimate_json=?,required_capabilities_json=?,requested_permissions_json=?,workspace=? WHERE id=?',
		[JSON.stringify(native.attempt.sourceRef), JSON.stringify(native.attempt.authorityRefs), JSON.stringify(native.attempt.estimate),
			JSON.stringify(native.attempt.requiredCapabilities), JSON.stringify(native.attempt.effectiveProfile.permissionCeiling),
			native.attempt.workspace.mode, native.attempt.nodeId]);
	await native.query("UPDATE capacity_provider_assignments SET status='leased',lease_state='leased',lease_token='lease-token',lease_expires_at=?", [native.attempt.deadline]);
	const repository = new ProviderAssignmentRepository(native.owner), evidence = new CapacityRuntimeEvidenceRepository(native.owner);
	const store = { ...native.owner,
		db: { transaction: async <T>(run: (client: Parameters<typeof executePostgresBatch>[0]) => Promise<T>) =>
			native.db.transaction(transaction => run(transaction as unknown as Parameters<typeof executePostgresBatch>[0])) },
		getProviderAssignment: repository.get.bind(repository), recordAgentFallbackOutput: evidence.recordFallbackOutput.bind(evidence),
		recordProviderAssignmentExplanation: async () => { throw new Error('Terminal reporting must not invoke renewal explanation'); },
		updateCapacityWorkdayRun: async () => { throw new Error('This terminal report must not rewrite workday configuration'); } };
	return { repository, store, service: new ProviderAssignmentLifecycleService(store) };
}
export async function returnFixture() {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T21:00:02.000Z'));
	const native = await cancellationDatabase('leased', true);
	try {
		// Isolated two-attempt policy INPUT. Original productive seconds/deadline
		// and frozen attempt remain unchanged; this does not raise a live allowance.
		const envelope = structuredClone(native.assignment.capacityEnvelope);
		if (!envelope.budget) throw new Error('Missing original bounded assignment budget');
		envelope.budget.maxAttempts = 2;
		await native.query('UPDATE capacity_provider_assignments SET capacity_envelope_json=? WHERE id=?',
			[JSON.stringify(envelope), native.assignment.id]);
		return { ...native, ...await lifecycle(native), close: () => native.db.close() };
	} catch (error) { await native.db.close(); throw error; }
}
export async function completionFixture(settled = true) {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T21:00:02.000Z'));
	const native = await cancellationDatabase('leased', true);
	try {
		// Actual provider caller settles before completion. Exercise that SAME
		// public owning service rather than fabricating a consumed SQL state.
		if (settled) await createProviderAssignmentService(native.owner as Parameters<typeof createProviderAssignmentService>[0]).settle(
			{ principal: { ...principal, scopes: ['provider:usage:write', 'provider:assignments:write'] } }, native.assignment.id,
			{ ...terminalUsage, activeSeconds: 1, elapsedSeconds: 2,
				usageActual: { ...terminalUsage.usageActual, nativeUsage: { activeSeconds: 1, tokens: 7 } } }, 'completion-settlement');
		const workspace = native.attempt.workspace;
		if (workspace.mode !== 'git') throw new Error('Expected sole governed Git workspace input');
		const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'completion-result',
			assignmentId: native.attempt.id, status: 'completed', summary: 'Isolated canonical completion input, not native Git proof.',
			references: [{ kind: 'git', repository: workspace.repository, branch: workspace.branch, commit: 'b'.repeat(40) }],
			verification: [], diagnostics: [], usage: { elapsedSeconds: 2, modelInputTokens: 7, native: { activeSeconds: 1, tokens: 7 } },
			timingAwareness: { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
				firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status',
				lastToolSucceeded: true, firstToolCompliant: true, finalToolCompliant: true }, completedAt: '2026-10-02T21:00:02.000Z' });
		return { ...native, ...await lifecycle(native), result, close: () => native.db.close() };
	} catch (error) { await native.db.close(); throw error; }
}

/** Original production ordering: native settlement commits, then closeout
 * expires before completion. Measurements and sandbox receipts are inputs. */
export async function expiredCloseoutFixture(settled = true, canonicalCounters = false, producedAfterTeardown = false, reservationState: 'reserved' | 'consuming' = 'consuming') {
	const f = await completionFixture(false);
	try {
		const runnerId = 'original-runner', nativeUsage = canonicalCounters
			? { activeSeconds: 1, elapsedSeconds: 2, input_tokens: 7, cached_input_tokens: 3, output_tokens: 0, reasoning_output_tokens: 2 }
			: { activeSeconds: 1, elapsedSeconds: 2, tokens: 7 };
		const usageActual = { ...terminalUsage.usageActual, ...(canonicalCounters ? { cachedInputTokens: 3, reasoningTokens: 2 } : {}), nativeUsage };
		await f.query("UPDATE capacity_provider_assignments SET runner_id=?,metadata_json=jsonb_set(metadata_json::jsonb,'{operationalState}','\"closeout\"'::jsonb)::text WHERE id=?", [runnerId, f.attempt.id]);
		// Both states are canonical active reservations; admission retains reserved until settlement.
		await f.query('UPDATE capacity_reservations SET state=? WHERE id=?', [reservationState, f.attempt.reservationId]);
		const provider=createProviderAssignmentService(f.owner as unknown as Parameters<typeof createProviderAssignmentService>[0]);
		if(settled) await provider.settle(
			{ principal: { ...principal, scopes: ['provider:usage:write', 'provider:assignments:write'] } }, f.attempt.id,
			{ ...terminalUsage, activeSeconds: 1, elapsedSeconds: 2, usageActual },
			`assignment-settlement:${f.attempt.id}:${runnerId}`);
		else await provider.reportUsage({principal:{...principal,scopes:['provider:usage:write']}},f.attempt.id,{usageDimension:'diagnostic-0',accountingMode:'informational',activeSeconds:0,elapsedSeconds:0,usageActual},`usage:${f.attempt.id}:${runnerId}:0`);
		const output = { sandboxId: 'original-sandbox', teardown: { verified: true, completedAt: f.result.completedAt },
			assignmentResult: { ...f.result, ...(producedAfterTeardown ? { completedAt: new Date(Date.parse(f.result.completedAt) + 1).toISOString() } : {}), usage: { ...f.result.usage, native: { ...nativeUsage, ...(canonicalCounters ? { cachedInputTokens: 3, reasoningTokens: 2 } : {}) } } }, artifacts: [] };
		vi.setSystemTime(new Date(Date.parse(f.attempt.deadline) + 1));
		await recoverExpiredProviderAssignments(f.owner, { teamId: 'team' });
		return { ...f, output, input: { leaseToken: 'lease-token', runnerId, code: 'assignment_timeout', retryable: false, output } };
	} catch (error) { await f.close(); throw error; }
}

/** Native Kernel report: public settlement precedes expiration; no sandbox was acquired.
 * Source/content bytes and native clock are controlled test inputs, not live TreeDX proof. */
export async function expiredNativeReportFixture() {
 const f=await completionFixture(false);try{
  const path='notes/original-native-report.mdx',workspace={mode:'treedx' as const,workspaceId:'original-native-workspace',repository:'original-native-library',baseCommit:'a'.repeat(40),writablePaths:[path]};
  const attempt=assignmentAttemptSchema.parse({...f.attempt,effectiveProfile:{...f.attempt.effectiveProfile,handler:'reporter',handlerOrigin:'agent-package',activity:'reporting'},workspace,
   grant:{...f.attempt.grant,sourceWrite:[],contentWrite:[{store:'treedx',model:'note',id:'original-native-report',repository:workspace.repository,commit:workspace.baseCommit,path}]}});
  await f.query('UPDATE capacity_provider_assignments SET assignment_attempt_json=?,runner_id=?,metadata_json=? WHERE id=?',
   [JSON.stringify(attempt),'original-native-runner',JSON.stringify({...f.assignment.metadata,operationalState:'closeout'}),attempt.id]);
  const result=assignmentResultSchema.parse({...f.result,references:[{kind:'treedx',projectId:attempt.projectId,repository:workspace.repository,commit:'b'.repeat(40),path,workspaceId:workspace.workspaceId}],
   usage:{elapsedSeconds:2,native:{activeSeconds:0.7}}});
  await createProviderAssignmentService(f.owner as Parameters<typeof createProviderAssignmentService>[0]).settle(
   {principal:{...principal,scopes:['provider:usage:write','provider:assignments:write']}},attempt.id,
   {...terminalUsage,activeSeconds:1,elapsedSeconds:2,usageActual:{inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningTokens:0,nativeUsage:{}}},
   `assignment-settlement:${attempt.id}:original-native-runner`);
  const output={assignmentResult:result,teardown:{verified:true,completedAt:result.completedAt},artifacts:[]};
  vi.setSystemTime(new Date(Date.parse(attempt.deadline)+1));await recoverExpiredProviderAssignments(f.owner,{teamId:'team'});
  return {...f,attempt,result,output,input:{leaseToken:'lease-token',runnerId:'original-native-runner',code:'assignment_timeout',retryable:false,output}};
 }catch(error){await f.close();throw error;}
}
