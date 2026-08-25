import { mergeSeedMetadata,projectSeedMetadata } from '../index.js';

export async function applyAction({ action, store, ids, manifestHash, appliedAt, plan }) {
    if (action.action === 'skip' || action.action === 'unchanged')
        return null;
    const metadata = mergeSeedMetadata(action.existing?.metadata, action.payload.metadata, action, manifestHash, appliedAt);
    if (action.kind === 'team') {
        const existing = action.existing;
        const team = existing
            ? (await store.updateTeamSettings(existing.id, {
                name: action.payload.name,
                displayName: action.payload.displayName,
                logoUrl: action.payload.logoUrl,
                profileSummary: action.payload.profileSummary,
                metadata,
            })).ok === false ? existing : await store.getTeam(existing.id)
            : await store.createTeam({
                slug: action.payload.slug,
                name: action.payload.name,
                displayName: action.payload.displayName,
                logoUrl: action.payload.logoUrl,
                profileSummary: action.payload.profileSummary,
                metadata,
            });
        ids.teams.set(action.key, team.id);
        return team;
    }
	if (action.kind === 'teamMembership') {
		const teamId = ids.teams.get(action.payload.teamKey);
		if (!teamId) throw new Error(`Missing team for ${action.key}.`);
		const seed = action.payload.metadata?.seed ?? {};
		return store.reconcileSeedTeamMembershipClaim({
			seedName: String(seed.name ?? plan.seed), resourceKey: action.key, teamId,
			email: action.payload.email, roles: action.payload.roles,
		});
	}
	if (action.kind === 'servicePrincipalMembership') {
		const teamId = ids.teams.get(action.payload.teamKey);
		if (!teamId) throw new Error(`Missing team for ${action.key}.`);
		const seed = action.payload.metadata?.seed ?? {};
		return store.reconcileSeedServicePrincipalMembership({
			seedName: String(seed.name ?? plan.seed), resourceKey: action.key, teamId,
			principalKey: action.payload.principalKey, displayName: action.payload.displayName,
			roles: action.payload.roles,
		});
	}
	if (action.kind === 'project') {
        const teamId = ids.teams.get(action.payload.teamKey);
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
		const projectMetadata = {
			metadata: mergeSeedMetadata(projectSeedMetadata(action.existing?.metadata), action.payload.metadata, action, manifestHash, appliedAt),
            kind: action.payload.kind,
            repository: action.payload.repository,
			library: action.payload.library,
			...(Object.keys(action.payload.architecture ?? {}).length > 0
				? { architecture: action.payload.architecture }
				: {}),
        };
        const project = action.existing
            ? await store.updateProject(action.existing.id, {
                slug: action.payload.slug,
                name: action.payload.name,
                description: action.payload.description,
                metadata: projectMetadata,
            })
            : (await store.createProject(teamId, {
                slug: action.payload.slug,
                name: action.payload.name,
                description: action.payload.description,
                metadata: projectMetadata,
            })).project;
        ids.projects.set(action.key, project.id);
		ids.projectTeams.set(action.key, teamId);
        return project;
    }
    if (action.kind === 'hubRepository') {
        const projectId = ids.projects.get(action.payload.projectKey);
        if (!projectId)
            throw new Error(`Missing project for ${action.key}.`);
        const projectAction = plan.actions.find((entry) => entry.key === action.payload.projectKey);
        const teamId = ids.projectTeams.get(action.payload.projectKey)
			?? (projectAction ? ids.teams.get(projectAction.payload.teamKey) : null);
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const repository = await store.upsertHubRepository(projectId, {
            id: action.existing?.id,
            teamId,
            role: action.payload.role,
            provider: action.payload.provider,
            owner: action.payload.owner,
            name: action.payload.name,
            url: action.payload.gitUrl,
            defaultBranch: action.payload.defaultBranch ?? 'main',
			currentBranch: action.existing?.currentBranch ?? action.payload.defaultBranch ?? 'main',
            status: action.payload.status ?? 'active',
            accessPolicy: action.payload.accessPolicy ?? {},
            releasePolicy: action.payload.releasePolicy ?? {},
            publishPolicy: action.payload.publishPolicy ?? {},
            submodulePath: action.payload.submodulePath ?? null,
            metadata,
        });
        return repository;
    }
    return null;
}
