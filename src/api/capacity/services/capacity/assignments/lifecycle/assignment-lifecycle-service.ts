import { type AssignmentResult,type ProviderAssignmentExplanation } from '@treeseed/sdk/agent-capacity';
import { classifyCapacityFailure } from '../../../../policy/failure-classification.ts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { ProviderAssignmentRepository } from '../../../../repositories/capacity/assignments/assignment.ts';
import { CapacityRuntimeEvidenceRepository } from '../../../../repositories/runtime/runtime-evidence.ts';
import { capacityTransaction } from '../../../../transaction.ts';
import type { AgentFallbackOutputWrite } from '../../../../repositories/runtime/runtime-evidence.ts';
import { evaluateProviderAssignmentLeaseAuthority,type ProviderLeasePrincipal } from '../../../accounts/lease-authority-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../accounting/settlement-service.ts';
import { validateAssignmentResultCompletion } from '../context/assignment-result-completion.ts';
import { verifyAssignmentContent, recordAssignmentContentIntegration } from './assignment-content-readback.ts';
import { resolveReviewDisposition } from '../context/review-result.ts';
import { commitLivingExecutionLifecycle } from './execution/living-execution-lifecycle.ts';
import type { ProviderAssignmentExplanationWrite } from '../observability/assignment-explanation-service.ts';
import { integrateAssignmentEstimate } from '../planning/estimates/integration.ts';
import { normalizeProviderAssignmentLeaseSeconds } from './assignment-lease-service.ts';
import { terminalAssignmentAuthority } from './assignment-terminal-authority.ts';
import { composeAssignmentLifecycleOutput } from './assignment-lifecycle-output.ts';
import { terminalizeOperationHandoff } from '../handoffs/operation-handoff-lifecycle-service.ts';
import { closeTerminalAssignmentWorkspace } from '../observability/assignment-terminal-workspace.ts';
import type { WorkdayTreeDxConnectionStore } from '../../workdays/treedx/workday-treedx-connection.ts';
import { archivedConversationCancellation, planningBoundaryCancellation } from './assignment-failure-policy.ts';
import { assertAssignmentCompletionEvidence } from './completion/assignment-completion-evidence.ts';
import { quarantineContextOverflowOffer } from './context-capacity/overflow.ts';
import { optionalFiniteNumber,record,terminalPerformance,type ExtendedProviderAssignmentLifecycleRequest,type JsonRecord } from './completion/assignment-terminal-performance.ts';
import { reconcileExecutionGraph } from '../../../../../control-plane/repositories/capacity/execution/execution-graph-service.ts';
export type { ExtendedProviderAssignmentLifecycleRequest } from './completion/assignment-terminal-performance.ts';
interface ProviderAssignmentLifecycleStore extends CapacityGovernanceDatabase, Partial<WorkdayTreeDxConnectionStore> {
	getProviderAssignment(teamId: string, assignmentId: string): Promise<DurableProviderAssignment | null>;
	recordAgentFallbackOutput(input: AgentFallbackOutputWrite): Promise<unknown>;
	recordProviderAssignmentExplanation(teamId:string,assignmentId:string,input:ProviderAssignmentExplanationWrite):Promise<ProviderAssignmentExplanation|null>;
	updateCapacityWorkdayRun(teamId: string, runId: string, input: JsonRecord): Promise<JsonRecord | null>;
}
export interface ProviderAssignmentLifecycleMutationResult {
	assignment: DurableProviderAssignment; leaseToken: string | null; leaseSeconds: number | null;
}

async function assertRequiredSignals(database: CapacityGovernanceDatabase, assignment: DurableProviderAssignment) {
	const required = Array.isArray(record(assignment.allowedOutputs).publishedSignals)
		? [...new Set((record(assignment.allowedOutputs).publishedSignals as unknown[]).map(String).map((value) => value.replace(/_/gu, '-')).filter(Boolean))] : [];
	if (!required.length) return;
	const rows = await database.all(`SELECT DISTINCT contract_id FROM agent_signals WHERE assignment_id = ?`, [assignment.id]);
	const published = new Set(rows.map((row) => String(row.contract_id).replace(/_/gu, '-')));
	const missing = required.filter((contractId) => !published.has(contractId));
	if (missing.length) throw new CapacityGovernanceError('provider_assignment_signal_evidence_missing', 'Assignment cannot complete before all declared signal publications are durably validated.', 409, { assignmentId: assignment.id, missingContractIds: missing });
}

