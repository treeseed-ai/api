import { actionIsUnchanged,hubRepositoryCurrentPayload,projectCurrentPayload,projectSeedMetadataRequiresMigration,resolveSeedReferences,teamCurrentPayload } from '../index.js';
import type { SeedPlanAction, SeedPlan, SeedPlanSummary } from '../../contracts/types.ts';
import type { ControlPlaneStore } from '../../../../api/persistence/store.ts';

export function selectedActions<T extends { kind: string; key: string; payload: Record<string, unknown>; existing?: { id?: string } | null; action?: unknown; environments: readonly string[] }>(plan: { actions: readonly T[]; environments: readonly string[] }) {
    return plan.actions.filter((action) => action.action !== 'skip' && action.environments.some((environment) => plan.environments.includes(environment)));
}

export function mutationActions<T extends { kind: string; key: string; payload: Record<string, unknown>; existing?: { id?: string } | null; action?: unknown; environments: readonly string[] }>(plan: { actions: readonly T[]; environments: readonly string[] }) {
    return selectedActions(plan).filter((action) => action.action === 'create' || action.action === 'update');
}

export async function reconcilePlanWithStore<T extends Pick<SeedPlan, 'seed' | 'actions' | 'references'>>(plan: T, store: ControlPlaneStore) {
    const teamIds = new Map<string, string>();
    const projectIds = new Map<string, string>();
	for (const resource of await resolveSeedReferences(store, plan.references ?? [])) {
		if (resource.kind === 'team') teamIds.set(resource.key, resource.id);
		if (resource.kind === 'project') projectIds.set(resource.key, resource.id);
	}
    const nextActions: SeedPlanAction[] = [];
    for (const action of plan.actions) {
        if (action.action === 'skip') {
            nextActions.push(action);
            continue;
        }
        let existing: SeedPlanAction['existing'] = null;
        let currentPayload: Record<string, unknown> | null = null;
        if (action.kind === 'team') {
            const team = await store.getTeamBySlug(action.payload.slug);
            existing = team;
            if (team)
                teamIds.set(action.key, team.id);
            currentPayload = teamCurrentPayload(action, team);
        }
		if (action.kind === 'teamMembership') {
			const seed = action.payload.metadata?.seed ?? {};
			const membership = await store.getSeedTeamMembershipClaim(seed.name, action.key);
			existing = membership;
			currentPayload = membership ? {
				teamKey: action.payload.teamKey,
				email: membership.normalized_email,
				roles: JSON.parse(membership.roles_json ?? '[]'),
				missingUser: action.payload.missingUser,
				metadata: action.payload.metadata,
			} : null;
			if (existing?.status === 'removed') currentPayload = null;
		}
		if (action.kind === 'servicePrincipalMembership') {
			const seed = action.payload.metadata?.seed ?? {};
			const membership = await store.getSeedServicePrincipalMembership(seed.name, action.key);
			existing = membership;
			currentPayload = membership && membership.status !== 'removed' ? {
				teamKey: action.payload.teamKey,
				principalKey: membership.principal_key,
				displayName: membership.display_name,
				interactiveLogin: false,
				roles: JSON.parse(membership.roles_json ?? '[]'),
				metadata: action.payload.metadata,
			} : null;
		}
        if (action.kind === 'project') {
            const teamId = teamIds.get(action.payload.teamKey);
            const project = teamId ? await store.getProjectByTeamAndSlug(teamId, action.payload.slug) : null;
            existing = project;
            if (project)
                projectIds.set(action.key, project.id);
            currentPayload = teamId ? await projectCurrentPayload(store, action, project) : null;
        }
        if (action.kind === 'hubRepository') {
            const projectId = projectIds.get(action.payload.projectKey);
            const repository = projectId ? (await store.listHubRepositories(projectId)).find((repository) => repository.role === action.payload.role) ?? null : null;
            existing = repository;
            currentPayload = hubRepositoryCurrentPayload(action, repository);
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
        }, { create: 0, update: 0, unchanged: 0, skip: 0, delete: 0, error: 0 } satisfies SeedPlanSummary),
    };
}
