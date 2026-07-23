import type { CapacityGovernanceDatabase } from '../database.ts';
import type { DurableProviderAssignment } from '../repositories/assignment.ts';
import type { DurableCapacityWorkdayRun } from '../repositories/workday-run.ts';
import type { WorkdayProject } from './workday-project-policy.ts';
import type { CapacityPage } from '@treeseed/sdk/capacity-pagination';
import { assignNextCompiledDemand } from './assignment-function.ts';
import { compileProviderWorkdayDemand } from './demand-compiler.ts';
import type { ProviderLeasePrincipal } from './lease-authority-service.ts';
import { resolveProviderSynthesisContext } from './provider-synthesis-context-service.ts';
import type { ConfiguredWorkspaceInput } from './workday-treedx-workspace-service.ts';

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
 * The only production assignment-synthesis entrypoint. Source records are first
 * compiled into durable workday demand; one assignment function then claims a
 * demand and invokes the canonical reservation/admission transaction.
 */
export async function synthesizeProviderAssignments(
	store: ProviderAssignmentFunctionStore,
	principal: ProviderLeasePrincipal,
	input: ProviderSynthesisRequest = {},
): Promise<DurableProviderAssignment[]> {
	await store.ensureInitialized();
	const now = new Date().toISOString();
	const context = await resolveProviderSynthesisContext(store, principal, { ...input, now });
	await compileProviderWorkdayDemand(store, principal, now);
	const assignment = await assignNextCompiledDemand(
		store,
		principal,
		String(input.sessionId ?? input.providerSessionId ?? context.session.id),
		context.executionProviders,
		now,
	);
	return assignment ? [assignment] : [];
}
