import { CapacityGovernanceError } from '../database.ts';

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
	const configuredRepository = object(metadata.repository);
	const repository = repositories.find((entry) => ['software', 'primary', 'package'].includes(String(entry.role))) ?? repositories[0] ?? {};
	const slug = text(project.slug) ?? projectId;
	const teamSlug = text(team?.slug) ?? teamId;
	return {
		id: projectId,
		slug,
		name: text(project.name) ?? slug,
		architecture: architecture ?? object(metadata.architecture),
		agentSpecs: {
			root: text(object(metadata.agentSpecs).root) ?? 'src/content/agents',
			testsRoot: text(object(metadata.agentSpecs).testsRoot) ?? 'src/content/agent-tests',
		},
		repository: {
			provider: text(repository.provider, configuredRepository.provider) ?? 'github',
			role: text(repository.role, configuredRepository.role),
			owner: text(repository.owner, configuredRepository.owner, metadata.repositoryOwner) ?? teamSlug,
			name: text(repository.name, configuredRepository.name, metadata.repositoryName) ?? slug,
			defaultBranch: text(repository.defaultBranch, configuredRepository.defaultBranch, metadata.defaultBranch) ?? 'staging',
			currentBranch: text(repository.currentBranch, configuredRepository.currentBranch),
			cloneUrl: text(repository.url, configuredRepository.cloneUrl, metadata.cloneUrl, metadata.repositoryUrl) ?? `git@github.com:${teamSlug}/${slug}.git`,
			checkoutPath: text(configuredRepository.checkoutPath, metadata.checkoutPath),
			submodulePath: text(repository.submodulePath, configuredRepository.submodulePath, metadata.submodulePath),
			webUrl: text(object(repository.metadata).webUrl, configuredRepository.webUrl),
		},
	};
}
