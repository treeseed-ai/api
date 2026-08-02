import { mergeSeedMetadata } from '../../index.js';
import { ensureProjectKnowledgeBinding } from './project-knowledge-binding.js';

export async function ensureProjectSeedDependencies({ action, store, ids, manifestHash, appliedAt, env, localOnly, dependencyState }) {
    if (action.kind !== 'project')
        return [];
    const projectId = ids.projects.get(action.key) ?? action.existing?.id;
    const teamId = ids.teams.get(action.payload.teamKey);
    const repository = action.payload.repository;
    if (!projectId || !teamId || !repository)
        return [];
    const repairs = [];
    const metadata = mergeSeedMetadata(action.existing?.metadata, action.payload.metadata, action, manifestHash, appliedAt);
    const repositories = await store.listHubRepositories(projectId);
    const existingRepository = repositories.find((entry) => entry.role === repository.role);
    if (!existingRepository) {
        await store.upsertHubRepository(projectId, {
            teamId,
            role: repository.role,
            provider: repository.provider,
            owner: repository.owner,
            name: repository.name,
            url: repository.gitUrl,
            defaultBranch: repository.defaultBranch ?? 'main',
            currentBranch: repository.defaultBranch ?? 'main',
            status: 'active',
            submodulePath: repository.submodulePath ?? null,
            metadata,
        });
        repairs.push({ kind: 'hubRepository', projectId, role: repository.role });
    }
    if (localOnly === true) {
        repairs.push(await ensureProjectKnowledgeBinding({
            store,
            projectId,
            teamId,
            projectSlug: action.payload.slug,
            contentPath: action.payload.architecture?.contentPath,
            env,
            dependencyState,
        }));
    }
    return repairs;
}
