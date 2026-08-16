import { mergeSeedMetadata,projectSeedMetadata } from '../../index.js';
import { ensureProjectKnowledgeBinding } from './project-knowledge-binding.js';

export async function ensureProjectSeedDependencies({ action, store, ids, manifestHash, appliedAt, env, localOnly, dependencyState, plan }) {
    if (action.kind !== 'project')
        return [];
    const projectId = ids.projects.get(action.key) ?? action.existing?.id;
    const teamId = ids.teams.get(action.payload.teamKey);
    const repository = action.payload.repository;
    if (!projectId || !teamId || !repository)
        return [];
    const repairs = [];
	const metadata = mergeSeedMetadata(projectSeedMetadata(action.existing?.metadata), action.payload.metadata, action, manifestHash, appliedAt);
    const repositories = await store.listHubRepositories(projectId);
    const existingRepository = repositories.find((entry) => entry.role === repository.role);
    const currentBranch = repository.repositoryPolicy?.stagingBranch ?? repository.defaultBranch ?? 'main';
    const repositoryDrift = !existingRepository
        || existingRepository.provider !== repository.provider
        || existingRepository.owner !== repository.owner
        || existingRepository.name !== repository.name
        || existingRepository.url !== repository.gitUrl
        || existingRepository.defaultBranch !== (repository.defaultBranch ?? 'main')
        || existingRepository.currentBranch !== currentBranch
        || existingRepository.status !== 'active'
        || (existingRepository.submodulePath ?? null) !== (repository.submodulePath ?? null);
    if (repositoryDrift) {
        await store.upsertHubRepository(projectId, {
            id: existingRepository?.id,
            teamId,
            role: repository.role,
            provider: repository.provider,
            owner: repository.owner,
            name: repository.name,
            url: repository.gitUrl,
            defaultBranch: repository.defaultBranch ?? 'main',
            currentBranch,
            status: 'active',
            submodulePath: repository.submodulePath ?? null,
            metadata,
        });
        repairs.push({ kind: 'hubRepository', projectId, role: repository.role });
    }
	if (localOnly === true) {
		const contentRepository = plan.actions.find((candidate) =>
			candidate.kind === 'hubRepository'
			&& candidate.payload.projectKey === action.key
			&& candidate.payload.role === 'content');
        repairs.push(await ensureProjectKnowledgeBinding({
            store,
            projectId,
            teamId,
            projectSlug: action.payload.slug,
            contentPath: action.payload.architecture?.contentPath,
			contentRepositoryRef: action.payload.architecture?.topology === 'split_site_content'
				? 'refs/heads/staging'
				: undefined,
			contentRepositoryUrl: contentRepository?.payload.gitUrl,
			contentRepositoryDefaultBranch: contentRepository?.payload.defaultBranch,
            env,
            dependencyState,
        }));
    }
    return repairs;
}
