import {
	ASSIGNMENT_PERFORMANCE_SCHEMA,
	CAPACITY_BUDGET_SCHEMA,
	emptyCapacityBudget,
	type ProviderAssignmentLifecycleRequest,
} from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';
import { assignmentFailureDisposition } from '../assignment-failure-policy.ts';

export type JsonRecord = Record<string, unknown>;

export interface ExtendedProviderAssignmentLifecycleRequest extends ProviderAssignmentLifecycleRequest {
	activeSeconds?: number | null; elapsedSeconds?: number | null; actualUsd?: number | null;
	providerUnits?: number | null; usage?: JsonRecord | null;
}

export function record(value: unknown): JsonRecord {
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export function optionalFiniteNumber(value: unknown, field: string): number | null {
	if (value == null || value === '') return null;
	const parsed = Number(value);
	if (Number.isFinite(parsed)) return parsed;
	throw new CapacityGovernanceError('provider_assignment_usage_invalid', `${field} must be a finite number.`, 400, { field });
}

export function terminalPerformance(
	assignment: DurableProviderAssignment,
	input: ExtendedProviderAssignmentLifecycleRequest,
	status: 'completed' | 'failed',
	now: string,
) {
	if (input.performance) return input.performance;
	const metadata = record(assignment.metadata);
	const envelope = record(assignment.capacityEnvelope);
	const candidate = record(envelope.budget);
	const budget = candidate.schemaVersion === CAPACITY_BUDGET_SCHEMA ? candidate
		: emptyCapacityBudget(String(candidate.deadline ?? now), Math.max(0, Number(record(candidate.time).requestedSeconds ?? 0)));
	const completion = record(input.completion);
	const disposition = status === 'completed'
		? String(completion.disposition ?? 'completed')
		: assignmentFailureDisposition(input);
	return {
		schemaVersion: ASSIGNMENT_PERFORMANCE_SCHEMA, assignmentId: assignment.id, workdayId: assignment.workDayId ?? null,
		teamId: assignment.teamId, projectId: assignment.projectId, agentId: assignment.agentId ?? null,
		agentClassId: assignment.projectAgentClassId, activityProfile: String(metadata.activityProfile ?? metadata.activityType ?? assignment.mode),
		handlerId: assignment.handlerId ?? null, capacityProviderId: assignment.capacityProviderId,
		executionProviderId: assignment.executionProviderId ?? null, model: metadata.model ? String(metadata.model) : null,
		groupIds: Array.isArray(metadata.groupIds) ? metadata.groupIds.map(String) : [],
		configuration: { planningGraphRevision: metadata.planningGraphRevision ? String(metadata.planningGraphRevision) : null,
			agentDefinitionRevision: metadata.agentDefinitionRevision ? String(metadata.agentDefinitionRevision) : null,
			agentClassRevision: metadata.agentClassRevision ? String(metadata.agentClassRevision) : null,
			activityProfileRevision: metadata.activityProfileRevision ? String(metadata.activityProfileRevision) : null,
			handlerRevision: metadata.handlerRevision ? String(metadata.handlerRevision) : null,
			groupMembershipRevision: metadata.groupMembershipRevision ? String(metadata.groupMembershipRevision) : null,
			executionProviderConfigurationRevision: metadata.executionProviderConfigurationRevision ? String(metadata.executionProviderConfigurationRevision) : null },
		taskSignature: `${assignment.projectAgentClassId}:${assignment.mode}`,
		disposition, reason: String(input.reason ?? input.message ?? (status === 'completed' ? 'Assignment completed.' : 'Assignment failed.')),
		acceptanceChecks: Array.isArray(completion.acceptanceChecks) ? completion.acceptanceChecks : [],
		completedScope: [], remainingScope: [], artifactRefs: Array.isArray(completion.durableArtifactRefs) ? completion.durableArtifactRefs.map(String) : [], budget,
		actual: { activeSeconds: Math.max(0, Number(input.activeSeconds ?? 0)), elapsedSeconds: Math.max(0, Number(input.elapsedSeconds ?? 0)),
			inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 0, costAmount: input.actualUsd == null ? null : Number(input.actualUsd),
			costCurrency: input.actualUsd == null ? null : 'USD', native: [], attempts: Number(assignment.attemptCount ?? 0) + 1 },
		noUsefulScopedWorkRemaining: completion.noUsefulScopedWorkRemaining === true, agentAssessment: null,
		systemAssessment: { generatedBy: 'api-recovery', measuredAt: now, enforcementConfidence: record(budget).enforcementConfidence }, downstreamOutcomes: [],
	};
}
