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
	it('freezes graph, profile, provider build, exact grant, workspace, and estimate', () => {
		const result = buildAssignmentAttempt({
			candidate: candidate as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			providerSessionId: 'session', providers: [provider] as never, attempt: 1,
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
		expect(JSON.stringify(result)).not.toMatch(/capacityPlan|demand|sourceCandidate|artifactManifest|executionPlanRef/u);
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
			providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.workspace).toMatchObject({ baseCommit: '9'.repeat(40) });
	});

	it('fails closed when no exact provider runtime satisfies the node', () => {
		expect(() => buildAssignmentAttempt({
			candidate: candidate as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			providerSessionId: 'session', providers: [{ ...provider, capabilities: [] }] as never,
			attempt: 1, now: '2026-09-13T12:00:00.000Z',
	})).toThrow(/No advertised provider runtime/u);
	});

	it('selects the least-privileged offer satisfying the compiled node demand', () => {
		const broad = { ...provider.offers[0]!, offerId: 'broad', capabilities: [{ id: 'code-change' }, { id: 'release' }] };
		const narrow = { ...provider.offers[0]!, offerId: 'narrow', capabilities: [{ id: 'code-change' }] };
		const result = buildAssignmentAttempt({
			candidate: candidate as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			providerSessionId: 'session', providers: [{ ...provider, offers: [broad, narrow] }] as never,
			attempt: 1, now: '2026-09-13T12:00:00.000Z',
		});
		expect(result.assignment.provider.offerId).toBe('narrow');
	});

	it('rejects executable nodes whose capability demand was not compiled', () => {
		const missing = structuredClone(candidate);
		missing.node.requiredCapabilities = [];
		expect(() => buildAssignmentAttempt({
			candidate: missing as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			providerSessionId: 'session', providers: [provider] as never,
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
			providerSessionId: 'session', providers: [provider] as never, attempt: 1,
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
			providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z',
		})).toThrow(/Content writes require a TreeDX workspace/u);
	});

	it('defers instead of extending beyond the viable remaining workday window', () => {
		const nearEnd = structuredClone(candidate);
		nearEnd.node.estimate.maximumSeconds = 600;
		expect(() => buildAssignmentAttempt({
			candidate: nearEnd as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			providerSessionId: 'session', providers: [provider] as never, attempt: 1,
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
			providerSessionId: 'session', providers: [communicationProvider] as never, attempt: 1,
			now: '2026-09-13T12:00:00.000Z' });
		expect(result).toMatchObject({ laneId: 'chat', lanePurpose: 'communication', assignment: {
			effectiveProfile: { activity: 'chat' }, grant: { sourceRead: ['repository-sdk'], contentWrite: [
				{ model: 'discussion', path: 'discussion-messages/**' },
				{ model: 'discussion', path: 'discussion-events/**' },
			] }, workspace: { mode: 'treedx', writablePaths: [
				'discussion-messages/**', 'discussion-events/**',
			] },
		} });
	});
});
