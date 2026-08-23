import type { ProviderAssignmentExplanation,ProviderNextAssignmentRequest } from '@treeseed/sdk/agent-capacity';
import { randomUUID } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { ProviderAssignmentRepository,serializeProviderAssignmentRow,type DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import {
evaluateProviderAssignmentLeaseAuthority,
type ProviderLeasePrincipal,
} from '../../../accounts/lease-authority-service.ts';
import { resolveProviderSynthesisContext } from '../../providers/provider-synthesis-context-service.ts';
import {
buildProviderAssignmentExplanation,
type ProviderAssignmentExplanationWrite,
} from '../observability/assignment-explanation-service.ts';
import { recoverExpiredProviderAssignments } from './assignment-recovery-service.ts';
import { beginAssignmentPreparationTimeBudget } from '../planning/assignment-time-budget.ts';
import { markOperationHandoffRunning } from '../handoffs/operation-handoff-lifecycle-service.ts';

type JsonRecord = Record<string, unknown>;

export interface ProviderAssignmentLeaseRequest extends ProviderNextAssignmentRequest {
	providerSessionId?: string | null;
	environment?: string | null;
	source?: string | null;
}

interface ProviderAssignmentLeaseStore extends CapacityGovernanceDatabase {
	synthesizeProviderAssignments(principal: ProviderLeasePrincipal, input: ProviderAssignmentLeaseRequest): Promise<unknown>;
	recordProviderAssignmentExplanation(
		teamId: string,
		assignmentId: string,
		input: ProviderAssignmentExplanationWrite,
	): Promise<ProviderAssignmentExplanation | null>;
}

interface CandidateDiagnostic extends JsonRecord {
	assignmentId: string;
	projectId: string;
	status: string;
	leaseState: string;
	sessionId: string | null;
	reasons: string[];
	eligible: boolean;
	gates: JsonRecord;
	selected: boolean;
}

export interface ProviderAssignmentLeaseResult {
	assignment: DurableProviderAssignment | null;
	leaseToken: string | null;
	leaseSeconds: number;
	diagnostics?: JsonRecord;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function synthesisFailure(error: unknown): JsonRecord {
	const candidate = record(error);
	return {
		status: 'failed',
		code: typeof candidate.code === 'string' && candidate.code ? candidate.code : 'provider_assignment_synthesis_failed',
		message: error instanceof Error ? error.message : String(error),
	};
}

function assignmentWorkdayId(assignment: DurableProviderAssignment): string | null {
	if (assignment.workDayId) return assignment.workDayId;
	const value = record(assignment.capacityEnvelope).workDayId;
	return typeof value === 'string' && value ? value : null;
}

function assignmentPriority(assignment: DurableProviderAssignment): number {
	const priority = Number(record(assignment.metadata).priority ?? record(assignment.explanation).priority ?? 0);
	return Number.isFinite(priority) ? priority : 0;
}

function compareAssignmentsForLease(left: DurableProviderAssignment, right: DurableProviderAssignment): number {
	const priority = assignmentPriority(right) - assignmentPriority(left);
	if (priority !== 0) return priority;
	return String(left.assignedAt ?? left.createdAt ?? left.id).localeCompare(String(right.assignedAt ?? right.createdAt ?? right.id))
		|| String(left.createdAt ?? left.id).localeCompare(String(right.createdAt ?? right.id))
		|| left.id.localeCompare(right.id);
}

function leaseGate(assignment: DurableProviderAssignment): { leasable: boolean; reasons: string[] } {
	if (assignment.status === 'pending' && assignment.leaseState === 'unleased') return { leasable: true, reasons: [] };
	if (assignment.status === 'returned' && assignment.leaseState === 'released') return { leasable: true, reasons: [] };
	const reasons: string[] = [];
	if (!['pending', 'returned'].includes(assignment.status)) reasons.push('status_not_leasable');
	if (!['unleased', 'released'].includes(assignment.leaseState)) reasons.push('lease_state_not_leasable');
	if (!reasons.length) reasons.push('lease_state_not_ready');
	return { leasable: false, reasons };
}

export interface AssignmentLeaseDeadlineGate {
	eligible: boolean;
	hardDeadlineAt: string | null;
	remainingMs: number | null;
	minimumRemainingMs: number;
}

export function evaluateAssignmentLeaseDeadline(
	assignment: Pick<DurableProviderAssignment, 'capacityEnvelope' | 'status'>,
	nowMs: number,
): AssignmentLeaseDeadlineGate {
	const budget = record(record(assignment.capacityEnvelope).budget);
	const time = record(budget.time);
	if (assignment.status === 'pending' && !time.executionStartedAt) {
		return { eligible: true, hardDeadlineAt: null, remainingMs: null, minimumRemainingMs: 0 };
	}
	const parsedDeadline = Date.parse(String(budget.deadline ?? time.hardDeadlineAt ?? ''));
	const closeoutWarningMs = Math.max(0, Number(time.closeoutWarningSeconds ?? 0) * 1000);
	// Fresh work must not begin once mandatory closeout starts. Returned work is
	// different: it may already contain validated, unpublished changes that only
	// need the restricted closeout tools. Re-admit that work while at least one
	// bounded closeout interval remains; the status/tool gates still prohibit new
	// exploration and mutation outside closeout-safe operations.
	const minimumRemainingMs = assignment.status === 'returned'
		? 30_000
		: Number.isFinite(closeoutWarningMs) && closeoutWarningMs > 0
			? Math.max(30_000, closeoutWarningMs)
		: 0;
	if (!Number.isFinite(parsedDeadline)) {
		return { eligible: true, hardDeadlineAt: null, remainingMs: null, minimumRemainingMs };
	}
	const remainingMs = Math.max(0, parsedDeadline - nowMs);
	return {
		eligible: remainingMs > minimumRemainingMs,
		hardDeadlineAt: new Date(parsedDeadline).toISOString(),
		remainingMs,
		minimumRemainingMs,
	};
}

export function normalizeProviderAssignmentLeaseSeconds(value: unknown): number {
	const parsed = Number(value ?? 300);
	if (!Number.isFinite(parsed)) {
		throw new CapacityGovernanceError(
			'provider_assignment_lease_seconds_invalid',
			'Provider assignment leaseSeconds must be a finite number.',
			400,
			{ leaseSeconds: value ?? null },
		);
	}
	return Math.max(30, Math.min(Math.floor(parsed), 3600));
}

export function providerAssignmentQueuePriority(assignment: Pick<DurableProviderAssignment, 'executionKind' | 'communicationOverflow'>): number {
	return assignment.executionKind === 'conversation' && assignment.communicationOverflow === true ? 0 : 1;
}

async function eligibleLeaseCandidates(input:{store:ProviderAssignmentLeaseStore;principal:ProviderLeasePrincipal;request:ProviderAssignmentLeaseRequest;
	assignments:DurableProviderAssignment[];workdayStatuses:Map<string,string>;now:string}) {
	const {store,principal,request,assignments,workdayStatuses,now}=input;
	const workdayWeight = (assignment: DurableProviderAssignment): number => {
		const workdayId = assignmentWorkdayId(assignment); if (!workdayId) return 1;
		const status = workdayStatuses.get(workdayId); if (status === 'active') return 0;
		if (status === 'draft' || status === 'paused') return 2; return status ? 3 : 1;
	};
	const retryWeight = (assignment: DurableProviderAssignment): number => {
		if (assignment.status === 'pending' && assignment.leaseState === 'unleased') return 0;
		if (assignment.status === 'returned' && assignment.leaseState === 'released') return 1;
		return 2;
	};
	const diagnostics: CandidateDiagnostic[] = [];
	const leasable = assignments.filter((assignment) => {
		const laneReasons: string[] = [];
		if (request.laneId && assignment.laneId !== request.laneId) laneReasons.push('lane_id_mismatch');
		if (request.lanePurpose && assignment.lanePurpose !== request.lanePurpose) laneReasons.push('lane_purpose_mismatch');
		if (assignment.executionKind === 'conversation' && assignment.lanePurpose !== 'communication' && assignment.communicationOverflow !== true) laneReasons.push('communication_lane_required');
		if (assignment.executionKind !== 'conversation' && !['platform', 'workday'].includes(String(assignment.lanePurpose))) laneReasons.push('execution_lane_required');
		if (laneReasons.length) {
			diagnostics.push({ assignmentId: assignment.id, projectId: assignment.projectId, status: assignment.status, leaseState: assignment.leaseState,
				sessionId: assignment.providerSessionId ?? null, reasons: laneReasons, eligible: false,
				gates: { requestedLaneId: request.laneId ?? null, requestedLanePurpose: request.lanePurpose ?? null, assignmentLaneId: assignment.laneId, assignmentLanePurpose: assignment.lanePurpose }, selected: false });
			return false;
		}
		const gate = leaseGate(assignment);
		if (!gate.leasable) diagnostics.push({ assignmentId: assignment.id, projectId: assignment.projectId, status: assignment.status,
			leaseState: assignment.leaseState, sessionId: assignment.providerSessionId ?? null, reasons: gate.reasons, eligible: false,
			gates: { leaseExpiresAt: assignment.leaseExpiresAt ?? null, runnerId: assignment.runnerId ?? null }, selected: false });
		return gate.leasable;
	}).sort((left, right) => providerAssignmentQueuePriority(left) - providerAssignmentQueuePriority(right)
		|| workdayWeight(left) - workdayWeight(right) || retryWeight(left) - retryWeight(right) || compareAssignmentsForLease(left, right));
	const eligible: DurableProviderAssignment[] = []; const nowMs=Date.parse(now);
	for (const candidate of leasable) {
		const deadline = evaluateAssignmentLeaseDeadline(candidate, nowMs);
		if (!deadline.eligible) {
			diagnostics.push({ assignmentId: candidate.id, projectId: candidate.projectId, status: candidate.status, leaseState: candidate.leaseState,
				sessionId: candidate.providerSessionId ?? null, reasons: ['assignment_hard_deadline_closeout_window'], eligible: false,
				gates: { assignmentDeadline: deadline }, selected: false });
			continue;
		}
		const authority = await evaluateProviderAssignmentLeaseAuthority(store, principal, candidate.id, now);
		diagnostics.push({ assignmentId: candidate.id, projectId: candidate.projectId, status: candidate.status, leaseState: candidate.leaseState,
			sessionId: authority.sessionId ?? candidate.providerSessionId ?? null, reasons: authority.eligible ? [] : authority.reasons,
			eligible: authority.eligible, gates: authority.gates, selected: authority.eligible && eligible.length === 0 });
		if (authority.eligible) eligible.push({ ...candidate, metadata: { ...record(candidate.metadata),
			eligibility: { selected: true, reasons: authority.reasons, gates: authority.gates, evaluatedAt: now } } });
	}
	return {leasable,diagnostics,assignment:eligible[0]};
}

export async function leaseNextProviderAssignment(
	store: ProviderAssignmentLeaseStore,
	principal: ProviderLeasePrincipal,
	input: ProviderAssignmentLeaseRequest = {},
): Promise<ProviderAssignmentLeaseResult> {
	await store.ensureInitialized();
	const leaseSeconds = normalizeProviderAssignmentLeaseSeconds(input.leaseSeconds);
	const now = new Date().toISOString();
	const context = await resolveProviderSynthesisContext(store, principal, { ...input, now });
	// Admission and leasing are separate durable boundaries. A pending assignment
	// may already occupy the requested lane, so failure to synthesize additional
	// work must never prevent that exact assignment from being leased.
	let synthesis: JsonRecord = { status: 'completed' };
	try {
		await store.synthesizeProviderAssignments(principal, {
			...input,
			sessionId: context.session.id,
			source: input.source ?? 'provider_lease_poll',
		});
	} catch (error) {
		synthesis = synthesisFailure(error);
	}
	const recovery = await recoverExpiredProviderAssignments(store, { teamId: principal.teamId, providerId: principal.capacityProviderId, now, limit: 100 });
	const rows = await store.all(
		`SELECT * FROM capacity_provider_assignments
		 WHERE team_id = ? AND capacity_provider_id = ?
		   AND status IN ('pending', 'returned')
		 ORDER BY assigned_at ASC, created_at ASC, id ASC
		 LIMIT 1000`,
		[principal.teamId, principal.capacityProviderId],
	);
	const assignments = rows.map((row) => serializeProviderAssignmentRow(row) as DurableProviderAssignment);
	const workdayIds = [...new Set(assignments.map(assignmentWorkdayId).filter((id): id is string => Boolean(id)))];
	const workdayStatuses = new Map<string, string>();
	if (workdayIds.length) {
		const workdayRows = await store.all(
			`SELECT id, status FROM workday_capacity_envelopes WHERE id IN (${workdayIds.map(() => '?').join(', ')})`,
			workdayIds,
		);
		for (const row of workdayRows) {
			if (row.id) workdayStatuses.set(String(row.id), String(row.status ?? ''));
		}
	}
	const nowMs = Date.parse(now);
	const {leasable,diagnostics,assignment}=await eligibleLeaseCandidates({store,principal,request:input,assignments,workdayStatuses,now});
	const leaseDiagnostics: JsonRecord = {
		source: 'lease_next_assignment',
		evaluatedAt: now,
		teamId: principal.teamId,
		capacityProviderId: principal.capacityProviderId,
		sessionId: context.session.id,
		environment: context.environment,
		totals: {
			candidates: assignments.length,
			leasable: leasable.length,
			selected: assignment ? 1 : 0,
			skipped: Math.max(0, diagnostics.filter((candidate) => !candidate.selected).length),
		},
		candidates: diagnostics,
		recovery,
		synthesis,
	};
	for (const candidate of diagnostics) {
		if (candidate.selected) continue;
		await store.recordProviderAssignmentExplanation(principal.teamId, candidate.assignmentId, {
			source: 'lease_next_assignment',
			sourceId: candidate.assignmentId,
			eligible: candidate.eligible,
			reasons: candidate.reasons.length
				? candidate.reasons
				: candidate.eligible ? ['eligible_candidate_not_selected'] : ['assignment_not_eligible'],
			gates: candidate.gates,
			metadata: {
				evaluatedAt: now,
				diagnosticsSource: 'provider_lease_attempt',
				leaseAttempt: { sessionId: context.session.id, totals: leaseDiagnostics.totals },
			},
		});
	}
	if (!assignment) {
		leaseDiagnostics.synthesis = { ...synthesis, attempted: true, reason: 'no_assignment_selected', mode: 'request_scoped_api_owned' };
		return { assignment: null, leaseToken: null, leaseSeconds, diagnostics: leaseDiagnostics };
	}
	const leaseToken = randomUUID();
	const leasedCapacityEnvelope = assignment.status === 'pending'
		? beginAssignmentPreparationTimeBudget(record(assignment.capacityEnvelope), now)
		: assignment.capacityEnvelope;
	const assignmentDeadline = evaluateAssignmentLeaseDeadline({ ...assignment, capacityEnvelope: leasedCapacityEnvelope }, nowMs);
	const hardDeadlineMs = assignmentDeadline.hardDeadlineAt
		? Date.parse(assignmentDeadline.hardDeadlineAt)
		: Number.POSITIVE_INFINITY;
	const leaseExpiresAt = new Date(Math.min(nowMs + leaseSeconds * 1000, hardDeadlineMs)).toISOString();
	const selectedExplanation = buildProviderAssignmentExplanation(assignment, principal.teamId, {
		source: String(record(assignment.explanation).source ?? assignment.synthesizedFrom ?? 'lease_next_assignment'),
		sourceId: record(assignment.explanation).sourceId as string | null | undefined ?? assignment.synthesisKey ?? assignment.id,
		eligible: true,
		reasons: Array.isArray(record(assignment.explanation).reasons) && (record(assignment.explanation).reasons as unknown[]).length
			? record(assignment.explanation).reasons as unknown[]
			: ['assignment_selected_for_lease'],
		gates: { ...record(record(assignment.explanation).gates), leaseState: 'leased', runnerId: input.runnerId ?? null },
		metadata: { evaluatedAt: now, diagnosticsSource: 'provider_assignment_lease_selected' },
	}, now);
	await store.run(
		`UPDATE capacity_provider_assignments
		 SET status = 'leased', lease_state = 'leased', lease_token = ?, lease_expires_at = ?,
		     lease_renewed_at = ?, runner_id = ?, provider_session_id = COALESCE(?, provider_session_id),
		     state_version = state_version + 1, claimed_at = COALESCE(claimed_at, ?), metadata_json = ?, capacity_envelope_json = ?,
		     explanation_json = ?, updated_at = ?
		 WHERE id = ? AND team_id = ? AND capacity_provider_id = ? AND membership_id = ? AND state_version = ?
		   AND ((status = 'pending' AND lease_state = 'unleased')
		     OR (status = 'returned' AND lease_state = 'released'))`,
		[
			leaseToken, leaseExpiresAt, now, input.runnerId ?? null, context.session.id, now,
			JSON.stringify(assignment.metadata ?? {}), JSON.stringify(leasedCapacityEnvelope), JSON.stringify(selectedExplanation), now,
			assignment.id, principal.teamId, principal.capacityProviderId, principal.membershipId,
			assignment.stateVersion,
		],
	);
	const leased = await new ProviderAssignmentRepository(store).get(principal.teamId, assignment.id);
	if (!leased || leased.leaseToken !== leaseToken || (input.runnerId && leased.runnerId !== input.runnerId)) {
		return {
			assignment: null,
			leaseToken: null,
			leaseSeconds,
			diagnostics: {
				...leaseDiagnostics,
				totals: { ...record(leaseDiagnostics.totals), selected: 0 },
				candidates: diagnostics.map((candidate) => candidate.assignmentId === assignment.id
					? {
						...candidate,
						selected: false,
						reasons: [...new Set([...candidate.reasons, 'lease_race_lost'])],
						gates: {
							...candidate.gates,
							leaseRace: {
								expectedRunnerId: input.runnerId ?? null,
								actualRunnerId: leased?.runnerId ?? null,
								expectedLeaseToken: '<redacted>',
								actualLeaseToken: leased?.leaseToken ? '<redacted>' : null,
							},
						},
					}
					: candidate),
			},
		};
	}
	if (leased.operationHandoffId) await markOperationHandoffRunning(store, leased.operationHandoffId, leased.id, now);
	return { assignment: leased, leaseToken, leaseSeconds };
}
