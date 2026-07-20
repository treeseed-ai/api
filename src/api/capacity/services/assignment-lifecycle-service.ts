import type {
	ProviderAssignmentExplanation,
	ProviderAssignmentLifecycleRequest,
} from '@treeseed/sdk/agent-capacity';
import { classifyCapacityFailure } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import type { DurableProviderAssignment } from '../repositories/assignment.ts';
import type { ProviderAssignmentExplanationWrite } from './assignment-explanation-service.ts';
import { normalizeProviderAssignmentLeaseSeconds } from './assignment-lease-service.ts';
import {
	evaluateProviderAssignmentLeaseAuthority,
	type ProviderLeasePrincipal,
} from './lease-authority-service.ts';
import { settleCapacityReservationExactlyOnce } from './settlement-service.ts';
import { projectCompletedAssignmentDeliverable, type AssignmentDeliverableStore } from './assignment-deliverable-service.ts';
import { projectCompletedResearchWorkflow, type ResearchWorkflowProjectionStore } from './research-workflow-projection-service.ts';
import { projectCompletedPlanningOutputs, type AssignmentPlanningOutputStore } from './assignment-planning-output-service.ts';

type JsonRecord = Record<string, unknown>;

export interface ExtendedProviderAssignmentLifecycleRequest extends ProviderAssignmentLifecycleRequest {
	actualCredits?: number | null;
	actualUsd?: number | null;
	providerUnits?: number | null;
	usage?: JsonRecord | null;
}

interface ProviderAssignmentLifecycleStore extends CapacityGovernanceDatabase, AssignmentDeliverableStore, AssignmentPlanningOutputStore, ResearchWorkflowProjectionStore {
	getProviderAssignment(teamId: string, assignmentId: string): Promise<DurableProviderAssignment | null>;
	recordAgentFallbackOutput(input: JsonRecord): Promise<unknown>;
	recordProviderAssignmentExplanation(
		teamId: string,
		assignmentId: string,
		input: ProviderAssignmentExplanationWrite,
	): Promise<ProviderAssignmentExplanation | null>;
}

