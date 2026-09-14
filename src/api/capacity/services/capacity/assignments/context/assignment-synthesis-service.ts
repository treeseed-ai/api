import type { CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';
import type { ProviderLeasePrincipal } from '../../../accounts/lease-authority-service.ts';
import { resolveProviderSynthesisContext } from '../../providers/provider-synthesis-context-service.ts';
import type { WorkdayProject } from '../../workdays/policy/workday-project-policy.ts';
import type { ConfiguredWorkspaceInput } from '../../workdays/treedx/workday-treedx-workspace-service.ts';
import { assignNextReadyExecutionNode } from '../planning/execution/living-execution-assignment.ts';

export interface ProviderSynthesisRequest extends Record<string, unknown> {
	sessionId?: string | null;
	providerSessionId?: string | null;
	environment?: string | null;
	runnerId?: string | null;
	source?: string | null;
}

interface ProviderAssignmentFunctionStore extends CapacityGovernanceDatabase {
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
	listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<DurableProviderAssignment | null>;
	createCapacityWorkdayTreeDxWorkspace(project: WorkdayProject, run: DurableCapacityWorkdayRun, input: ConfiguredWorkspaceInput): Promise<Record<string, unknown>>;
	getProject(projectId: string): Promise<Record<string, unknown> | null>;
	getTeam(teamId: string): Promise<Record<string, unknown> | null>;
	listHubRepositories(projectId: string): Promise<Array<Record<string, unknown>>>;
	getProjectArchitecture(projectId: string): Promise<Record<string, unknown> | null>;
}

/**
 * The only production assignment-synthesis entrypoint. Ready living nodes are
 * claimed directly; no materialized demand or second graph may supply work.
 */
export async function synthesizeProviderAssignments(
	store: ProviderAssignmentFunctionStore,
	principal: ProviderLeasePrincipal,
	input: ProviderSynthesisRequest = {},
): Promise<{ assignments: DurableProviderAssignment[]; diagnostics: Record<string, unknown> }> {
	await store.ensureInitialized();
	const now = new Date().toISOString();
	const context = await resolveProviderSynthesisContext(store, principal, { ...input, now });
	const providerSessionId = String(input.sessionId ?? input.providerSessionId ?? context.session.id);
	const assignment = await assignNextReadyExecutionNode(store, principal, providerSessionId, context.executionProviders, now);
	return {
		assignments: assignment ? [assignment] : [],
		diagnostics: { source: 'living-execution-graph', assigned: Boolean(assignment) },
	};
}
