import { mergeSeedMetadata } from '../../index.js';

export async function ensureProjectSeedDependencies({ action, store, ids, manifestHash, appliedAt }) {
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
    const hosting = await store.getProjectHosting(projectId);
    const connection = await store.getProjectConnection(projectId);
    if (!hosting) {
        await store.upsertProjectHosting(projectId, {
            kind: 'self_hosted_project',
            registration: 'optional',
            sourceRepoOwner: repository.owner,
            sourceRepoName: repository.name,
            sourceRepoUrl: repository.gitUrl,
            sourceRepoWorkflowPath: '.github/workflows/deploy.yml',
            executionOwner: 'project_runner',
            metadata: {
                ...metadata,
                source: 'seed',
                seededConnection: true,
            },
        });
        repairs.push({ kind: 'projectHosting', projectId });
    }
    else if (!connection) {
        await store.upsertProjectHosting(projectId, {
            kind: hosting.kind,
            registration: hosting.registration,
            marketBaseUrl: hosting.marketBaseUrl,
            sourceRepoOwner: hosting.sourceRepoOwner,
            sourceRepoName: hosting.sourceRepoName,
            sourceRepoUrl: hosting.sourceRepoUrl,
            sourceRepoWorkflowPath: hosting.sourceRepoWorkflowPath,
            executionOwner: hosting.metadata?.executionOwner ?? 'project_runner',
            metadata: hosting.metadata,
        });
        repairs.push({ kind: 'projectConnection', projectId });
    }
    return repairs;
}
