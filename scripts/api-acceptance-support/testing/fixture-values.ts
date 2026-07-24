

export function fixtureValue(name) {
    const map = {
        teamId: '${fixtures.team.id}',
        projectId: '${fixtures.project.id}',
        providerId: '${fixtures.provider.id}',
        operationId: '${fixtures.platformOperation.id}',
        itemId: '${fixtures.catalogItem.id}',
        artifactId: '${fixtures.catalogArtifact.id}',
        runId: '${fixtures.seedRun.id}',
        sessionId: '${fixtures.session.id}',
        membershipId: '${fixtures.membership.id}',
        inviteId: '${fixtures.invite.id}',
        hostId: 'acceptance-hostId',
        environmentId: '${fixtures.environment.id}',
        requestId: '${fixtures.approvalRequest.id}',
        vendorId: 'acceptance-vendorId',
        productId: 'acceptance-productId',
        offerId: 'acceptance-offerId',
        priceId: 'acceptance-priceId',
        taskId: '${fixtures.task.id}',
        jobId: '${fixtures.job.id}',
        executionProviderId: '${fixtures.provider.id}:codex-subscription:acceptance-native-capacity',
        collection: 'decisions',
        version: '${fixtures.catalogArtifact.version}',
        username: '${actors.teamOwner.username}',
        name: 'acceptance',
    };
    return map[name] ?? `acceptance-${name}`;
}

export function descriptorPath(descriptor) {
    return descriptor.path.replace(/:([A-Za-z0-9_]+)/gu, (_, name) => fixtureValue(name));
}
