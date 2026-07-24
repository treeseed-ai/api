import { actionIsUnchanged, teamCurrentPayload, repositoryHostCurrentPayload, projectCurrentPayload, hubRepositoryCurrentPayload, productCurrentPayload, catalogArtifactCurrentPayload } from './index.js';

export function selectedActions(plan) {
    return plan.actions.filter((action) => action.action !== 'skip' && action.environments.some((environment) => plan.environments.includes(environment)));
}

export function mutationActions(plan) {
    return selectedActions(plan).filter((action) => action.action === 'create' || action.action === 'update');
}

export async function reconcilePlanWithStore(plan, store) {
    const teamIds = new Map();
    const repositoryHostIds = new Map();
    const projectIds = new Map();
    const productIds = new Map();
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
        if (action.kind === 'repositoryHost') {
            const teamId = teamIds.get(action.payload.teamKey);
            existing = teamId
                ? (await store.listRepositoryHosts(teamId, { includePlatform: true })).find((host) => host.provider === action.payload.provider && host.name === action.payload.name) ?? null
                : null;
            if (existing)
                repositoryHostIds.set(action.key, existing.id);
            currentPayload = repositoryHostCurrentPayload(action, existing);
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
            if (existing)
                repositoryHostIds.set(action.payload.repositoryHostKey, existing.repositoryHostId);
            currentPayload = hubRepositoryCurrentPayload(action, existing);
        }
        if (action.kind === 'product') {
            const teamId = teamIds.get(action.payload.teamKey);
            const product = await store.getCatalogItemBySlug(action.payload.kind, action.payload.slug);
            existing = product?.teamId === teamId ? product : null;
            if (existing)
                productIds.set(action.key, existing.id);
            currentPayload = productCurrentPayload(action, existing);
        }
        if (action.kind === 'catalogArtifact') {
            const productId = productIds.get(action.payload.productKey);
            existing = productId ? await store.getCatalogArtifactVersion(productId, action.payload.version) : null;
            currentPayload = catalogArtifactCurrentPayload(action, existing);
        }
        nextActions.push({
            ...action,
            action: currentPayload ? actionIsUnchanged(action, currentPayload) ? 'unchanged' : 'update' : 'create',
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
