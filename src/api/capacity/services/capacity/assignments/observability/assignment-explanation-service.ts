import type { ProviderAssignment, ProviderAssignmentExplanation } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';

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
	assignment: ProviderAssignment,
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
	await repository.run(
		`UPDATE capacity_provider_assignments
		 SET explanation_json = ?, updated_at = ?
		 WHERE id = ? AND team_id = ?`,
		[JSON.stringify(explanation), timestamp, assignmentId, teamId],
	);
	return explanation;
}
