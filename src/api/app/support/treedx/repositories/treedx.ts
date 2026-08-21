import { optionalTrimmedString } from '../../index.ts';
export async function resolvePublicTreeDxTeam(store, input: any = {}) {
    const requested = optionalTrimmedString(input.teamId)
        ?? optionalTrimmedString(input.teamSlug)
        ?? optionalTrimmedString(input.slug)
        ?? 'treeseed-public';
    const existing = await store.getTeam(requested).catch(() => null)
        ?? await store.getTeamBySlug(requested).catch(() => null);
    if (existing)
        return existing;
    return store.createTeam({
        id: requested === 'treeseed-public' ? 'team-treeseed-public' : undefined,
        name: requested,
        displayName: optionalTrimmedString(input.displayName) ?? 'TreeSeed Public Knowledge',
        metadata: {
            kind: 'system_public_treedx_federation',
            publicKnowledge: true,
        },
    });
}
export async function enqueueTreeDxProvisionOperation(store, teamId, payload, body: any = {}, requestedBy: any = {}) {
    const deployment = Array.isArray(payload.deployments) ? payload.deployments[0] : null;
    if (!deployment || deployment.status === 'succeeded') {
        return { operation: null, deployment };
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : `team:${teamId}:treedx:provision:${deployment.id}`;
    const operation = await store.createPlatformOperation({
        namespace: 'treedx',
        operation: 'provision',
        target: 'control_plane_operations_runner',
        idempotencyKey,
        input: {
            teamId,
            instanceId: payload.instance?.id ?? null,
            deploymentId: deployment.id,
            imageRef: payload.instance?.imageRef ?? body.imageRef ?? 'treeseed/treedx:latest',
            volumeMountPath: payload.instance?.volumeMountPath ?? '/data',
            dataDirEnv: '/data',
            publicRead: payload.instance?.publicRead === true,
            planOnly: body.planOnly === true,
        },
        requestedByType: requestedBy.type ?? 'user',
        requestedById: requestedBy.id ?? 'unknown',
    });
    await store.updateTreeDxDeployment?.(deployment.id, {
        result: {
            operationId: operation.id,
            operationStatus: operation.status,
        },
    });
    return { operation, deployment };
}