async function assertCommunicationOutcome(database: CapacityGovernanceDatabase, assignment: DurableProviderAssignment) {
	if (assignment.executionKind !== 'conversation') return;
	if (!assignment.invocationId) throw new CapacityGovernanceError('communication_invocation_provenance_missing', 'Conversation assignment lacks its exact invocation.', 409, { assignmentId: assignment.id });
	const invocation = await database.first(`SELECT status,assignment_id,final_message_ref FROM agent_invocation_requests WHERE id = ? AND team_id = ? LIMIT 1`, [assignment.invocationId, assignment.teamId]);
	if (!invocation || invocation.assignment_id !== assignment.id || !String(invocation.final_message_ref ?? '').trim()) throw new CapacityGovernanceError(
		'communication_final_message_required',
		'Conversation assignment cannot complete without one authoritative durable final response.',
		409,
		{ assignmentId: assignment.id, invocationId: assignment.invocationId },
	);
}

function activeLeaseOwnedBy(
	assignment: DurableProviderAssignment | null,
	principal: ProviderLeasePrincipal,
	leaseToken: string | null | undefined,
	now: string,
	allowExpired = false,
): assignment is DurableProviderAssignment {
	return Boolean(
		assignment
		&& assignment.capacityProviderId === principal.capacityProviderId
		&& assignment.membershipId === principal.membershipId
		&& assignment.status === 'leased'
		&& assignment.leaseState === 'leased'
		&& assignment.leaseToken
		&& assignment.leaseToken === leaseToken
		&& (allowExpired || !assignment.leaseExpiresAt || Date.parse(assignment.leaseExpiresAt) > Date.parse(now)),
	);
}

export class ProviderAssignmentLifecycleService {
	constructor(private readonly store: ProviderAssignmentLifecycleStore) {}

