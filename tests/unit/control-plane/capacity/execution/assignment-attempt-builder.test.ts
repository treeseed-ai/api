import { describe, expect, it } from 'vitest';
import { buildAssignmentAttempt } from '../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';

const sourceRef = { store: 'treedx' as const, model: 'proposal', id: 'proposal', revision: 2,
	digest: `sha256:${'a'.repeat(64)}`, repository: 'library', commit: 'b'.repeat(40), path: 'proposals/one.mdx' };
const gitRef = { store: 'git' as const, model: 'repository', id: 'sdk', repository: 'treeseed-ai/sdk', commit: 'c'.repeat(40) };
const permissions = { content: { read: ['proposal'] as const, write: [] }, tools: ['source.read', 'source.write', 'verification'] as const };
const candidate = {
	graphRevision: 4, projectAgentClassId: 'class-engineer', contextRefs: [gitRef], predecessorResults: [],
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
		estimate: { minimumSeconds: 60, expectedSeconds: 120, maximumSeconds: 180 },
		requiredCapabilities: ['code-change'], requestedPermissions: permissions, workspace: 'git',
		acceptanceCriteria: ['Tests pass.'], maximumReviewCycles: 2,
		graphRevisionCreated: 1, graphRevisionUpdated: 4,
	},
};
const provider = {
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
const run = { id: 'workday', executionMode: 'simulation', parameters: { appliedPlan: {
	schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation',
	policySnapshot: { durationSeconds: 3600, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
		communicationConcurrency: 1, projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } },
	state: 'active', startsAt: '2026-09-13T12:00:00.000Z', endsAt: '2026-09-13T13:00:00.000Z',
	planningRounds: [{ round: 1, state: 'complete', assignmentIds: ['planning:1:project/engineer'] },
		{ round: 2, state: 'complete', assignmentIds: ['planning:2:project/engineer'] }],
	admittedSecondsByProject: {}, admittedSecondsByAgentClass: {}, activatedAt: '2026-09-13T12:00:00.000Z',
} } } as never;

