export const assignment = {
	schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment', idempotencyKey: 'assignment', teamId: 'team', projectId: 'project',
	workdayId: 'workday', nodeId: 'node', agentClass: 'engineer', workItemId: 'work-item', nodeRevision: 1, graphRevision: 2,
	sourceRef: { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1, digest: `sha256:${'a'.repeat(64)}` }, authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'decision', revision: 1, digest: `sha256:${'e'.repeat(64)}` }],
	effectiveProfile: { profileRef: { store: 'treedx', model: 'agent', id: 'sdk/engineer', revision: 1, digest: `sha256:${'b'.repeat(64)}` },
		activity: 'acting', handler: 'actor', handlerOrigin: 'agent-package', prompt: { system: 'Implement the exact authorized source change.' },
		permissionCeiling: { content: { read: [], write: [] }, tools: ['source.read', 'source.write'] } },
	requiredCapabilities: [], grant: { contentRead: [], contentWrite: [], sourceRead: ['treeseed-ai/sdk'], sourceWrite: ['treeseed-ai/sdk'], tools: ['source.read','source.write'] },
	provider: { providerId: 'provider', offerId: 'offer', executionProviderId: 'codex', modelConfigurationId: 'terra-medium', executionCapabilityId: 'code-change', offerRevision: 1, runtimeBuild: `sha256:${'c'.repeat(64)}` }, contextRefs: [], predecessorResultIds: [],
	acceptanceCriteria: ['Complete the exact work item.'],
	workspace: { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'd'.repeat(40), branch: 'treeseed/assignments/assignment', writablePaths: ['src'] },
	estimate: { minimumSeconds: 1, expectedSeconds: 2, maximumSeconds: 3 }, limits: { maximumSeconds: 3, maximumContextBytes: 1, maximumContextTokens: 1, maximumContextItems: 1 },
	deadline: '2026-09-14T00:00:00.000Z', leaseId: 'lease', reservationId: 'reservation', attempt: 1, status: 'created', createdAt: '2026-09-13T12:00:00.000Z',
} as const;
