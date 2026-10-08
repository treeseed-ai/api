import type { ProviderAssignmentExplanation,ProviderNextAssignmentRequest } from '@treeseed/sdk/agent-capacity';
import { createHash, randomUUID } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { ProviderAssignmentRepository,serializeProviderAssignmentRow,advanceAssignmentAttemptLifecycle,type DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
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
import { redactSensitiveValue } from '../../../../../../security/redact-sensitive-value.ts';

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
		...(Object.keys(record(candidate.details)).length ? { details: record(candidate.details) } : {}),
	};
}

async function recordSynthesisDiagnostic(
	store: ProviderAssignmentLeaseStore,
	principal: ProviderLeasePrincipal,
	sessionId: string,
	diagnostic: JsonRecord,
	now: string,
): Promise<void> {
	const sanitized = redactSensitiveValue(diagnostic);
	const digest = createHash('sha256').update(JSON.stringify(sanitized)).digest('hex').slice(0, 32);
	const failed = diagnostic.status === 'failed';
	const action = failed ? 'provider-assignment.synthesis-failed' : 'provider-assignment.synthesis-completed';
	await store.run(
		`INSERT INTO capacity_audit_events
		 (id, team_id, capacity_provider_id, membership_id, actor_type, actor_id, action, resource_type, resource_id, request_id, idempotency_key, metadata_json, created_at)
		 VALUES (?, ?, ?, ?, 'service', 'provider-assignment-synthesis', ?, 'capacity-provider-availability-session', ?, NULL, ?, ?, ?)
		 ON CONFLICT DO NOTHING`,
		[
			`audit:provider-synthesis:${sessionId}:${digest}`,
			principal.teamId,
			principal.capacityProviderId,
			principal.membershipId,
			action,
			sessionId,
			`provider-synthesis:${sessionId}:${digest}`,
			JSON.stringify(sanitized),
			now,
		],
	);
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
	if (assignment.status === 'returned' && assignment.leaseState === 'released') {
		return { leasable: true, reasons: [] };
	}
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
	assignment: { capacityEnvelope: unknown; status: DurableProviderAssignment['status'] },
	nowMs: number,
): AssignmentLeaseDeadlineGate {
	const budget = record(record(assignment.capacityEnvelope).budget);
	const time = record(budget.time);
	const preparing = assignment.status === 'pending' && !time.executionStartedAt;
	const clocks = [budget.deadline, time.hardDeadlineAt, time.authorityDeadlineAt];
	if (!Number.isFinite(nowMs) || clocks.some(value => typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value)))) {
		return { eligible: false, hardDeadlineAt: null, remainingMs: null, minimumRemainingMs: 0 };
	}
	const parsedDeadline = Math.min(...clocks.map(value => Date.parse(String(value))));
	const closeoutWarningMs = Math.max(0, Number(time.closeoutWarningSeconds ?? 0) * 1000);
	// Fresh work must not begin once mandatory closeout starts. Returned work is
	// different: it may already contain validated, unpublished changes that only
	// need the restricted closeout tools. Re-admit that work while at least one
	// bounded closeout interval remains; the status/tool gates still prohibit new
	// exploration and mutation outside closeout-safe operations.
	const minimumRemainingMs = preparing ? 0 : assignment.status === 'returned'
		? 30_000
		: Number.isFinite(closeoutWarningMs) && closeoutWarningMs > 0
			? Math.max(30_000, closeoutWarningMs)
		: 0;
	if (!Number.isFinite(parsedDeadline)) {
		return { eligible: false, hardDeadlineAt: null, remainingMs: null, minimumRemainingMs };
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
	const parsed = value === undefined ? 300 : value;
	if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
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
	assignments:DurableProviderAssignment[];workdayStatuses:Map<string,string>;now:string;availabilitySessionId:string}) {
	const {store,principal,request,assignments,workdayStatuses,now}=input;
	const workdayWeight = (assignment: DurableProviderAssignment): number => {
		const workdayId = assignmentWorkdayId(assignment); if (!workdayId) return 1;
		const status = workdayStatuses.get(workdayId); if (status === 'running') return 0;
		if (status === 'queued') return 2; return status ? 3 : 1;
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
		const authority = await evaluateProviderAssignmentLeaseAuthority(store, principal, candidate.id, now, input.availabilitySessionId);
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
	let now = new Date().toISOString();
	let context = await resolveProviderSynthesisContext(store, principal, { ...input, now });
	// Admission and leasing are separate durable boundaries. A pending assignment
	// may already occupy the requested lane, so failure to synthesize additional
	// work must never prevent that exact assignment from being leased.
	let synthesis: JsonRecord = { status: 'completed' };
	try {
		const synthesized = record(await store.synthesizeProviderAssignments(principal, {
			...input,
			sessionId: context.session.id,
			source: input.source ?? 'provider_lease_poll',
		}));
		synthesis = { status: 'completed', ...record(synthesized.diagnostics) };
	} catch (error) {
		synthesis = synthesisFailure(error);
	}
	// Synthesis may consume or withdraw the original availability authority.
	// Re-read it with the current clock before any subsequent lease-state write;
	// never backdate recovery or explanations to the poll's initial observation.
	now = new Date().toISOString();
	context = await resolveProviderSynthesisContext(store, principal, { ...input, sessionId: context.session.id, now });
	await recordSynthesisDiagnostic(store, principal, context.session.id, synthesis, now);
	const recovery = await recoverExpiredProviderAssignments(store, { teamId: principal.teamId, providerId: principal.capacityProviderId, now, limit: 100 });
	const executionProviderIds = context.executionProviders.filter(provider => provider.status === 'available').map(provider => provider.id);
	const rows = await store.all(
		`SELECT * FROM capacity_provider_assignments
		 WHERE team_id = ? AND capacity_provider_id = ?
		   AND status IN ('pending', 'returned')
		   AND execution_provider_id IN (${executionProviderIds.map(() => '?').join(', ') || 'NULL'})
		   AND NOT EXISTS (SELECT 1 FROM capacity_workday_runs workday
			WHERE workday.id=capacity_provider_assignments.work_day_id
			AND workday.status IN ('completed','cancelled','failed','degraded'))
		 ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
		          CASE WHEN status = 'pending' THEN created_at END ASC,
		          CASE WHEN status = 'returned' THEN returned_at END DESC,
		          id ASC
		 LIMIT 100`,
		[principal.teamId, principal.capacityProviderId, ...executionProviderIds],
	);
	const assignments = rows.map((row) => serializeProviderAssignmentRow(row) as DurableProviderAssignment);
	const workdayIds = [...new Set(assignments.map(assignmentWorkdayId).filter((id): id is string => Boolean(id)))];
	const workdayStatuses = new Map<string, string>();
	if (workdayIds.length) {
		const workdayRows = await store.all(
			`SELECT id, status FROM capacity_workday_runs WHERE id IN (${workdayIds.map(() => '?').join(', ')})`,
			workdayIds,
		);
		for (const row of workdayRows) {
			if (row.id) workdayStatuses.set(String(row.id), String(row.status ?? ''));
		}
	}
	const {leasable,diagnostics,assignment}=await eligibleLeaseCandidates({store,principal,request:input,assignments,workdayStatuses,now,availabilitySessionId:context.session.id});
	// Inventory and candidate authority reads can consume the same original
	// availability window. Never issue explanations or a claim with that stale clock.
	now = new Date().toISOString();
	context = await resolveProviderSynthesisContext(store, principal, { ...input, sessionId: context.session.id, now });
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
	now = new Date().toISOString();
	context = await resolveProviderSynthesisContext(store, principal, { ...input, sessionId: context.session.id, now });
	const nowMs = Date.parse(now);
	const leaseToken = randomUUID();
	const leasedCapacityEnvelope = assignment.status === 'pending'
		? beginAssignmentPreparationTimeBudget(record(assignment.capacityEnvelope), now)
		: assignment.capacityEnvelope;
	const assignmentDeadline = evaluateAssignmentLeaseDeadline({ ...assignment, capacityEnvelope: leasedCapacityEnvelope }, nowMs);
	const hardDeadlineMs = assignmentDeadline.hardDeadlineAt
		? Date.parse(assignmentDeadline.hardDeadlineAt)
		: Number.POSITIVE_INFINITY;
	const leaseExpiresAt = new Date(Math.min(Date.parse(now) + leaseSeconds * 1000, hardDeadlineMs)).toISOString();
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
	const leaseOperation = {
		query: `UPDATE capacity_provider_assignments
		 SET status = 'leased', lease_state = 'leased', lease_token = ?, lease_expires_at = ?,
		     lease_renewed_at = ?, runner_id = ?, provider_session_id = COALESCE(?, provider_session_id),
		     state_version = state_version + 1, claimed_at = COALESCE(claimed_at, ?), metadata_json = ?, capacity_envelope_json = ?,
		     explanation_json = ?, assignment_attempt_json = COALESCE(?, assignment_attempt_json), updated_at = ?
		 WHERE id = ? AND team_id = ? AND capacity_provider_id = ? AND membership_id = ? AND state_version = ?
		   AND EXISTS (SELECT 1 FROM capacity_provider_team_memberships membership
		     JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id
		     WHERE membership.id = capacity_provider_assignments.membership_id
		       AND membership.team_id = capacity_provider_assignments.team_id
		       AND membership.capacity_provider_id = capacity_provider_assignments.capacity_provider_id
		       AND membership.status = 'approved' AND provider.status = 'active')
		   AND (CAST(? AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM capacity_provider_access_tokens token
		     WHERE token.id = ? AND token.membership_id = capacity_provider_assignments.membership_id
		       AND token.status = 'active' AND token.expires_at > ?))
		   AND ((status = 'pending' AND lease_state = 'unleased')
		     OR (status = 'returned' AND lease_state = 'released'))
		   AND (CAST(? AS TEXT) IS NULL OR status <> 'returned' OR EXISTS (
		     SELECT 1 FROM execution_nodes node
		      WHERE node.team_id = capacity_provider_assignments.team_id
		        AND node.id = ? AND node.node_revision = ?
		        AND node.status = 'ready'
		        AND NOT EXISTS (SELECT 1 FROM capacity_provider_assignments active
		          WHERE active.team_id=node.team_id AND active.execution_node_id=node.id
		          AND active.execution_node_revision=node.node_revision
		          AND active.id<>capacity_provider_assignments.id
		          AND active.status IN ('pending','leased','running'))
		   ))`,
		params: [
			leaseToken, leaseExpiresAt, now, input.runnerId ?? null, context.session.id, now,
			JSON.stringify(assignment.metadata ?? {}), JSON.stringify(leasedCapacityEnvelope), JSON.stringify(selectedExplanation),
			assignment.assignmentAttempt ? JSON.stringify(advanceAssignmentAttemptLifecycle(assignment.assignmentAttempt, 'leased', now)) : null, now,
			assignment.id, principal.teamId, principal.capacityProviderId, principal.membershipId,
			assignment.stateVersion, principal.accessTokenId ?? null, principal.accessTokenId ?? null, now,
			assignment.executionNodeId, assignment.executionNodeId,
			assignment.executionNodeRevision,
		],
	};
	if (assignment.status === 'returned' && assignment.executionNodeId) {
		const nodeRow = await store.first(
			`SELECT id FROM execution_nodes WHERE team_id=? AND id=? AND node_revision=? AND status='ready' LIMIT 1`,
			[assignment.teamId, assignment.executionNodeId, assignment.executionNodeRevision],
		);
		if (!nodeRow) return { assignment: null, leaseToken: null, leaseSeconds, diagnostics: leaseDiagnostics };
		await store.batch([leaseOperation, {
			query: `UPDATE execution_nodes SET status='assigned',updated_at=?
			 WHERE team_id=? AND id=? AND node_revision=? AND status='ready'
			 AND EXISTS (SELECT 1 FROM capacity_provider_assignments assignment WHERE assignment.id=? AND assignment.team_id=? AND assignment.status='leased' AND assignment.lease_token=?)`,
			params: [now, assignment.teamId, assignment.executionNodeId,
				assignment.executionNodeRevision, assignment.id, assignment.teamId, leaseToken],
		}]);
	} else await store.run(leaseOperation.query, leaseOperation.params);
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