describe('immutable assignment-attempt construction', () => {
	it('passes the exact Architecture Book and grants a valid page within that Book', () => {
		const architecture = {
			store: 'treedx' as const, model: 'book', id: 'sdk-architecture',
			repository: 'library', commit: '9'.repeat(40), path: 'books/architecture.md',
			revision: 1, digest: `sha256:${'1'.repeat(64)}`,
		};
		const architect = structuredClone(candidate);
		architect.contextRefs = [architecture] as never;
		architect.node.agentClass = 'architect';
		architect.node.workItemId = 'architecture-contract';
		architect.node.workspace = 'treedx';
		architect.node.requestedPermissions = { content: { read: ['proposal', 'book'], write: ['knowledge'] },
			tools: ['source.read'] } as never;
		architect.effectiveProfile.permissionCeiling = architect.node.requestedPermissions;
		const result = buildAssignmentAttempt({ candidate: { ...architect, lineageSourceCommit: '9'.repeat(40) } as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.contextRefs).toContainEqual(architecture);
		expect(result.assignment.grant.contentRead).toContainEqual(architecture);
		const target = result.assignment.grant.contentWrite[0]!;
		expect(target).toMatchObject({ model: 'knowledge', repository: 'library', commit: 'b'.repeat(40) });
		expect(target.id).toMatch(/^knowledge-[a-f0-9]+$/u);
		expect(target.path).toBe(`knowledge/sdk-architecture/${target.id}.md`);
		expect(result.assignment.workspace).toMatchObject({ mode: 'treedx', writablePaths: [target.path] });
	});

	it('preserves a proposal-owned exact Knowledge identity in the assignment grant', () => {
		const exact = structuredClone(candidate);
		exact.contextRefs = [{ store: 'treedx', model: 'book', id: 'sdk-core', repository: 'library', commit: '9'.repeat(40), path: 'books/sdk-core.md', revision: 1, digest: `sha256:${'1'.repeat(64)}` }] as never;
		exact.node.workspace = 'treedx';
		exact.node.output = { model: 'knowledge', id: 'sdk-workday-contract-inventory-v1' };
		exact.node.requestedPermissions = { content: { read: ['proposal', 'book'], write: ['knowledge'] }, tools: ['source.read'] } as never;
		exact.effectiveProfile.permissionCeiling = exact.node.requestedPermissions;
		const result = buildAssignmentAttempt({ candidate: { ...exact, lineageSourceCommit: '9'.repeat(40) } as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.grant.contentWrite[0]).toMatchObject({
			id: 'sdk-workday-contract-inventory-v1', path: 'knowledge/sdk-core/sdk-workday-contract-inventory-v1.md',
		});
	});

	it('rejects an acting Knowledge writer without an exact Book reference before consuming capacity', () => {
		const architect = structuredClone(candidate);
		architect.contextRefs = [];
		architect.node.workspace = 'treedx';
		architect.node.requestedPermissions = { content: { read: ['proposal', 'book'], write: ['knowledge'] },
			tools: ['source.read'] } as never;
		architect.effectiveProfile.permissionCeiling = architect.node.requestedPermissions;
		expect(() => buildAssignmentAttempt({ candidate: architect as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' }))
			.toThrow(/exact Book reference/u);
	});

	it('freezes graph, profile, provider build, exact grant, workspace, and estimate', () => {
		const result = buildAssignmentAttempt({
			candidate: candidate as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z',
		});
		expect(result).toMatchObject({
			laneId: 'work',
			assignment: {
				graphRevision: 4, nodeId: 'node', nodeRevision: 1, workdayId: 'workday',
				effectiveProfile: { handler: 'actor', activity: 'acting' },
				provider: { providerId: 'provider', offerId: 'codex-offer', runtimeBuild: provider.runtimeBuild },
				grant: { sourceRead: ['treeseed-ai/sdk'], sourceWrite: ['treeseed-ai/sdk'], tools: permissions.tools },
				workspace: { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'c'.repeat(40) },
				estimate: candidate.node.estimate,
				limits: { maximumSeconds: 180 },
			},
		});
		expect(result.assignment.workspace).toMatchObject({ branch: `simulation/local/workday/${result.assignment.id}` });
		expect(JSON.stringify(result)).not.toMatch(/capacityPlan|demand|sourceCandidate|artifactManifest|executionPlanRef/u);
	});

	it('uses the upstream assignment branch only for production custody', () => {
		const productionRun = { ...run, executionMode: 'production', parameters: {
			...(run as { parameters: Record<string, unknown> }).parameters,
			appliedPlan: { ...(run as { parameters: { appliedPlan: Record<string, unknown> } }).parameters.appliedPlan,
				executionMode: 'production' },
		} } as never;
		const result = buildAssignmentAttempt({ candidate: candidate as never, run: productionRun,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.workspace).toMatchObject({ branch: `treeseed/assignments/${result.assignment.id}` });
	});

	it('continues a revised Actor from its prior candidate commit', () => {
		const revised = structuredClone(candidate);
		revised.node.nodeRevision = 2;
		revised.predecessorResults = [{
			schemaVersion: 'treeseed.assignment-result/v1', id: 'prior', assignmentId: 'prior-assignment',
			status: 'completed', summary: 'Initial candidate.',
			references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: '9'.repeat(40) }],
			verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z',
		}] as never;
		const result = buildAssignmentAttempt({ candidate: revised as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.workspace).toMatchObject({ baseCommit: '9'.repeat(40) });
	});

	it('continues a reviewed revision from its own candidate when the original Tester commit is also a predecessor', () => {
		const revised = structuredClone(candidate);
		revised.node.nodeRevision = 3;
		revised.predecessorResults = [
			{ schemaVersion: 'treeseed.assignment-result/v1', id: 'tester-result', assignmentId: 'tester-assignment',
				status: 'completed', summary: 'Tests first.', references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: '8'.repeat(40) }],
				verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z' },
			{ schemaVersion: 'treeseed.assignment-result/v1', id: 'actor-result', assignmentId: 'actor-assignment',
				status: 'completed', summary: 'First implementation.', references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: '9'.repeat(40) }],
				verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-13T12:00:01.000Z' },
		] as never;
		const result = buildAssignmentAttempt({ candidate: { ...revised, lineageSourceCommit: '9'.repeat(40) } as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.workspace).toMatchObject({ baseCommit: '9'.repeat(40) });
	});

	it('rebases a revised Actor on its sole current upstream while retaining its earlier candidate as context', () => {
		const revised = structuredClone(candidate);
		revised.node.nodeRevision = 3;
		revised.predecessorResults = ['8', '9'].map((digit) => ({
			schemaVersion: 'treeseed.assignment-result/v1', id: `result-${digit}`, assignmentId: `assignment-${digit}`,
			status: 'completed', summary: 'Exact candidate.',
			references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: digit.repeat(40) }],
			verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z',
		})) as never;
		const result = buildAssignmentAttempt({ candidate: { ...revised,
			directPredecessorSourceCommit: '8'.repeat(40) } as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.workspace).toMatchObject({ baseCommit: '8'.repeat(40) });
		expect(result.assignment.predecessorResultIds).toEqual(['result-8', 'result-9']);
	});

	it('uses the sole Git predecessor as the base for an initial acting node', () => {
		const following = structuredClone(candidate);
		following.predecessorResults = [{
			schemaVersion: 'treeseed.assignment-result/v1', id: 'predecessor', assignmentId: 'previous-assignment',
			status: 'completed', summary: 'Reviewed predecessor.',
			references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: '9'.repeat(40) }],
			verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z',
		}] as never;
		const result = buildAssignmentAttempt({ candidate: following as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.workspace).toMatchObject({ baseCommit: '9'.repeat(40) });
	});

	it('rejects divergent Git predecessors until an explicit integration assignment combines them', () => {
		const divergent = structuredClone(candidate);
		divergent.predecessorResults = ['8', '9'].map((digit) => ({
			schemaVersion: 'treeseed.assignment-result/v1', id: `predecessor-${digit}`, assignmentId: `assignment-${digit}`,
			status: 'completed', summary: 'Reviewed predecessor.',
			references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: digit.repeat(40) }],
			verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z',
		})) as never;
		expect(() => buildAssignmentAttempt({ candidate: divergent as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' })).toThrow(/explicit integration assignment/u);
	});

	it('gives an authorized Releaser one exact base and every divergent predecessor for integration', () => {
		const integration = structuredClone(candidate);
		integration.node.agentClass = 'releaser';
		integration.node.workItemId = 'simulate-release';
		integration.node.requestedPermissions.tools = [...permissions.tools, 'release'];
		integration.effectiveProfile.handler = 'releaser';
		integration.effectiveProfile.permissionCeiling.tools = [...permissions.tools, 'release'];
		integration.predecessorResults = ['8', '9'].map((digit) => ({
			schemaVersion: 'treeseed.assignment-result/v1', id: `predecessor-${digit}`, assignmentId: `assignment-${digit}`,
			status: 'completed', summary: 'Reviewed predecessor.',
			references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: digit.repeat(40) }],
			verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z',
		})) as never;
		const result = buildAssignmentAttempt({ candidate: integration as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never,
			attempt: 1, now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.workspace).toMatchObject({ mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'c'.repeat(40) });
		expect(result.assignment.predecessorResultIds).toEqual(['predecessor-8', 'predecessor-9']);
		expect(result.assignment.grant.tools).toContain('release');
	});

	it('fails closed when no exact provider runtime satisfies the node', () => {
		expect(() => buildAssignmentAttempt({
			candidate: candidate as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [{ ...provider, capabilities: [] }] as never,
			attempt: 1, now: '2026-09-13T12:00:00.000Z',
	})).toThrow(/No advertised provider runtime/u);
	});

	it('selects the least-privileged offer satisfying the compiled node demand', () => {
		const broad = { ...provider.offers[0]!, offerId: 'broad', capabilities: [{ id: 'code-change' }, { id: 'release' }] };
		const narrow = { ...provider.offers[0]!, offerId: 'narrow', capabilities: [{ id: 'code-change' }] };
		const result = buildAssignmentAttempt({
			candidate: candidate as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [{ ...provider, offers: [broad, narrow] }] as never,
			attempt: 1, now: '2026-09-13T12:00:00.000Z',
		});
		expect(result.assignment.provider.offerId).toBe('narrow');
	});

	it('selects another eligible provider when the first has no workday allocation left', () => {
		const exhausted = { ...provider, id: 'a-exhausted', offers: [{ ...provider.offers[0]!, offerId: 'exhausted-offer' }] };
		const available = { ...provider, id: 'b-available', offers: [{ ...provider.offers[0]!, offerId: 'available-offer' }] };
		const result = buildAssignmentAttempt({ candidate: candidate as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: {
				'a-exhausted': { measurements: [], constraints: [{ id: 'workday-phase-share', remainingSeconds: 0 }],
					opportunity: { availableSeconds: 0 } },
				'b-available': { measurements: [], constraints: [{ id: 'workday-phase-share', remainingSeconds: 300 }],
					opportunity: { availableSeconds: 300 } },
			} as never,
			providerSessionId: 'session', providers: [exhausted, available] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.provider).toMatchObject({ executionProviderId: 'b-available', offerId: 'available-offer' });
	});

	it('keeps planning turns at the policy slot instead of calibrating them from prior short turns', () => {
		const planning = structuredClone(candidate);
		planning.node.kind = 'planning' as never;
		planning.node.pairRole = null;
		planning.node.workspace = 'read-only';
		planning.node.estimate = { minimumSeconds: 1, expectedSeconds: 60, maximumSeconds: 60 };
		planning.node.requestedPermissions = { content: { read: ['proposal'], write: [] }, tools: ['source.read'] } as never;
		planning.effectiveProfile = { ...planning.effectiveProfile, activity: 'planning', handler: 'planner',
			permissionCeiling: planning.node.requestedPermissions } as never;
		const result = buildAssignmentAttempt({ candidate: planning as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [{ id: 'short', completedAt: '2026-09-13T11:00:00.000Z',
				expectedSeconds: 60, allocatedSeconds: 60, activeSeconds: 1, outcome: 'completed' }], constraints: [] } },
			providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.limits.maximumSeconds).toBe(60);
		expect(result.allocation.calibration.measurementIds).toEqual([]);
	});

	it('shortens a planning turn below its ceiling when the remaining phase share is still viable', () => {
		const planning = structuredClone(candidate);
		planning.node.kind = 'planning' as never;
		planning.node.pairRole = null;
		planning.node.workspace = 'read-only';
		planning.node.estimate = { minimumSeconds: 1, expectedSeconds: 60, maximumSeconds: 60 };
		planning.node.requestedPermissions = { content: { read: ['proposal'], write: [] }, tools: ['source.read'] } as never;
		planning.effectiveProfile = { ...planning.effectiveProfile, activity: 'planning', handler: 'planner',
			permissionCeiling: planning.node.requestedPermissions } as never;
		const result = buildAssignmentAttempt({ candidate: planning as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [
				{ id: 'workday-phase-share', remainingSeconds: 30 },
			] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.limits.maximumSeconds).toBe(30);
		expect(result.allocation).toMatchObject({ admitted: true, minimumSeconds: 1,
			limitingConstraint: 'workday-phase-share' });
	});

	it('defers a planning turn when the remaining phase cannot fit its full policy-owned slot', () => {
		const planning = structuredClone(candidate);
		planning.node.kind = 'planning' as never;
		planning.node.pairRole = null;
		planning.node.workspace = 'read-only';
		planning.node.estimate = { minimumSeconds: 1, expectedSeconds: 60, maximumSeconds: 60 };
		planning.node.requestedPermissions = { content: { read: ['proposal'], write: [] }, tools: ['source.read'] } as never;
		planning.effectiveProfile = { ...planning.effectiveProfile, activity: 'planning', handler: 'planner',
			permissionCeiling: planning.node.requestedPermissions } as never;
		expect(() => buildAssignmentAttempt({ candidate: planning as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } },
			providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:59:01.000Z' })).toThrow(/cannot fit the viable task minimum/u);
	});

	it('rejects executable nodes whose capability demand was not compiled', () => {
		const missing = structuredClone(candidate);
		missing.node.requiredCapabilities = [];
		expect(() => buildAssignmentAttempt({
			candidate: missing as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never,
			attempt: 1, now: '2026-09-13T12:00:00.000Z',
		})).toThrow(/must declare its provider capability demand/u);
	});

	it('rejects authority outside the effective profile ceiling', () => {
		const elevated = structuredClone(candidate);
		elevated.node.requestedPermissions = { ...elevated.node.requestedPermissions,
			tools: [...elevated.node.requestedPermissions.tools, 'release'] as never };
		expect(() => buildAssignmentAttempt({
			candidate: elevated as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z',
		})).toThrow(/outside its effective activity profile/u);
	});

	it('rejects two mutable custody systems in one assignment', () => {
		const dual = structuredClone(candidate);
		dual.node.requestedPermissions.content.write = ['note'] as never;
		dual.effectiveProfile.permissionCeiling.content.write = ['note'] as never;
		expect(() => buildAssignmentAttempt({
			candidate: dual as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z',
		})).toThrow(/Content writes require a TreeDX workspace/u);
	});

	it('defers instead of extending beyond the viable remaining workday window', () => {
		const nearEnd = structuredClone(candidate);
		nearEnd.node.estimate.maximumSeconds = 600;
		expect(() => buildAssignmentAttempt({
			candidate: nearEnd as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:59:30.000Z',
		})).toThrow('The remaining execution window cannot fit the viable task minimum.');
	});

	it('uses the independent communication lane for chat nodes', () => {
		const chat = structuredClone(candidate);
		chat.node.kind = 'communication' as never;
		chat.node.pairRole = null;
		chat.node.sourceRef = { ...sourceRef, model: 'discussion', id: 'message', path: 'discussion-messages/thread/message.mdx' } as never;
		chat.node.workspace = 'treedx';
		chat.node.requestedPermissions = { content: { read: ['discussion'], write: ['discussion'] }, tools: ['source.read'] } as never;
		chat.effectiveProfile = { ...chat.effectiveProfile, activity: 'chat', handler: 'writer',
			permissionCeiling: chat.node.requestedPermissions } as never;
		chat.contextRefs = [];
		chat.sourceRepositories = ['repository-sdk'];
		const communicationProvider = { ...provider, lanes: [{ ...provider.lanes[0]!, id: 'chat', purpose: 'communication' }] };
		const result = buildAssignmentAttempt({ candidate: chat as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [communicationProvider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' });
		expect(result).toMatchObject({ laneId: 'chat', lanePurpose: 'communication', assignment: {
			effectiveProfile: { activity: 'chat' }, grant: { sourceRead: ['repository-sdk'], contentRead: [
				{ model: 'discussion', path: 'discussion-messages/thread/message.mdx' },
				{ model: 'discussion', path: 'discussions/thread.mdx' },
			], contentWrite: [
				{ model: 'discussion', path: 'discussion-messages/**' },
				{ model: 'discussion', path: 'discussion-events/**' },
			] }, workspace: { mode: 'treedx', writablePaths: [
				'discussion-messages/**', 'discussion-events/**',
			] },
		} });
	});
});
