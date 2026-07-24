import { objectValue, redactProjectHostOperationValue } from './index.js';

export function projectHostMetadataPatchFromResult(input, result, operation) {
    const timestamp = new Date().toISOString();
    const operationSummary = {
        id: operation.id,
        kind: result.kind,
        requirementKey: result.requirementKey ?? input?.requirementKey ?? null,
        status: 'succeeded',
        queuedAt: operation.createdAt ?? null,
        completedAt: timestamp,
        commitSha: result.repository?.commitSha ?? null,
        changedPaths: result.repository?.changedPaths ?? [],
        auditStatus: result.repository?.audit?.status ?? null,
        secretSyncStatus: result.secretSync ? (result.secretSync.ok ? 'completed' : 'failed') : 'skipped',
    };
    return {
        hostBindings: result.hostBindings,
        hostBindingPlans: result.hostBindingPlans,
        hostBindingAudit: {
            checkedAt: timestamp,
            summary: input?.audit?.summary ?? null,
            diagnostics: input?.audit?.diagnostics ?? [],
            repository: result.repository?.audit ?? null,
            config: result.repository?.config ?? null,
        },
        hostBindingSecretSync: result.secretSync ?? null,
        lastHostOperation: operationSummary,
        hostBindingOperationResult: {
            kind: result.kind,
            requirementKey: result.requirementKey ?? input?.requirementKey ?? null,
            repository: result.repository,
            secretSync: result.secretSync,
            summary: result.summary,
        },
        hostBindingOperations: [operationSummary],
    };
}

export function mergeHostBindingOperationMetadata(existing, patch) {
    const previous = objectValue(existing);
    const operations = [
        ...(Array.isArray(patch.hostBindingOperations) ? patch.hostBindingOperations : []),
        ...(Array.isArray(previous.hostBindingOperations) ? previous.hostBindingOperations : []),
    ].slice(0, 10);
    return {
        ...previous,
        ...patch,
        hostBindingOperations: operations,
    };
}

export async function persistProjectHostOperationResult(store, input, result, operation) {
    const projectId = typeof input?.projectId === 'string' ? input.projectId : null;
    if (!projectId)
        return;
    const details = await store.getProjectDetails(projectId).catch(() => null);
    if (!details?.project)
        return;
    const patch = redactProjectHostOperationValue(projectHostMetadataPatchFromResult(input, result, operation));
    await store.updateProject(projectId, {
        metadata: mergeHostBindingOperationMetadata(details.project.metadata, patch),
    });
    const refreshedHosting = details.hosting ?? await store.getProjectHosting(projectId).catch(() => null);
    if (refreshedHosting) {
        await store.run(`UPDATE project_hosting SET metadata_json = ?, updated_at = ? WHERE project_id = ?`, [
            JSON.stringify(mergeHostBindingOperationMetadata(refreshedHosting.metadata, patch)),
            new Date().toISOString(),
            projectId,
        ]).catch(() => null);
    }
    const refreshedConnection = details.connection ?? await store.getProjectConnection(projectId).catch(() => null);
    if (refreshedConnection) {
        await store.run(`UPDATE project_connections SET metadata_json = ?, updated_at = ? WHERE project_id = ?`, [
            JSON.stringify(mergeHostBindingOperationMetadata(refreshedConnection.metadata, patch)),
            new Date().toISOString(),
            projectId,
        ]).catch(() => null);
    }
    const deployments = await store.listProjectDeployments(projectId, { limit: 10 }).catch(() => []);
    for (const deployment of deployments) {
        await store.updateProjectDeployment(deployment.id, {
            metadata: mergeHostBindingOperationMetadata(deployment.metadata, patch),
        }).catch(() => null);
    }
}
