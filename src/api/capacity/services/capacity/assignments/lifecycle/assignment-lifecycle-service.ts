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
import { projectCompletedResearchWorkflow,type ResearchWorkflowProjectionStore } from '../../../projects/projects-core/research-workflow-projection-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../accounting/settlement-service.ts';
import { projectCompletedAssignmentDeliverable,type AssignmentDeliverableStore } from '../context/assignment-deliverable-service.ts';
import { validateAssignmentResultCompletion } from '../context/assignment-result-completion.ts';
import { resolveProposalReviewDisposition, resolveReviewDisposition } from '../context/review-result.ts';
import { livingExecutionLifecycleOperations } from './execution/living-execution-lifecycle.ts';
import type { ProviderAssignmentExplanationWrite } from '../observability/assignment-explanation-service.ts';
import { projectCompletedPlanningOutputs,type AssignmentPlanningOutputStore } from '../planning/assignment-planning-output-service.ts';
import { normalizeProviderAssignmentLeaseSeconds } from './assignment-lease-service.ts';
import { terminalAssignmentAuthority } from './assignment-terminal-authority.ts';
import { composeAssignmentLifecycleOutput } from './assignment-lifecycle-output.ts';
import { closeSuspendedConversationExecution } from './assignment-discussion-suspension-service.ts';
import { terminalizeOperationHandoff } from '../handoffs/operation-handoff-lifecycle-service.ts';
import { archivedConversationCancellation } from './assignment-failure-policy.ts';
import { contentIntegrationRequirementOperation } from './assignment-content-integration-requirement.ts';
import { semanticCompletionPreflightRequired } from './assignment-completion-preflight-service.ts';
import { assertAssignmentCompletionEvidence } from './completion/assignment-completion-evidence.ts';
import { quarantineContextOverflowOffer } from './context-capacity/overflow.ts';
import { optionalFiniteNumber,record,terminalPerformance,type ExtendedProviderAssignmentLifecycleRequest,type JsonRecord } from './completion/assignment-terminal-performance.ts';
export type { ExtendedProviderAssignmentLifecycleRequest } from './completion/assignment-terminal-performance.ts';
interface ProviderAssignmentLifecycleStore extends CapacityGovernanceDatabase, AssignmentDeliverableStore, AssignmentPlanningOutputStore, ResearchWorkflowProjectionStore {
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
		const now = new Date().toISOString();
		const assignment = await this.store.getProviderAssignment(principal.teamId, assignmentId);
		if (assignment?.status === 'returned' && assignment.leaseState === 'released'
			&& record(assignment.metadata).operationalState === 'suspended'
			&& assignment.lifecycleCode === 'discussion_response_required') {
			if (assignment.capacityProviderId !== principal.capacityProviderId || assignment.membershipId !== principal.membershipId) return null;
			const existing = record(assignment.lifecycleOutput);
			const observed = composeAssignmentLifecycleOutput(record(input), input.performance ?? existing.performance ?? null);
			const merged = { ...existing, ...observed };
			if (JSON.stringify(existing) === JSON.stringify(merged)) {
				await closeSuspendedConversationExecution(this.store,assignment,now);
				return { assignment, leaseToken: null, leaseSeconds: null };
			}
			await this.store.run(
				`UPDATE capacity_provider_assignments SET lifecycle_output_json = ?, state_version = state_version + 1, updated_at = ?
				 WHERE id = ? AND team_id = ? AND capacity_provider_id = ? AND membership_id = ? AND state_version = ?
				   AND status = 'returned' AND lease_state = 'released' AND lifecycle_code = 'discussion_response_required'`,
				[JSON.stringify(merged), now, assignment.id, assignment.teamId, assignment.capacityProviderId, assignment.membershipId, assignment.stateVersion],
			);
			const repaired = await this.store.getProviderAssignment(principal.teamId, assignmentId);
			if (!repaired || repaired.stateVersion !== assignment.stateVersion + 1 || repaired.status !== 'returned') return null;
			await closeSuspendedConversationExecution(this.store,repaired,now);
			return { assignment: repaired, leaseToken: null, leaseSeconds: null };
		}
		if (!activeLeaseOwnedBy(assignment, principal, input.leaseToken, now)) return null;
		const contextCapacityAlert=await quarantineContextOverflowOffer({store:this.store,assignment,code:input.code,observedAt:now});
		if (record(assignment.metadata).cancellationRequested === true) {
			return this.transition(principal, assignment, input, now, {
				status: 'cancelled', timestampColumn: 'failed_at', defaultCode: 'operator_cancelled', defaultReason: String(record(assignment.metadata).cancellationReason ?? 'Assignment cancelled by a team operator.'),
				metadata: { ...record(assignment.metadata), operationalState: 'cancelled', cancelledAt: now },
			});
		}
		const completionInput = Object.keys(record(input.completion)).length ? input : { ...input, completion: { disposition: 'completed' } };
		assertAssignmentCompletionEvidence(completionInput);
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
		const nextAttemptCount = Number(assignment.attemptCount ?? 0) + 1;
		if (nextAttemptCount >= maxAttempts) {
			return this.fail(principal, assignmentId, {
				...input,
				retryable: false,
				code: 'provider_assignment_retry_exhausted',
				reason: `Provider assignment exhausted its retry policy after ${nextAttemptCount} attempts.`,
				message: `Provider assignment exhausted its retry policy after ${nextAttemptCount} attempts.`,
				output: {
					...record(input.output ?? input.summary),
					retryPolicy: {
						originalCode: input.code ?? null,
						originalReason: input.reason ?? input.message ?? null,
						attemptCount: nextAttemptCount,
						maxAttempts,
					},
				},
				metadata: {
					...record(input.metadata),
					originalCode: input.code ?? null,
					originalReason: input.reason ?? input.message ?? null,
					attemptCount: nextAttemptCount,
					maxAttempts,
				},
			});
		}
		if (input.fallbackOutput) await this.persistFallback(assignment, input.fallbackOutput);
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
		return this.transition(principal, assignment, completionInput, now, {
			status: 'returned',
			timestampColumn: 'returned_at',
			defaultCode: 'provider_assignment_returned',
			defaultReason: null,
			metadata,
		});
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
		const terminalInput = Object.keys(record(input.completion)).length ? input : { ...input, completion: { disposition: 'completed' } };
		const semanticReceipt=String(record(terminalInput.metadata).semanticCompletionPreflightReceiptDigest??'');
		const semanticPreflight=assignment.assignmentAttempt ? true : semanticCompletionPreflightRequired(assignment,terminalInput)&&/^[a-f0-9]{64}$/u.test(semanticReceipt)?await this.store.first(`SELECT id FROM capacity_workday_events WHERE id = ? AND assignment_id = ? AND team_id = ? AND event_type = 'assignment.semantic_completion_preflight_passed' LIMIT 1`,[`semantic-preflight:${assignment.id}:${semanticReceipt.slice(0,20)}`,assignment.id,assignment.teamId]):!semanticCompletionPreflightRequired(assignment,terminalInput);
		if(!semanticPreflight)throw new CapacityGovernanceError('assignment_semantic_completion_preflight_required','Artifact-producing assignment completion requires a durable semantic preflight before settlement.',409,{assignmentId:assignment.id});
		if (assignment.reservationId) {
			const reservation = await this.store.first(
				`SELECT state FROM capacity_reservations WHERE id = ? AND team_id = ? AND membership_id = ? AND assignment_id = ? LIMIT 1`,
				[assignment.reservationId, principal.teamId, principal.membershipId, assignment.id],
			);
			if (!reservation || reservation.state !== 'consumed') return null;
		}
		await assertRequiredSignals(this.store, assignment);
		await assertCommunicationOutcome(this.store, assignment);
		const assignmentResult = assignment.assignmentAttempt
			? validateAssignmentResultCompletion(assignment, terminalInput as JsonRecord)
			: null;
		const reviewDisposition = assignmentResult
			? await resolveReviewDisposition(this.store, assignment, assignmentResult)
			: null;
		const proposalReview = assignmentResult
			? await resolveProposalReviewDisposition(this.store, assignment, assignmentResult)
			: null;
		if (!assignment.assignmentAttempt) {
			await projectCompletedPlanningOutputs(this.store, assignment, input as JsonRecord);
			await projectCompletedResearchWorkflow(this.store, assignment, input as JsonRecord);
			await projectCompletedAssignmentDeliverable(this.store, assignment, input as JsonRecord);
		}
		const completed = await this.transition(principal, assignment, terminalInput, now, {
			status: 'completed',
			timestampColumn: 'completed_at',
			defaultCode: 'provider_assignment_completed',
			defaultReason: null,
			assignmentResult,
			reviewDisposition,
		});
		const reviewedProposalId = assignment.proposalId ?? (assignment.assignmentAttempt?.sourceRef.model === 'proposal'
			? assignment.assignmentAttempt.sourceRef.id : null);
		if (completed && proposalReview && reviewedProposalId) {
			await this.store.recordGovernanceEvent({
				eventType: 'proposal.discussion', actorType: 'agent', actorId: assignment.agentId ?? null,
				teamId: assignment.teamId, projectId: assignment.projectId, proposalId: reviewedProposalId,
				proposalVersion: assignment.assignmentAttempt?.sourceRef.revision ?? null,
				nextState: proposalReview.disposition,
				message: assignmentResult?.summary ?? null,
				evidence: {
					kind: proposalReview.disposition === 'approved' ? 'support' : 'concern',
					feedbackStatus: proposalReview.disposition === 'approved' ? 'resolved' : 'open',
					proposalVersion: assignment.assignmentAttempt?.sourceRef.revision,
					decisionRef: proposalReview.reference,
				},
			});
		}
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
		return capacityTransaction(this.store, async database => {
			await database.run('SELECT id FROM capacity_provider_assignments WHERE id=? AND team_id=? FOR UPDATE', [assignmentId, principal.teamId]);
			const repository = new ProviderAssignmentRepository(database);
			const evidence = new CapacityRuntimeEvidenceRepository(database);
			const overrides = { ...database,
				getProviderAssignment: repository.get.bind(repository),
				recordAgentFallbackOutput: evidence.recordFallbackOutput.bind(evidence) };
			const store = new Proxy(this.store, { get: (target, key) =>
				Reflect.has(overrides, key) ? Reflect.get(overrides, key) : Reflect.get(target, key) });
			return new ProviderAssignmentLifecycleService(store).failTerminal(principal, assignmentId, input, failure);
		});
	}

	private async failTerminal(principal: ProviderLeasePrincipal, assignmentId: string,
		input: ExtendedProviderAssignmentLifecycleRequest, failure: ReturnType<typeof classifyCapacityFailure>) {
		const now = new Date().toISOString();
		const assignment = await this.store.getProviderAssignment(principal.teamId, assignmentId);
		// Expiration ends productive authority, not the current owner's obligation
		// to report its terminal timeout. The row lock prevents recovery taking it.
		const timeout = input.code === 'assignment_timeout';
		if (!activeLeaseOwnedBy(assignment, principal, input.leaseToken, now, timeout)) return null;
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
				modeRunId: input.modeRunId ?? null,
				usageActual: usage,
				source: 'provider_assignment_fail',
				existingSettlementPolicy: 'replay',
				metadata: { reason: input.reason ?? input.message ?? null, code: input.code ?? 'provider_assignment_failed' },
			});
		}
		const archived=archivedConversationCancellation(assignment,input);
		return this.transition(principal, assignment, input, now, {
			status: archived?'cancelled':'failed',
			timestampColumn: 'failed_at',
			defaultCode: archived?'discussion_archived':'provider_assignment_failed',
			defaultReason: archived?'The source Discussion was archived.':'Provider assignment failed.',
			metadata: { ...record(assignment.metadata), failureClassification: failure },
			allowExpiredLease: timeout,
		});
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
	): Promise<ProviderAssignmentLifecycleMutationResult | null> {
		const transitionMetadata = options.metadata ?? (['completed','failed','cancelled'].includes(options.status)
			? { ...record(assignment.metadata), operationalState: options.status }
			: null);
		const metadataWrite = transitionMetadata ? ', metadata_json = ?' : '';
		const performance = options.status === 'returned' ? input.performance ?? null : terminalPerformance(assignment, input, options.status==='completed'?'completed':'failed', now);
		const lifecycleOutput = composeAssignmentLifecycleOutput(record(input), performance);
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
			     attempt_count = attempt_count + 1, state_version = state_version + 1, updated_at = ?
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ? AND membership_id = ?
			   AND state_version = ? AND status = 'leased' AND lease_state = 'leased'
			   AND lease_token = ? ${options.allowExpiredLease ? '' : 'AND (lease_expires_at IS NULL OR lease_expires_at > ?)'} `, params: [options.status, ...params] }];
		operations.push(...await livingExecutionLifecycleOperations({ store: this.store, assignment,
			status: options.status, now, result: options.assignmentResult,
			reviewDisposition: options.reviewDisposition ?? null }));
		if (['completed','failed','cancelled'].includes(options.status)) {
			const integrationRequirement=!assignment.assignmentAttempt && options.status==='completed'?contentIntegrationRequirementOperation({ assignmentId:assignment.id,capacityProviderId:principal.capacityProviderId,stateVersion:assignment.stateVersion+1,lifecycleOutput,now }):null;
			if(integrationRequirement)operations.push(integrationRequirement);
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
			if (!assignment.assignmentAttempt) {
				const demandStatus = options.status === 'completed' ? 'completed' : options.status==='cancelled'?'cancelled':'blocked';
				const participationStatus=options.status==='completed'?'completed':'blocked';
				operations.push({
					query: `UPDATE capacity_workday_demands SET status = ?, completed_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'admitted'`,
					params: [demandStatus, now, now, assignment.id],
				});
				operations.push({
					query: `UPDATE capacity_workday_participation_entries SET status = ?, reason_code = ?, covered_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'assigned'`,
					params: [participationStatus, options.status === 'completed' ? null : input.code ?? options.defaultCode, now, now, assignment.id],
				});
			}
			if (options.status !== 'completed' && assignment.invocationId) operations.push({
				query: `UPDATE agent_invocation_requests SET status=?, assignment_id=?, completed_at=COALESCE(completed_at,?), blocking_state_json=?, updated_at=? WHERE id=? AND team_id=? AND status IN ('admitted','running')`,
				params: [options.status==='cancelled'?'cancelled':'failed',assignment.id, now, JSON.stringify({ code: input.code ?? options.defaultCode, reason: input.reason ?? input.message ?? options.defaultReason }), now, assignment.invocationId, assignment.teamId],
			});
		}
		await this.store.batch(operations);
		const transitioned = await this.store.getProviderAssignment(principal.teamId, assignment.id);
		if (!transitioned || transitioned.stateVersion !== assignment.stateVersion + 1 || transitioned.status !== options.status) return null;
		if (assignment.operationHandoffId && (options.status === 'completed' || options.status === 'failed')) await terminalizeOperationHandoff(this.store, assignment.operationHandoffId, assignment.id, options.status, now);
		return { assignment: transitioned, leaseToken: null, leaseSeconds: null };
	}
}
