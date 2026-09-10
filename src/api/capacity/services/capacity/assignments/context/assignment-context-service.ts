import { CapacityGovernanceError } from '../../../../database.ts';
import { selectAssignmentSourceRepository } from './source-repository.ts';

interface AssignmentContextStore {
	getProject(projectId: string): Promise<Record<string, unknown> | null>;
	getTeam(teamId: string): Promise<Record<string, unknown> | null>;
	listHubRepositories(projectId: string): Promise<Array<Record<string, unknown>>>;
	getProjectArchitecture(projectId: string): Promise<Record<string, unknown> | null>;
}

function object(value: unknown) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

export async function compileAssignmentProjectContext(store: AssignmentContextStore, projectId: string) {
	const project = await store.getProject(projectId);
	if (!project) throw new CapacityGovernanceError('capacity_project_not_found', 'Capacity assignment project does not exist.', 404, { projectId });
	const teamId = text(project.teamId, project.team_id);
	if (!teamId) throw new CapacityGovernanceError('capacity_project_team_missing', 'Capacity assignment project has no owning team.', 500, { projectId });
	const [team, repositories, architecture] = await Promise.all([
		store.getTeam(teamId),
		store.listHubRepositories(projectId),
		store.getProjectArchitecture(projectId),
	]);
	if (!team) throw new CapacityGovernanceError('capacity_project_team_not_found', 'Capacity assignment project team does not exist.', 500, { projectId, teamId });
	const metadata = object(project.metadata);
	const resolvedArchitecture = architecture ?? object(metadata.architecture);
	const contentPath = text(object(resolvedArchitecture).contentPath);
	const configuredAgentSpecs = object(metadata.agentSpecs);
	const configuredRepository = object(metadata.repository);
	const source = selectAssignmentSourceRepository(repositories);
	const repository = repositories.find(entry => entry.id === source.id)!;
	const slug = text(project.slug) ?? projectId;
	return {
		id: projectId,
		slug,
		name: text(project.name) ?? slug,
		architecture: resolvedArchitecture,
		agentSpecs: {
			root: text(configuredAgentSpecs.root) ?? (contentPath ? `${contentPath}/agents` : null),
			testsRoot: text(configuredAgentSpecs.testsRoot) ?? (contentPath ? `${contentPath}/agent-tests` : null),
		},
		repository: {
			id: source.id,
			provider: source.provider,
			role: text(repository.role, configuredRepository.role),
			owner: source.owner,
			name: source.name,
			defaultBranch: source.ref,
			currentBranch: text(repository.currentBranch, configuredRepository.currentBranch),
			cloneUrl: source.cloneUrl,
			checkoutPath: text(configuredRepository.checkoutPath, metadata.checkoutPath),
			submodulePath: text(repository.submodulePath, configuredRepository.submodulePath, metadata.submodulePath),
			webUrl: text(object(repository.metadata).webUrl, configuredRepository.webUrl),
		},
	};
}
