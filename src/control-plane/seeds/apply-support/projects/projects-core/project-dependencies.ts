import { mergeSeedMetadata,projectSeedMetadata } from '../../index.js';
import { ensureProjectKnowledgeBinding } from './project-knowledge-binding.js';
import { reconcileLibraryProvider } from './library-provider-reconciliation.js';

export async function ensureProjectSeedDependencies({ action, store, ids, manifestHash, appliedAt, env, localOnly, dependencyState, plan }) {
    if (action.kind !== 'project')
        return [];
    const projectId = ids.projects.get(action.key) ?? action.existing?.id;
    const teamId = ids.teams.get(action.payload.teamKey);
    const repository = action.payload.repository;
    if (!projectId || !teamId)
        return [];
    const repairs = [];
	const metadata = mergeSeedMetadata(projectSeedMetadata(action.existing?.metadata), action.payload.metadata, action, manifestHash, appliedAt);
    const repositories = await store.listHubRepositories(projectId);
	const desiredRepositories = [repository, action.payload.library].filter(Boolean);
	for (const desiredRepository of desiredRepositories) {
		const existingRepository = repositories.find((entry) => entry.role === desiredRepository.role);
		const currentBranch = desiredRepository.repositoryPolicy?.stagingBranch ?? desiredRepository.defaultBranch ?? 'main';
		const repositoryDrift = !existingRepository
			|| existingRepository.provider !== desiredRepository.provider
			|| existingRepository.owner !== desiredRepository.owner
			|| existingRepository.name !== desiredRepository.name
			|| existingRepository.url !== desiredRepository.gitUrl
			|| existingRepository.defaultBranch !== (desiredRepository.defaultBranch ?? 'main')
			|| existingRepository.currentBranch !== currentBranch
			|| existingRepository.status !== 'active'
			|| (existingRepository.submodulePath ?? null) !== (desiredRepository.submodulePath ?? null);
		if (repositoryDrift) {
			await store.upsertHubRepository(projectId, {
				id: existingRepository?.id,
				teamId,
				role: desiredRepository.role,
				provider: desiredRepository.provider,
				owner: desiredRepository.owner,
				name: desiredRepository.name,
				url: desiredRepository.gitUrl,
				defaultBranch: desiredRepository.defaultBranch ?? 'main',
				currentBranch,
				status: 'active',
				submodulePath: desiredRepository.submodulePath ?? null,
				metadata,
			});
			repairs.push({ kind: 'hubRepository', projectId, role: desiredRepository.role });
		}
    }
	if (localOnly === true) {
		if (!action.payload.library) throw new Error(`Project ${action.key} is missing its required library repository.`);
		const provider = await reconcileLibraryProvider({ store, teamId, projectId, projectSlug:action.payload.slug,
			owner:action.payload.library.owner,name:action.payload.library.name,
			visibility:action.payload.library.repositoryPolicy?.visibility ?? 'private',
			lifecycle:action.payload.library.repositoryPolicy?.lifecycle ?? 'adopt-only',env:env ?? process.env,fetchImpl:store.config?.fetchImpl });
        repairs.push(await ensureProjectKnowledgeBinding({
            store,
            projectId,
            teamId,
            projectSlug: action.payload.slug,
			libraryRoot: '.',
			libraryRef: 'refs/remotes/origin/staging',
			libraryRepositoryUrl: action.payload.library.gitUrl,
			libraryDefaultBranch: action.payload.library.defaultBranch ?? 'main',
			libraryCredentialId: provider.credentialId,
			expectedUpstreamHeads: provider.heads,
            env,
            dependencyState,
        }));
    }
    return repairs;
}
