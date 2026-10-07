import type { ProviderAssignment,ProviderAssignmentExplanation } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';

type JsonRecord = Record<string, unknown>;

interface AssignmentExplanationRepository extends CapacityGovernanceDatabase {
	getProviderAssignment(teamId: string, assignmentId: string): Promise<ProviderAssignment | null>;
}

export interface ProviderAssignmentExplanationWrite {
	id?: string;
	source?: string;
	sourceId?: string | null;
	eligible?: boolean;
	reasons?: unknown[];
	gates?: JsonRecord;
	allocationPolicyVersion?: string | null;
	grantScope?: string | null;
	metadata?: JsonRecord;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === 'string' && value) return value;
	}
	return '';
}

function explanationId(assignmentId: string): string {
	const suffix = assignmentId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/gu, '-')
		.replace(/^-+|-+$/gu, '') || 'assignment';
	return `pae_${suffix}`;
}

export function buildProviderAssignmentExplanation(
	assignment: Pick<ProviderAssignment, 'id' | 'explanation' | 'synthesizedFrom' | 'synthesisKey' | 'assignedAt'>,
	teamId: string,
	input: ProviderAssignmentExplanationWrite = {},
	timestamp = new Date().toISOString(),
): ProviderAssignmentExplanation {
	const assignmentId = assignment.id;
	const current = record(assignment.explanation);
	const currentMetadata = record(current.metadata);
	const history = Array.isArray(currentMetadata.history) ? currentMetadata.history : [];
	const previous = Object.keys(current).length > 0
		? {
			source: current.source ?? null,
			sourceId: current.sourceId ?? null,
			eligible: current.eligible !== false,
			reasons: Array.isArray(current.reasons) ? current.reasons.map(String) : [],
			gates: record(current.gates),
			recordedAt: record(current.metadata).recordedAt ?? current.createdAt ?? assignment.assignedAt ?? null,
		}
		: null;
	const explanation: ProviderAssignmentExplanation = {
		id: input.id ?? text(current.id, explanationId(assignmentId)),
		teamId,
		assignmentId,
		source: text(input.source, current.source, assignment.synthesizedFrom, 'assignment'),
		sourceId: input.sourceId ?? (current.sourceId as string | null | undefined) ?? assignment.synthesisKey ?? null,
		eligible: input.eligible !== false,
		reasons: Array.isArray(input.reasons) ? input.reasons.map(String) : [],
		gates: record(input.gates),
		allocationPolicyVersion: input.allocationPolicyVersion ?? (current.allocationPolicyVersion as string | null | undefined) ?? null,
		grantScope: input.grantScope ?? (current.grantScope as string | null | undefined) ?? null,
		metadata: {
			...currentMetadata,
			...record(input.metadata),
			recordedAt: timestamp,
			history: [...history, ...(previous ? [previous] : [])].slice(-50),
		},
		createdAt: text(current.createdAt, timestamp),
	};
	return explanation;
}

export async function recordProviderAssignmentExplanation(
	repository: AssignmentExplanationRepository,
	teamId: string,
	assignmentId: string,
	input: ProviderAssignmentExplanationWrite = {},
): Promise<ProviderAssignmentExplanation | null> {
	await repository.ensureInitialized();
	const assignment = await repository.getProviderAssignment(teamId, assignmentId);
	if (!assignment) return null;
	const timestamp = new Date().toISOString();
	const explanation = buildProviderAssignmentExplanation(assignment, teamId, input, timestamp);
	if (input.source === 'lease_next_assignment') {
		const sessionId = record(record(input.metadata).leaseAttempt).sessionId;
		// Use the original availability row at the UPDATE boundary, not a clock
		// captured before the asynchronous assignment read. No credential is copied.
		const updated = await repository.first(`UPDATE capacity_provider_assignments
			SET explanation_json = ?, updated_at = ? WHERE id = ? AND team_id = ?
			AND EXISTS (SELECT 1 FROM capacity_provider_availability_sessions session
				WHERE session.id=? AND session.team_id=capacity_provider_assignments.team_id
				AND session.membership_id=capacity_provider_assignments.membership_id
				AND session.capacity_provider_id=capacity_provider_assignments.capacity_provider_id
				AND session.status='open' AND session.closed_at IS NULL
				AND COALESCE(session.available_until,session.expires_at)::timestamptz > clock_timestamp())
			RETURNING id`, [JSON.stringify(explanation), timestamp, assignmentId, teamId, sessionId]);
		if (!updated) throw new CapacityGovernanceError('provider_synthesis_window_expired',
			'Original provider availability no longer authorizes this explanation.', 409);
		return explanation;
	}
	await repository.run(
		`UPDATE capacity_provider_assignments
		 SET explanation_json = ?, updated_at = ?
		 WHERE id = ? AND team_id = ?`,
		[JSON.stringify(explanation), timestamp, assignmentId, teamId],
	);
	return explanation;
}
