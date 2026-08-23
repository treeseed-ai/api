import { actionIsUnchanged,hubRepositoryCurrentPayload,projectCurrentPayload,projectSeedMetadataRequiresMigration,resolveSeedReferences,teamCurrentPayload } from '../index.js';

export function selectedActions(plan) {
    return plan.actions.filter((action) => action.action !== 'skip' && action.environments.some((environment) => plan.environments.includes(environment)));
}

export function mutationActions(plan) {
    return selectedActions(plan).filter((action) => action.action === 'create' || action.action === 'update');
}

export async function reconcilePlanWithStore(plan, store) {
    const teamIds = new Map();
    const projectIds = new Map();
	for (const resource of await resolveSeedReferences(store, plan.references ?? [])) {
		if (resource.kind === 'team') teamIds.set(resource.key, resource.id);
		if (resource.kind === 'project') projectIds.set(resource.key, resource.id);
	}
    const nextActions = [];
    for (const action of plan.actions) {
        if (action.action === 'skip') {
            nextActions.push(action);
            continue;
        }
        let existing = null;
        let currentPayload = null;
        if (action.kind === 'team') {
            existing = await store.getTeamBySlug(action.payload.slug);
            if (existing)
                teamIds.set(action.key, existing.id);
            currentPayload = teamCurrentPayload(action, existing);
        }
		if (action.kind === 'teamMembership') {
			const seed = action.payload.metadata?.seed ?? {};
			existing = await store.getSeedTeamMembershipClaim(seed.name, action.key);
			currentPayload = existing ? {
				teamKey: action.payload.teamKey,
				email: existing.normalized_email,
				roles: JSON.parse(existing.roles_json ?? '[]'),
				missingUser: 'defer',
				metadata: action.payload.metadata,
			} : null;
			if (existing?.status === 'removed') currentPayload = null;
		}
		if (action.kind === 'servicePrincipalMembership') {
			const seed = action.payload.metadata?.seed ?? {};
			existing = await store.getSeedServicePrincipalMembership(seed.name, action.key);
			currentPayload = existing && existing.status !== 'removed' ? {
				teamKey: action.payload.teamKey,
				principalKey: existing.principal_key,
				displayName: existing.display_name,
				interactiveLogin: false,
				roles: JSON.parse(existing.roles_json ?? '[]'),
				metadata: action.payload.metadata,
			} : null;
		}
        if (action.kind === 'project') {
            const teamId = teamIds.get(action.payload.teamKey);
            existing = teamId ? await store.getProjectByTeamAndSlug(teamId, action.payload.slug) : null;
            if (existing)
                projectIds.set(action.key, existing.id);
            currentPayload = teamId ? await projectCurrentPayload(store, action, existing) : null;
        }
        if (action.kind === 'hubRepository') {
            const projectId = projectIds.get(action.payload.projectKey);
            existing = projectId ? (await store.listHubRepositories(projectId)).find((repository) => repository.role === action.payload.role) ?? null : null;
            currentPayload = hubRepositoryCurrentPayload(action, existing);
        }
		nextActions.push({
			...action,
			action: currentPayload
				? action.kind === 'project' && projectSeedMetadataRequiresMigration(existing?.metadata)
					? 'update'
					: actionIsUnchanged(action, currentPayload) ? 'unchanged' : 'update'
				: 'create',
            existing,
        });
    }
    return {
        ...plan,
        actions: nextActions,
        summary: nextActions.reduce((summary, action) => {
            summary[action.action] += 1;
            return summary;
        }, { create: 0, update: 0, unchanged: 0, skip: 0, delete: 0, error: 0 }),
    };
}
