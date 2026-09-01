import type { CapacityGovernanceDatabase } from '../../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';
import type { DurableCapacityWorkdayRun } from '../../../../../repositories/capacity/workdays/workday-run.ts';
import type { ConfiguredWorkspaceInput } from '../../../workdays/treedx/workday-treedx-workspace-service.ts';
import type { AssignmentJsonRecord as JsonRecord } from './assignment-function-support.ts';

export interface AssignmentFunctionStore extends CapacityGovernanceDatabase {
	getProject(projectId: string): Promise<JsonRecord | null>;
	getProjectByTeamAndSlug(teamId: string, slug: string): Promise<JsonRecord | null>;
	getProjectTreeDxLibrary(projectId: string): Promise<JsonRecord | null>;
	listTeamProjects(teamId: string): Promise<JsonRecord[]>;
	listTreeDxSharesForRecipient(teamId: string): Promise<JsonRecord[]>;
	getTeam(teamId: string): Promise<JsonRecord | null>;
	listHubRepositories(projectId: string): Promise<JsonRecord[]>;
	getProjectArchitecture(projectId: string): Promise<JsonRecord | null>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<DurableProviderAssignment | null>;
	createCapacityWorkdayTreeDxWorkspace(project: { id: string }, run: DurableCapacityWorkdayRun, input: ConfiguredWorkspaceInput): Promise<JsonRecord>;
}
