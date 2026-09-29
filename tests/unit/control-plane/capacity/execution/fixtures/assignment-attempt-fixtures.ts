export const sourceRef = { store: 'treedx' as const, model: 'proposal', id: 'proposal', revision: 2,
	digest: `sha256:${'a'.repeat(64)}`, repository: 'library', commit: 'b'.repeat(40), path: 'proposals/one.mdx' };
export const gitRef = { store: 'git' as const, model: 'repository', id: 'sdk', repository: 'treeseed-ai/sdk', commit: 'c'.repeat(40) };
export const permissions = { content: { read: ['proposal'] as const, write: [] }, tools: ['source.read', 'source.write', 'verification'] as const };
export const candidate = {
	graphRevision: 4, projectAgentClassId: 'class-engineer', projectContentRepositoryId: 'library', contextRefs: [gitRef], predecessorResults: [],
	sourceRepositories: [],
	effectiveProfile: {
		handler: 'actor', prompt: { system: 'Implement the accepted work and verify the exact result.' },
		profileRef: { store: 'treedx', model: 'agent', id: 'agent:engineer', revision: 1, digest: `sha256:${'d'.repeat(64)}` },
		activity: 'acting', handlerOrigin: 'agent-package', permissionCeiling: permissions,
	},
	node: {
		schemaVersion: 'treeseed.execution-node/v1', id: 'node', teamId: 'team', projectId: 'project',
		workItemId: 'implementation', kind: 'acting', pairRole: 'actor', sourceRef,
		authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'decision', revision: 1, digest: `sha256:${'e'.repeat(64)}` }],
		ruleRevision: 1, nodeRevision: 1, agentClass: 'engineer', status: 'ready',
		estimate: { expectedSeconds: 120, maximumSeconds: 180 },
		requiredCapabilities: ['code-change'], requestedPermissions: permissions, workspace: 'git',
		acceptanceCriteria: ['Tests pass.'], maximumReviewCycles: 2,
		graphRevisionCreated: 1, graphRevisionUpdated: 4,
	},
};
export const provider = {
	id: 'codex', runtimeBuild: `sha256:${'f'.repeat(64)}`, status: 'available',
	capabilities: ['code-change'], availableConcurrency: 1, maxConcurrentRunners: 1,
	accountingLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
		capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 28800 } } },
	accountingObservation: { modelUsage: { day: '2026-09-13', observedAt: '2026-09-13T12:00:00.000Z', healthy: true, activeSeconds: 0, reservedSeconds: 0 },
		capabilityUsage: { 'code-change': { day: '2026-09-13', observedAt: '2026-09-13T12:00:00.000Z', healthy: true, activeSeconds: 0, reservedSeconds: 0 } } },
	lanes: [{ id: 'work', purpose: 'workday', priority: 1, capabilities: ['code-change'],
		maxConcurrentRunners: 1, reservedConcurrentWorkers: 0, borrowWhenIdle: true, lendWhenIdle: true, queueLimit: 10 }],
	offers: [{ offerId: 'codex-offer', capabilities: [{ id: 'code-change' }] }],
};
export const run = { id: 'workday', executionMode: 'simulation', parameters: { appliedPlan: {
	schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation',
	policySnapshot: { durationSeconds: 3600, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
		communicationConcurrency: 1, projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } },
	state: 'active', startsAt: '2026-09-13T12:00:00.000Z', endsAt: '2026-09-13T13:00:00.000Z',
	planningRounds: [{ round: 1, state: 'complete', assignmentIds: ['planning:1:project/engineer'] },
		{ round: 2, state: 'complete', assignmentIds: ['planning:2:project/engineer'] }],
	admittedSecondsByProject: {}, admittedSecondsByAgentClass: {}, activatedAt: '2026-09-13T12:00:00.000Z',
} } } as never;