export interface ProviderAssignmentLifecycleMutationResult {
	assignment: DurableProviderAssignment;
	leaseToken: string | null;
	leaseSeconds: number | null;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function revokeCapabilityHandles(value: unknown, now: string): JsonRecord {
	const handles = record(value);
	const revoke = (entries: unknown) => Array.isArray(entries)
		? entries.map((entry) => ({ ...record(entry), status: 'revoked', revokedAt: now }))
		: [];
	return {
		...handles,
		repository: revoke(handles.repository),
		treeDx: revoke(handles.treeDx),
		workflowOperations: revoke(handles.workflowOperations),
		secrets: revoke(handles.secrets),
	};
}

function terminalWorkspaceProjection(assignment: DurableProviderAssignment, now: string) {
	const proxyHandle = { ...record(assignment.treedxProxyHandle), status: 'revoked', revokedAt: now };
	const workspaceContext = record(assignment.workspaceContext);
	return {
		proxyHandle,
		workspaceContext: {
			...workspaceContext,
			treedxProxyHandle: proxyHandle,
			capabilityHandles: revokeCapabilityHandles(assignment.capabilityHandles ?? workspaceContext.capabilityHandles, now),
		},
	};
}

function optionalFiniteNumber(value: unknown, field: string): number | null {
	if (value == null || value === '') return null;
	const parsed = Number(value);
	if (Number.isFinite(parsed)) return parsed;
	throw new CapacityGovernanceError(
		'provider_assignment_usage_invalid',
		`${field} must be a finite number.`,
		400,
		{ field },
	);
}

function activeLeaseOwnedBy(
	assignment: DurableProviderAssignment | null,
	principal: ProviderLeasePrincipal,
	leaseToken: string | null | undefined,
	now: string,
): assignment is DurableProviderAssignment {
	return Boolean(
		assignment
		&& assignment.capacityProviderId === principal.capacityProviderId
		&& assignment.membershipId === principal.membershipId
		&& assignment.status === 'leased'
		&& assignment.leaseState === 'leased'
		&& assignment.leaseToken
		&& assignment.leaseToken === leaseToken
		&& (!assignment.leaseExpiresAt || Date.parse(assignment.leaseExpiresAt) > Date.parse(now)),
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
		const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
		await this.store.run(
			`UPDATE capacity_provider_assignments
			 SET lease_expires_at = ?, lease_renewed_at = ?, runner_id = COALESCE(?, runner_id),
			     state_version = state_version + 1, updated_at = ?
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ? AND membership_id = ?
			   AND state_version = ? AND status = 'leased' AND lease_state = 'leased'
			   AND lease_token = ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
			[
				leaseExpiresAt, now, input.runnerId ?? null, now, assignment.id, principal.teamId,
				principal.capacityProviderId, principal.membershipId, assignment.stateVersion, input.leaseToken, now,
			],
		);
		const renewed = await this.store.getProviderAssignment(principal.teamId, assignment.id);
		if (!renewed || renewed.stateVersion !== assignment.stateVersion + 1 || renewed.leaseToken !== input.leaseToken) {
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
		if (!activeLeaseOwnedBy(assignment, principal, input.leaseToken, now)) return null;
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
		if (assignment.reservationId) {
			const reservation = await this.store.first(
				`SELECT state FROM capacity_reservations WHERE id = ? AND team_id = ? AND membership_id = ? AND assignment_id = ? LIMIT 1`,
				[assignment.reservationId, principal.teamId, principal.membershipId, assignment.id],
			);
			if (!reservation || reservation.state !== 'consumed') return null;
		}
		await projectCompletedPlanningOutputs(this.store, assignment, input as JsonRecord);
		await projectCompletedResearchWorkflow(this.store, assignment, input as JsonRecord);
		await projectCompletedAssignmentDeliverable(this.store, assignment, input as JsonRecord);
		return this.transition(principal, assignment, input, now, {
			status: 'completed',
			timestampColumn: 'completed_at',
			defaultCode: 'provider_assignment_completed',
			defaultReason: null,
		});
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
		const now = new Date().toISOString();
		const assignment = await this.store.getProviderAssignment(principal.teamId, assignmentId);
		if (!activeLeaseOwnedBy(assignment, principal, input.leaseToken, now)) return null;
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
				actualCredits: Math.max(0, Number(input.actualCredits ?? usage.actualCredits ?? 0)),
				providerUnits: optionalFiniteNumber(input.providerUnits ?? usage.providerUnits, 'providerUnits'),
				usd: optionalFiniteNumber(input.actualUsd ?? usage.actualUsd, 'actualUsd'),
				modeRunId: input.modeRunId ?? null,
				source: 'provider_assignment_fail',
				existingSettlementPolicy: 'replay',
				metadata: { reason: input.reason ?? input.message ?? null, code: input.code ?? 'provider_assignment_failed' },
			});
		}
		return this.transition(principal, assignment, input, now, {
			status: 'failed',
			timestampColumn: 'failed_at',
			defaultCode: 'provider_assignment_failed',
			defaultReason: 'Provider assignment failed.',
			metadata: { ...record(assignment.metadata), failureClassification: failure },
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
			status: 'returned' | 'completed' | 'failed';
			timestampColumn: 'returned_at' | 'completed_at' | 'failed_at';
			defaultCode: string;
			defaultReason: string | null;
			metadata?: JsonRecord;
		},
	): Promise<ProviderAssignmentLifecycleMutationResult | null> {
		const metadataWrite = options.metadata ? ', metadata_json = ?' : '';
		const params: unknown[] = [
			input.runnerId ?? null,
			now,
			input.reason ?? input.message ?? options.defaultReason,
			input.code ?? options.defaultCode,
			JSON.stringify(record(input.output ?? input.summary)),
		];
		if (options.metadata) params.push(JSON.stringify(options.metadata));
		params.push(
			now, assignment.id, principal.teamId, principal.capacityProviderId, principal.membershipId,
			assignment.stateVersion, input.leaseToken ?? null, now,
		);
		const operations = [{ query: `UPDATE capacity_provider_assignments
			 SET status = ?, lease_state = 'released', lease_token = NULL, lease_expires_at = NULL,
			     lease_renewed_at = NULL, runner_id = COALESCE(?, runner_id), ${options.timestampColumn} = ?,
			     lifecycle_reason = ?, lifecycle_code = ?, lifecycle_output_json = ?${metadataWrite},
			     attempt_count = attempt_count + 1, state_version = state_version + 1, updated_at = ?
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ? AND membership_id = ?
			   AND state_version = ? AND status = 'leased' AND lease_state = 'leased'
			   AND lease_token = ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)`, params: [options.status, ...params] }];
		if (options.status === 'completed' || options.status === 'failed') {
			const terminalWorkspace = terminalWorkspaceProjection(assignment, now);
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
			const demandStatus = options.status === 'completed' ? 'completed' : 'blocked';
			operations.push({
				query: `UPDATE capacity_workday_demands SET status = ?, completed_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'admitted'`,
				params: [demandStatus, now, now, assignment.id],
			});
			operations.push({
				query: `UPDATE capacity_workday_participation_entries SET status = ?, reason_code = ?, covered_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'assigned'`,
				params: [demandStatus, options.status === 'failed' ? input.code ?? options.defaultCode : null, now, now, assignment.id],
			});
		}
		await this.store.batch(operations);
		const transitioned = await this.store.getProviderAssignment(principal.teamId, assignment.id);
		if (!transitioned || transitioned.stateVersion !== assignment.stateVersion + 1 || transitioned.status !== options.status) return null;
		return { assignment: transitioned, leaseToken: null, leaseSeconds: null };
	}
}
