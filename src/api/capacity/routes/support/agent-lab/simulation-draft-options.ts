import { resolveWorkdayPlanningGraphSnapshot, type WorkdayPlanningGraphStore } from '../../../services/capacity/workdays/policy/workday-planning-graph-policy.ts';
import { compileCooperativePlanningSession } from '../../../services/capacity/workdays/scheduling/cooperative-planning-session-service.ts';

export type AgentLabSimulationDraftOptions = {
	durationSeconds: number;
	planningRounds: number;
	assignmentTimeboxSeconds: number;
	maxActiveAssignments: number;
	agentSlugs: string[];
	activityTypes: string[];
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function parseAgentLabSimulationDraftOptions(query: (name: string) => string | undefined): AgentLabSimulationDraftOptions {
	const durationSeconds = boundedInteger(query('durationSeconds'), 900, 60, 3_600);
	return {
		durationSeconds,
		planningRounds: boundedInteger(query('planningRounds'), 3, 1, 10),
		assignmentTimeboxSeconds: boundedInteger(query('assignmentTimeboxSeconds'), Math.min(600, durationSeconds), 30, durationSeconds),
		maxActiveAssignments: boundedInteger(query('maxActiveAssignments'), 4, 1, 8),
		agentSlugs: [...new Set((query('agents') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))],
		activityTypes: [...new Set((query('activityProfiles') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))],
	};
}

export async function validateAgentLabSimulationSelection(
	store: WorkdayPlanningGraphStore,
	projectId: string,
	options: AgentLabSimulationDraftOptions,
) {
	try {
		const snapshot = await resolveWorkdayPlanningGraphSnapshot(store, projectId, {
			agentSlugs: options.agentSlugs,
			activityTypes: options.activityTypes,
			mode: 'intersection',
		});
		compileCooperativePlanningSession({
			snapshots: new Map([[projectId, snapshot]]),
			rounds: options.planningRounds,
			maxConcurrentAssignments: options.maxActiveAssignments,
			allocatedSeconds: Math.floor(options.durationSeconds * options.maxActiveAssignments * 0.9),
			assignmentTimeboxSeconds: options.assignmentTimeboxSeconds,
		});
		return [];
	} catch (error) {
		const details = error && typeof error === 'object' && 'details' in error
			? (error as { details?: Record<string, unknown> }).details
			: undefined;
		const requiredSeconds = Number(details?.requiredSeconds);
		const allocatedSeconds = Number(details?.allocatedSeconds);
		const budgetExplanation = Number.isFinite(requiredSeconds) && Number.isFinite(allocatedSeconds)
			? ` Required ${requiredSeconds} planning seconds; this plan allocates ${allocatedSeconds}.`
			: '';
		return [{
			severity: 'error',
			message: `${error instanceof Error ? error.message : 'The selected agents do not form a schedulable planning graph.'}${budgetExplanation}`,
			path: 'agents',
			...(details ? { details } : {}),
		}];
	}
}