	async renew(
		principal: ProviderLeasePrincipal,
		assignmentId: string,
		input: ExtendedProviderAssignmentLifecycleRequest = {},
	): Promise<ProviderAssignmentLifecycleMutationResult | null> {
		await this.store.ensureInitialized();
		const leaseSeconds = normalizeProviderAssignmentLeaseSeconds(input.leaseSeconds);
		const assignment = await this.store.getProviderAssignment(principal.teamId, assignmentId);
		const recordFailure = async (reason: string, gates: JsonRecord = {}): Promise<void> => {
			await this.store.recordProviderAssignmentExplanation(principal.teamId, assignmentId, {
				source: 'provider_assignment_renew',
				sourceId: assignmentId,
				eligible: false,
				reasons: [reason],
				gates: {
					capacityProviderId: principal.capacityProviderId,
					assignmentProviderId: assignment?.capacityProviderId ?? null,
					assignmentStatus: assignment?.status ?? null,
					leaseState: assignment?.leaseState ?? null,
					hasLeaseToken: Boolean(assignment?.leaseToken),
					runnerId: input.runnerId ?? null,
					...gates,
				},
				metadata: { evaluatedAt: new Date().toISOString(), diagnosticsSource: 'provider_assignment_renew' },
			});
		};
		if (!assignment) {
			await recordFailure('assignment_missing');
			return null;
		}
		if (assignment.capacityProviderId !== principal.capacityProviderId) {
			await recordFailure('assignment_provider_mismatch');
			return null;
		}
		if (record(assignment.metadata).cancellationRequested === true) {
			await recordFailure('assignment_cancellation_requested'); return null;
		}
		const now = new Date().toISOString();
		const authority = await evaluateProviderAssignmentLeaseAuthority(this.store, principal, assignment.id, now);
		if (!authority.eligible) {
			await recordFailure('assignment_authority_revoked', { reasons: authority.reasons, authority: authority.gates });
			return null;
		}
		if (assignment.leaseState !== 'leased') {
			await recordFailure('assignment_not_leased');
			return null;
		}
		if (assignment.leaseToken !== input.leaseToken) {
			await recordFailure('lease_token_mismatch', { providedLeaseToken: input.leaseToken ? '<redacted>' : null });
			return null;
		}
		if (assignment.leaseExpiresAt && Date.parse(assignment.leaseExpiresAt) <= Date.parse(now)) {
			await recordFailure('lease_expired', { leaseExpiresAt: assignment.leaseExpiresAt, evaluatedAt: now });
			return null;
		}
		const budget = record(record(assignment.capacityEnvelope).budget);
		const hardDeadline = Date.parse(String(budget.deadline ?? record(budget.time).hardDeadlineAt ?? ''));
		if (Number.isFinite(hardDeadline) && hardDeadline <= Date.parse(now)) { await recordFailure('assignment_hard_deadline_exhausted', { hardDeadlineAt: new Date(hardDeadline).toISOString() }); return null; }
		const leaseExpiresAt = new Date(Math.min(Date.parse(now) + leaseSeconds * 1000, Number.isFinite(hardDeadline) ? hardDeadline : Number.POSITIVE_INFINITY)).toISOString();
		await this.store.run(
			`UPDATE capacity_provider_assignments
			 SET lease_expires_at = ?, lease_renewed_at = ?, runner_id = COALESCE(?, runner_id),
			     updated_at = ?
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ? AND membership_id = ?
			   AND state_version = ? AND status = 'leased' AND lease_state = 'leased'
			   AND lease_token = ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
			[
				leaseExpiresAt, now, input.runnerId ?? null, now, assignment.id, principal.teamId,
				principal.capacityProviderId, principal.membershipId, assignment.stateVersion, input.leaseToken, now,
			],
		);
		const renewed = await this.store.getProviderAssignment(principal.teamId, assignment.id);
		if (
			!renewed
			|| renewed.stateVersion < assignment.stateVersion
			|| renewed.status !== 'leased'
			|| renewed.leaseState !== 'leased'
			|| renewed.leaseToken !== input.leaseToken
			|| !renewed.leaseRenewedAt
			|| (renewed.leaseExpiresAt && Date.parse(renewed.leaseExpiresAt) <= Date.parse(now))
		) {
			await recordFailure('lease_state_changed_concurrently');
			return null;
		}
		return { assignment: renewed, leaseToken: renewed.leaseToken ?? null, leaseSeconds };
	}

	async return(
		principal: ProviderLeasePrincipal,
		assignmentId: string,
		input: ExtendedProviderAssignmentLifecycleRequest = {},
	): Promise<ProviderAssignmentLifecycleMutationResult | null> {
		await this.store.ensureInitialized();
		return this.withLockedAssignment(principal, assignmentId, service => service.returnTerminal(principal, assignmentId, input));
	}
	private async returnTerminal(principal: ProviderLeasePrincipal, assignmentId: string, input: ExtendedProviderAssignmentLifecycleRequest) {
		const now = new Date().toISOString();
		const assignment = await this.store.getProviderAssignment(principal.teamId, assignmentId);
		if (!activeLeaseOwnedBy(assignment, principal, input.leaseToken, now)) return null;
		const contextCapacityAlert=await quarantineContextOverflowOffer({store:this.store,assignment,code:input.code ?? undefined,observedAt:now});
		if (record(assignment.metadata).cancellationRequested === true) {
			return this.transition(principal, assignment, input, now, {
				status: 'cancelled', timestampColumn: 'failed_at', defaultCode: 'operator_cancelled', defaultReason: String(record(assignment.metadata).cancellationReason ?? 'Assignment cancelled by a team operator.'),
				metadata: { ...record(assignment.metadata), operationalState: 'cancelled', cancelledAt: now },
			}, this.store);
		}
		assertAssignmentCompletionEvidence(input);
		const assignmentMetadata = record(assignment.metadata);
		const envelopeMetadata = record(record(assignment.capacityEnvelope).metadata);
		const configuredMaxAttempts = Number(
			record(assignmentMetadata.retryPolicy).maxAttempts
				?? envelopeMetadata.maxAttempts
				?? 3,
		);
		const maxAttempts = Number.isFinite(configuredMaxAttempts)
			? Math.max(1, Math.min(Math.floor(configuredMaxAttempts), 20))
			: 3;
		const currentAttempt = assignment.assignmentAttempt?.attempt ?? assignment.attemptCount;
		if (currentAttempt >= maxAttempts) {
			return this.failTerminal(principal, assignmentId, {
				...input,
				retryable: false,
				code: 'provider_assignment_retry_exhausted',
				reason: `Provider assignment exhausted its retry policy after ${currentAttempt} attempts.`,
				message: `Provider assignment exhausted its retry policy after ${currentAttempt} attempts.`,
				output: {
					...record(input.output ?? input.summary),
					retryPolicy: {
						originalCode: input.code ?? null,
						originalReason: input.reason ?? input.message ?? null,
						attemptCount: currentAttempt,
						maxAttempts,
					},
				},
				metadata: {
					...record(input.metadata),
					originalCode: input.code ?? null,
					originalReason: input.reason ?? input.message ?? null,
					attemptCount: currentAttempt,
					maxAttempts,
				},
			}, classifyCapacityFailure({ code: 'provider_assignment_retry_exhausted', retryable: false }));
		}
		if (input.fallbackOutput) await this.persistFallback(assignment, input.fallbackOutput);
		if (assignment.reservationId) {
			const usage = record(input.usage);
			const activeSeconds = input.activeSeconds ?? usage.activeSeconds;
			const elapsedSeconds = input.elapsedSeconds ?? usage.elapsedSeconds;
			if (typeof activeSeconds !== 'number' || !Number.isFinite(activeSeconds) || activeSeconds < 0
				|| typeof elapsedSeconds !== 'number' || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new CapacityGovernanceError(
				'provider_assignment_usage_invalid', 'Return requires exact finite nonnegative measured seconds.', 400);
			await settleCapacityReservationExactlyOnce(this.store, { settlementKey: `assignment-return:${assignment.id}:${assignment.stateVersion}`,
				teamId: principal.teamId, membershipId: principal.membershipId, reservationId: assignment.reservationId, assignmentId: assignment.id,
				assignmentAttempt: assignment.assignmentAttempt?.attempt, activeSeconds, elapsedSeconds,
				usageActual: usage, source: 'provider_assignment_return', existingSettlementPolicy: 'replay' });
		}
		const metadata = {
			...record(assignment.metadata),
			...(contextCapacityAlert?{contextCapacityAlert}:{}),
			lastReturn: {
				reason: input.reason ?? input.message ?? null,
				code: input.code ?? null,
				runnerId: input.runnerId ?? assignment.runnerId ?? null,
				at: now,
			},
		};
		return this.transition(principal, assignment, input, now, {
			status: 'returned',
			timestampColumn: 'returned_at',
			defaultCode: 'provider_assignment_returned',
			defaultReason: null,
			metadata,
		}, this.store);
	}

	async complete(
		principal: ProviderLeasePrincipal,
		assignmentId: string,
		input: ExtendedProviderAssignmentLifecycleRequest = {},
	): Promise<ProviderAssignmentLifecycleMutationResult | null> {
		await this.store.ensureInitialized();
		const now = new Date().toISOString();
		const assignment = await this.store.getProviderAssignment(principal.teamId, assignmentId);
		if (!activeLeaseOwnedBy(assignment, principal, input.leaseToken, now)) return null;
		if (!assignment.assignmentAttempt) throw new CapacityGovernanceError('assignment_graph_authority_required',
			'Only a living-graph assignment with an immutable attempt can complete.', 409, { assignmentId });
		const terminalInput = input;
		if (assignment.reservationId) {
			const reservation = await this.store.first(
				`SELECT state FROM capacity_reservations WHERE id = ? AND team_id = ? AND membership_id = ? AND assignment_id = ? LIMIT 1`,
				[assignment.reservationId, principal.teamId, principal.membershipId, assignment.id],
			);
			if (!reservation || reservation.state !== 'consumed') return null;
		}
		await assertRequiredSignals(this.store, assignment);
		await assertCommunicationOutcome(this.store, assignment);
		const assignmentResult = validateAssignmentResultCompletion(assignment, terminalInput as JsonRecord, now);
		const contentReferences = await verifyAssignmentContent(this.store, assignment, assignmentResult);
		if (assignmentResult) await integrateAssignmentEstimate(this.store, assignment, assignmentResult);
		const reviewDisposition = assignmentResult
			? await resolveReviewDisposition(this.store, assignment, assignmentResult)
			: null;
		const completed = await this.transition(principal, assignment, terminalInput, now, {
			status: 'completed',
			timestampColumn: 'completed_at',
			defaultCode: 'provider_assignment_completed',
			defaultReason: null,
			assignmentResult,
			reviewDisposition,
		});
		if (completed) await recordAssignmentContentIntegration(this.store, assignment, assignmentResult, contentReferences);
		if (completed && assignmentResult && assignment.assignmentAttempt?.effectiveProfile.activity === 'estimating') await reconcileExecutionGraph(this.store, assignment.teamId, {},
			`assignment-result:${assignment.id}:${assignment.stateVersion}`);
		if (completed && assignment.invocationId) {
			await this.store.run(`UPDATE agent_invocation_requests SET assignment_id=?,blocking_state_json=?,updated_at=?
				WHERE id=? AND team_id=? AND status='running'`, [assignment.id,JSON.stringify({ code:'content_integration_pending',assignmentId:assignment.id }),now,assignment.invocationId,assignment.teamId]);
		}
		return completed;
	}

	async fail(
		principal: ProviderLeasePrincipal,
		assignmentId: string,
		input: ExtendedProviderAssignmentLifecycleRequest = {},
	): Promise<ProviderAssignmentLifecycleMutationResult | null> {
		const failure = classifyCapacityFailure({ code: input.code, reason: input.reason ?? input.message, retryable: input.retryable });
		if (failure.retryable) return this.return(principal, assignmentId, {
			...input,
			code: input.code ?? 'provider_assignment_retryable_failure',
			reason: input.reason ?? input.message ?? 'Provider assignment failed and can be retried.',
		});
		await this.store.ensureInitialized();
		return this.withLockedAssignment(principal, assignmentId, service => service.failTerminal(principal, assignmentId, input, failure));
	}
	private async withLockedAssignment<T>(principal: ProviderLeasePrincipal, assignmentId: string,
		apply: (service: ProviderAssignmentLifecycleService) => Promise<T>): Promise<T> {
		return capacityTransaction(this.store, async database => {
			await database.run('SELECT id FROM teams WHERE id=? FOR UPDATE', [principal.teamId]);
			await database.run('SELECT id FROM capacity_provider_assignments WHERE id=? AND team_id=? FOR UPDATE', [assignmentId, principal.teamId]);
			const repository = new ProviderAssignmentRepository(database);
			const evidence = new CapacityRuntimeEvidenceRepository(database);
			const overrides = { ...database,
				getProviderAssignment: repository.get.bind(repository),
				recordAgentFallbackOutput: evidence.recordFallbackOutput.bind(evidence) };
			const store = new Proxy(this.store, { get: (target, key) =>
				Reflect.has(overrides, key) ? Reflect.get(overrides, key) : Reflect.get(target, key) });
			return apply(new ProviderAssignmentLifecycleService(store));
		});
	}

	private async failTerminal(principal: ProviderLeasePrincipal, assignmentId: string,
		input: ExtendedProviderAssignmentLifecycleRequest, failure: ReturnType<typeof classifyCapacityFailure>) {
		const now = new Date().toISOString();
		const assignment = await this.store.getProviderAssignment(principal.teamId, assignmentId);
		// Expiration ends productive authority, not the current owner's obligation
		// to report its terminal timeout. The row lock prevents recovery taking it.
		const timeout = input.code === 'assignment_timeout';
		if (!activeLeaseOwnedBy(assignment, principal, input.leaseToken, now, true)) return null;
		const phaseCancelled = await planningBoundaryCancellation(this.store, assignment, input, now);
		if (!timeout && !phaseCancelled && !activeLeaseOwnedBy(assignment, principal, input.leaseToken, now)) return null;
		if (phaseCancelled) {
			const reason = 'Unfinished planning turn cancelled at its authoritative phase boundary.';
			input = { ...input, code: 'planning_boundary_cancelled', reason,
				...(input.performance ? { performance: { ...input.performance, disposition: 'cancelled', reason } } : {}) };
			failure = classifyCapacityFailure(input);
		}
		const hasResult = Object.hasOwn(record(input.output), 'assignmentResult') || Object.hasOwn(input, 'assignmentResult');
		const assignmentResult = hasResult ? validateAssignmentResultCompletion(assignment, record(input), now, 'failed') : undefined;
		if (input.fallbackOutput) await this.persistFallback(assignment, {
			...input.fallbackOutput,
			status: record(input.fallbackOutput).status ?? 'suppressed',
		});
		if (assignment.reservationId) {
			const usage = record(input.usage);
			await settleCapacityReservationExactlyOnce(this.store, {
				settlementKey: `assignment-fail:${assignment.id}:${assignment.stateVersion}`,
				teamId: principal.teamId,
				membershipId: principal.membershipId,
				reservationId: assignment.reservationId,
				assignmentId: assignment.id,
				activeSeconds: Math.max(0, Number(input.activeSeconds ?? usage.activeSeconds ?? 0)),
				elapsedSeconds: Math.max(0, Number(input.elapsedSeconds ?? usage.elapsedSeconds ?? 0)),
				providerUnits: optionalFiniteNumber(input.providerUnits ?? usage.providerUnits, 'providerUnits'),
				usd: optionalFiniteNumber(input.actualUsd ?? usage.actualUsd, 'actualUsd'),
				usageActual: usage,
				source: 'provider_assignment_fail',
				existingSettlementPolicy: 'replay',
				metadata: { reason: input.reason ?? input.message ?? null, code: input.code ?? 'provider_assignment_failed' },
			});
		}
		const archived=archivedConversationCancellation(assignment,input);
		return this.transition(principal, assignment, input, now, {
			status: archived || phaseCancelled ? 'cancelled' : 'failed',
			timestampColumn: 'failed_at',
			defaultCode: archived?'discussion_archived':'provider_assignment_failed',
			defaultReason: archived?'The source Discussion was archived.':'Provider assignment failed.',
			metadata: { ...record(assignment.metadata), failureClassification: failure },
			assignmentResult,
			allowExpiredLease: timeout || phaseCancelled,
		}, this.store);
	}

	private async persistFallback(assignment: DurableProviderAssignment, fallbackOutput: JsonRecord): Promise<void> {
		await this.store.recordAgentFallbackOutput({
			...fallbackOutput,
			projectId: assignment.projectId,
			assignmentId: assignment.id,
			mode: assignment.mode,
		});
	}

	private async transition(
		principal: ProviderLeasePrincipal,
		assignment: DurableProviderAssignment,
		input: ExtendedProviderAssignmentLifecycleRequest,
		now: string,
		options: {
			status: 'returned' | 'completed' | 'failed' | 'cancelled';
			allowExpiredLease?: boolean;
			timestampColumn: 'returned_at' | 'completed_at' | 'failed_at';
			defaultCode: string;
			defaultReason: string | null;
			metadata?: JsonRecord;
			assignmentResult?: AssignmentResult | null;
			reviewDisposition?: 'approved' | 'request-changes' | null;
		},
		transaction?: CapacityGovernanceDatabase,
	): Promise<ProviderAssignmentLifecycleMutationResult | null> {
		const transitionMetadata = options.metadata ?? (['completed','failed','cancelled'].includes(options.status)
			? { ...record(assignment.metadata), operationalState: options.status }
			: null);
		const metadataWrite = transitionMetadata ? ', metadata_json = ?' : '';
		const settledUsage = assignment.reservationId && options.status !== 'returned'
			? await this.store.first(`SELECT active_seconds, elapsed_seconds, input_tokens, cached_input_tokens, reasoning_tokens, output_tokens, actual_usd FROM capacity_usage_actuals WHERE id = ? AND assignment_id = ? AND accounting_mode = 'aggregate' LIMIT 1`, [`usage:${assignment.id}:${assignment.attemptCount}:aggregate`, assignment.id]) : null;
		const performance = options.status === 'returned' ? input.performance ?? null : terminalPerformance(assignment, input, options.status==='completed'?'completed':'failed', now, record(settledUsage));
		// The validated TreeDX work-review decision is the disposition authority.
		// Persist it with the lifecycle output so review-cycle accounting never
		// depends on a provider repeating that decision in its raw response.
		const lifecycleOutput = composeAssignmentLifecycleOutput(record(input), performance, options.reviewDisposition);
		const params: unknown[] = [
			input.runnerId ?? null,
			now,
			input.reason ?? input.message ?? options.defaultReason,
			input.code ?? options.defaultCode,
			JSON.stringify(lifecycleOutput),
		];
		if (transitionMetadata) params.push(JSON.stringify(transitionMetadata));
		params.push(
			now, assignment.id, principal.teamId, principal.capacityProviderId, principal.membershipId,
			assignment.stateVersion, input.leaseToken ?? null, ...(options.allowExpiredLease ? [] : [now]),
		);
		const operations = [{ query: `UPDATE capacity_provider_assignments
			 SET status = ?, lease_state = 'released', lease_token = NULL, lease_expires_at = NULL,
			     lease_renewed_at = NULL, runner_id = COALESCE(?, runner_id), ${options.timestampColumn} = ?,
			     lifecycle_reason = ?, lifecycle_code = ?, lifecycle_output_json = ?${metadataWrite},
			     state_version = state_version + 1, updated_at = ?
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ? AND membership_id = ?
			   AND state_version = ? AND status = 'leased' AND lease_state = 'leased'
			   AND lease_token = ? ${options.allowExpiredLease ? '' : 'AND (lease_expires_at IS NULL OR lease_expires_at > ?)'} `, params: [options.status, ...params] }];
		if (['completed','failed','cancelled'].includes(options.status)) {
			const workspaceId = record(assignment.treedxProxyHandle).workspaceId ?? record(assignment.workspaceContext).workspaceId;
			if (workspaceId) {
				if (!this.store.config || !this.store.getProjectTreeDxLibrary) throw new CapacityGovernanceError(
					'assignment_terminal_workspace_cleanup_unavailable', 'Owned workspace closure requires its authoritative library binding.', 503);
				await closeTerminalAssignmentWorkspace({ config: this.store.config,
					getProjectTreeDxLibrary: this.store.getProjectTreeDxLibrary.bind(this.store) }, assignment);
			}
			const terminalWorkspace = terminalAssignmentAuthority(assignment, now);
			operations.push({
				query: `UPDATE treedx_proxy_handles SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
				 WHERE assignment_id = ? AND team_id = ?
				   AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND status = ? AND state_version = ?)`,
				params: [now, now, assignment.id, principal.teamId, assignment.id, principal.teamId, options.status, assignment.stateVersion + 1],
			});
			operations.push({
				query: `UPDATE capacity_provider_assignments SET treedx_proxy_handle_json = ?, workspace_context_json = ?
				 WHERE id = ? AND team_id = ? AND status = ? AND state_version = ?`,
				params: [JSON.stringify(terminalWorkspace.proxyHandle), JSON.stringify(terminalWorkspace.workspaceContext), assignment.id, principal.teamId, options.status, assignment.stateVersion + 1],
			});
			if (options.status !== 'completed' && assignment.invocationId) operations.push({
				query: `UPDATE agent_invocation_requests SET status=?, assignment_id=?, completed_at=COALESCE(completed_at,?), blocking_state_json=?, updated_at=? WHERE id=? AND team_id=? AND status IN ('admitted','running')`,
				params: [options.status==='cancelled'?'cancelled':'failed',assignment.id, now, JSON.stringify({ code: input.code ?? options.defaultCode, reason: input.reason ?? input.message ?? options.defaultReason }), now, assignment.invocationId, assignment.teamId],
			});
		}
		const committed = await commitLivingExecutionLifecycle({ store: this.store, assignment,
			status: options.status, now, result: options.assignmentResult,
			returnCode: options.status === 'returned' ? input.code ?? undefined : undefined,
			reviewDisposition: options.reviewDisposition ?? null }, operations, transaction);
		if (!committed) return null;
		const transitioned = await this.store.getProviderAssignment(principal.teamId, assignment.id);
		if (!transitioned || transitioned.stateVersion !== assignment.stateVersion + 1 || transitioned.status !== options.status) return null;
		if (assignment.operationHandoffId && (options.status === 'completed' || options.status === 'failed')) await terminalizeOperationHandoff(this.store, assignment.operationHandoffId, assignment.id, options.status, now);
		return { assignment: transitioned, leaseToken: null, leaseSeconds: null };
	}
}
