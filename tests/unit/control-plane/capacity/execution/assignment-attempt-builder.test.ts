import { describe, expect, it } from 'vitest';
import { buildAssignmentAttempt } from '../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { candidate, permissions, provider, run, sourceRef } from './fixtures/assignment-attempt-fixtures.ts';

describe('immutable assignment-attempt construction', () => {
	it('calibrates exact review history without inventing a minimum allocation floor', () => {
		const review = structuredClone(candidate); Object.assign(review.node, { kind: 'reviewing', pairRole: null, agentClass: 'reviewer', workspace: 'read-only', estimate: { expectedSeconds: 100, maximumSeconds: 165 }, requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read', 'verification'] } });
		Object.assign(review.effectiveProfile, { activity: 'reviewing', handler: 'reviewer', permissionCeiling: review.node.requestedPermissions });
		const measurements = Array.from({ length: 20 }, (_, index) => ({ id: `review-${index}`, completedAt: new Date(Date.parse('2026-09-13T11:30:00.000Z') + index * 1000).toISOString(), expectedSeconds: 250, allocatedSeconds: 200, activeSeconds: 84, outcome: 'completed' as const }));
		const build = (item: typeof review, constraints: Array<{ id: string; remainingSeconds: number }> = []) => buildAssignmentAttempt({ candidate: item as never, run, principal: { teamId: 'team', capacityProviderId: 'provider' } as never, allocationInputs: { codex: { measurements, constraints } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1, now: '2026-09-13T12:01:00.000Z' });
		const original = structuredClone({ review, measurements, run, provider }); for (const item of [review, { ...review, node: { ...review.node, pairRole: 'reviewer' } }]) {
			const result = build(item); expect(result.allocation).toMatchObject({ admitted: true, desiredSeconds: 73, allocatedSeconds: 73,
				calibration: { measurementIds: measurements.map(({ id }) => id) } });
			expect(result.allocation).not.toHaveProperty('minimumSeconds'); expect(result.allocation).not.toHaveProperty('observedMinimumSeconds');
			expect(result.assignment.estimate).toEqual({ expectedSeconds: 100, maximumSeconds: 165 });
			const short = build(item, [{ id: 'controlled-supply', remainingSeconds: 3 }]); expect(short.allocation).toMatchObject({ admitted: true, allocatedSeconds: 3, desiredSeconds: 73 });
			expect(short.assignment.limits.maximumSeconds).toBe(3); expect(short.assignment.deadline).toBe(result.assignment.deadline);
			expect(() => build(item, [{ id: 'controlled-supply', remainingSeconds: 0 }])).toThrow('No positive active-time allocation remains');
		} expect({ review, measurements, run, provider }).toEqual(original);
	});
	it('gives planning discussion the policy turn ceiling without changing acting chat allocation', () => {
		const discussion = structuredClone(candidate);
		discussion.node.kind = 'communication';
		discussion.node.pairRole = null as never;
		discussion.node.estimate = { expectedSeconds: 180, maximumSeconds: 180 };
		discussion.node.requiredCapabilities = ['conversation'];
		discussion.node.workspace = 'treedx';
		discussion.node.sourceRef = { ...sourceRef, model: 'discussion', path: 'discussion-messages/one.mdx' } as never;
		discussion.node.requestedPermissions = { content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'] } as never;
		discussion.effectiveProfile.permissionCeiling = discussion.node.requestedPermissions;
		discussion.effectiveProfile.activity = 'chat';
		const offered = { ...provider, capabilities: ['conversation'],
			accountingLimits: { ...provider.accountingLimits, capabilityLimits: { conversation: { dailyActiveSecondsLimit: 28800 } } },
			accountingObservation: { ...provider.accountingObservation,
				capabilityUsage: { conversation: provider.accountingObservation.modelUsage } },
			lanes: [{ ...provider.lanes[0]!, purpose: 'communication', capabilities: ['conversation'] }],
			offers: [{ offerId: 'codex-conversation', capabilities: [{ id: 'conversation' }] }] };
		const measurements = [{ id: 'successful-short-chat', completedAt: '2026-09-13T11:59:00.000Z',
			expectedSeconds: 180, allocatedSeconds: 90, activeSeconds: 45, outcome: 'completed' }];
		const chatRun = structuredClone(run) as { parameters: { appliedPlan: { policySnapshot: { planningTurnMaximumSeconds: number } } } };
		chatRun.parameters.appliedPlan.policySnapshot.planningTurnMaximumSeconds = 180;
		const build = (now: string) => buildAssignmentAttempt({ candidate: discussion as never, run: chatRun as never,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements, constraints: [] } } as never, providerSessionId: 'session',
			providers: [{ ...offered, accountingObservation: { ...offered.accountingObservation,
				modelUsage: { ...offered.accountingObservation.modelUsage, observedAt: now },
				capabilityUsage: { conversation: { ...offered.accountingObservation.modelUsage, observedAt: now } } } }] as never,
			attempt: 1, now });
		const planning = build('2026-09-13T12:01:00.000Z');
		expect(planning.assignment.limits.maximumSeconds).toBe(180);
		expect(planning.allocation.calibration.measurementIds).toEqual([]);
		expect(build('2026-09-13T12:11:30.000Z').assignment.limits.maximumSeconds).toBe(30);
		const acting = build('2026-09-13T12:30:00.000Z');
		expect(acting.allocation.calibration.measurementIds).toEqual(['successful-short-chat']);
		expect(acting.assignment.limits.maximumSeconds).toBe(162);
	});
	it('uses the total five-slot ceiling rather than remaining headroom for atomic admission', () => {
		for (const remaining of [5, 3, 1]) {
			const offered = { ...provider, availableConcurrency: remaining, maxConcurrentRunners: 5,
				lanes: [{ ...provider.lanes[0]!, maxConcurrentRunners: 5 }] };
			const result = buildAssignmentAttempt({ candidate: candidate as never, run,
				principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
				allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
				providers: [offered] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' });
			expect(result.providerConcurrencyLimit).toBe(5);
		}
		const offered = { ...provider, availableConcurrency: 0, maxConcurrentRunners: 5 };
		expect(() => buildAssignmentAttempt({ candidate: candidate as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [offered] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' })).toThrow();
	});
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

	it('writes planning content to its project library while retaining Team Library as read-only context', () => {
		const planning = structuredClone(candidate);
		planning.node.kind = 'planning';
		planning.node.workspace = 'treedx';
		planning.node.sourceRef = { store: 'postgresql', model: 'workday', id: 'workday', revision: 1,
			digest: `sha256:${'2'.repeat(64)}` } as never;
		planning.node.requestedPermissions = { content: { read: ['objective', 'book'], write: ['note'] }, tools: ['source.read'] } as never;
		planning.effectiveProfile.permissionCeiling = planning.node.requestedPermissions;
		const team = { store: 'treedx', model: 'objective', id: 'team-objective', repository: 'team-library',
			commit: '8'.repeat(40), path: 'objectives/team.md', revision: 1, digest: `sha256:${'8'.repeat(64)}` };
		const project = { store: 'treedx', model: 'objective', id: 'sdk-objective', repository: 'sdk-library',
			commit: '9'.repeat(40), path: 'objectives/sdk.md', revision: 1, digest: `sha256:${'9'.repeat(64)}` };
		planning.contextRefs = [team, project] as never;
		planning.projectContentRepositoryId = 'sdk-library';
		const result = buildAssignmentAttempt({ candidate: planning as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.contextRefs).toContainEqual(team);
		expect(result.assignment.workspace).toMatchObject({ mode: 'treedx', repository: 'sdk-library', baseCommit: '9'.repeat(40) });
		expect(result.assignment.grant.contentWrite).toEqual([expect.objectContaining({ repository: 'sdk-library' })]);
		expect(result.assignment.grant.contentRead).toContainEqual(team);
	});

	it('rejects a writable TreeDX source bound to another project library', () => {
		const misplaced = structuredClone(candidate);
		misplaced.node.workspace = 'treedx';
		misplaced.node.sourceRef = { ...sourceRef, repository: 'team-library' };
		misplaced.node.requestedPermissions = { content: { read: ['proposal'], write: ['proposal'] }, tools: ['source.read'] } as never;
		misplaced.effectiveProfile.permissionCeiling = misplaced.node.requestedPermissions;
		expect(() => buildAssignmentAttempt({ candidate: misplaced as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' }))
			.toThrow('Writable TreeDX content must belong to the assignment project library.');
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
		planning.node.estimate = { expectedSeconds: 60, maximumSeconds: 60 };
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
		planning.node.estimate = { expectedSeconds: 60, maximumSeconds: 60 };
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
		expect(result.allocation).toMatchObject({ admitted: true,
			limitingConstraint: 'workday-phase-share' });
	});

	it('defers a planning turn when no positive authority window remains', () => {
		const planning = structuredClone(candidate);
		planning.node.kind = 'planning' as never;
		planning.node.pairRole = null;
		planning.node.workspace = 'read-only';
		planning.node.estimate = { expectedSeconds: 60, maximumSeconds: 60 };
		planning.node.requestedPermissions = { content: { read: ['proposal'], write: [] }, tools: ['source.read'] } as never;
		planning.effectiveProfile = { ...planning.effectiveProfile, activity: 'planning', handler: 'planner',
			permissionCeiling: planning.node.requestedPermissions } as never;
		expect(() => buildAssignmentAttempt({ candidate: planning as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } },
			providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T13:00:00.000Z' })).toThrow(/No positive active-time allocation remains/u);
	});

	it('allocates a paired work review from the acting window without a minimum floor', () => {
		const review = structuredClone(candidate);
		review.node.kind = 'reviewing' as never;
		review.node.pairRole = 'reviewer';
		review.node.workItemId = 'architecture';
		review.node.sourceRef = sourceRef;
		review.node.workspace = 'treedx';
		review.node.estimate = { expectedSeconds: 1320, maximumSeconds: 1980 };
		review.node.requestedPermissions = { content: { read: ['proposal'], write: ['decision'] },
			tools: ['source.read', 'verification'] } as never;
		review.effectiveProfile.activity = 'reviewing';
		review.effectiveProfile.permissionCeiling = review.node.requestedPermissions;
		const currentObservation = { ...provider.accountingObservation.modelUsage, observedAt: '2026-09-13T12:30:00.000Z' };
		const reviewProvider = { ...provider, accountingObservation: { modelUsage: currentObservation,
			capabilityUsage: { 'code-change': currentObservation } } };
		const result = buildAssignmentAttempt({ candidate: review as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [],
				opportunity: { phase: 'acting', availableSeconds: 1800 } } } as never,
			providerSessionId: 'session', providers: [reviewProvider] as never, attempt: 1,
			now: '2026-09-13T12:30:00.000Z' });
		expect(result.allocation.admitted).toBe(true);
		expect(result.assignment.limits.maximumSeconds).toBeGreaterThan(0);
		expect(Date.parse(result.assignment.deadline)).toBeGreaterThan(Date.parse('2026-09-13T12:20:00.000Z'));
		expect(Date.parse(result.assignment.deadline)).toBeLessThanOrEqual(Date.parse('2026-09-13T13:00:00.000Z'));
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

	it('defers instead of extending beyond an exhausted workday window', () => {
		const nearEnd = structuredClone(candidate);
		nearEnd.node.estimate.maximumSeconds = 600;
		expect(() => buildAssignmentAttempt({
			candidate: nearEnd as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session', providers: [provider] as never, attempt: 1,
			now: '2026-09-13T13:00:00.000Z',
		})).toThrow('No positive active-time allocation remains');
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
