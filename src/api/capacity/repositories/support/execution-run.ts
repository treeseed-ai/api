import type { CapacityPage, CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { ProviderAssignmentRepository, type DurableProviderAssignment } from '../capacity/assignments/assignment.ts';

type Row = Record<string, unknown>;

export interface ExecutionRunListFilters {
	projectId?: string | null;
	providerId?: string | null;
	status?: string | null;
	mode?: string | null;
	assignmentId?: string | null;
	workdayId?: string | null;
	executionProviderId?: string | null;
	limit?: unknown;
	cursor?: CapacityPageCursor | null;
	projection?: 'activity' | null;
}

function record(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function durationMs(start: string | null, end: string | null): number | null {
	if (!start || !end) return null;
	const duration = Date.parse(end) - Date.parse(start);
	return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function tokenCounts(assignment: DurableProviderAssignment) {
	const usage = record(assignment.assignmentResult?.usage);
	const native = record(usage.native);
	const inputTokens = Number(usage.modelInputTokens ?? native.inputTokens ?? 0);
	const outputTokens = Number(usage.modelOutputTokens ?? native.outputTokens ?? 0);
	const cachedInputTokens = Number(native.cachedInputTokens ?? 0);
	return {
		inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
		outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
		cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0,
		rawUsage: usage,
	};
}

function project(assignment: DurableProviderAssignment, activity: boolean): Row {
	const result = assignment.assignmentResult;
	const finishedAt = assignment.completedAt ?? assignment.failedAt ?? assignment.returnedAt;
	const tokens = tokenCounts(assignment);
	const base = {
		id: assignment.id, status: assignment.status, mode: assignment.mode,
		timing: { createdAt: assignment.createdAt, startedAt: assignment.claimedAt,
			completedAt: assignment.completedAt, failedAt: assignment.failedAt, finishedAt,
			durationMs: durationMs(assignment.claimedAt ?? assignment.assignedAt, finishedAt) },
		agent: { projectId: assignment.projectId, projectAgentClassId: assignment.projectAgentClassId,
			agentId: assignment.agentId, handlerId: assignment.handlerId },
		assignment: { id: assignment.id, status: assignment.status, leaseState: assignment.leaseState,
			workdayId: assignment.workDayId, taskId: assignment.taskId, decisionId: assignment.decisionId,
			proposalId: assignment.proposalId, runnerId: assignment.runnerId,
			lifecycleCode: assignment.lifecycleCode, lifecycleReason: assignment.lifecycleReason },
		executionProvider: { id: assignment.executionProviderId, capacityProviderId: assignment.capacityProviderId,
			tokenCounts: tokens, hasTokenCounts: tokens.inputTokens + tokens.outputTokens + tokens.cachedInputTokens > 0 },
		contentArtifactRefs: result?.references ?? [],
	};
	if (activity) return { ...base, input: { selectedInput: { cycle: assignment.attemptCount } } };
	return { ...base,
		input: { assignmentAttempt: assignment.assignmentAttempt, workspaceContext: assignment.workspaceContext,
			allowedOutputs: assignment.allowedOutputs, capacityEnvelope: assignment.capacityEnvelope },
		output: { assignmentResult: result, lifecycleOutput: assignment.lifecycleOutput,
			usageActual: result?.usage ?? null },
		context: { assignmentExplanation: assignment.explanation },
	};
}

/** Assignment/result custody is the sole execution-run source; no mode-run projection. */
export async function listExecutionRunsForTeamPage(
	database: CapacityGovernanceDatabase,
	teamId: string,
	filters: ExecutionRunListFilters = {},
): Promise<CapacityPage<Row>> {
	const page = await new ProviderAssignmentRepository(database).list(teamId, filters);
	return { ...page, items: page.items.map((assignment) => project(assignment, filters.projection === 'activity')) };
}
