import { describe, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ runs: vi.fn(), ready: vi.fn(), allocation: vi.fn(), admit: vi.fn() }));
vi.mock('../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts', async importOriginal => ({
	...await importOriginal<object>(), CapacityWorkdayRunRepository: class { listActiveForSupply = boundary.runs; },
}));
vi.mock('../../../../../../src/api/capacity/services/build/ready-execution-node.ts', async importOriginal => ({
	...await importOriginal<object>(), listReadyExecutionNodes: boundary.ready,
}));
vi.mock('../../../../../../src/api/capacity/services/capacity/assignments/admission/living-allocation-inputs.ts', () => ({ livingAllocationInputs: boundary.allocation }));
vi.mock('../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts', async importOriginal => ({
	...await importOriginal<object>(), admitLivingExecutionAssignment: boundary.admit,
}));
import { assignNextReadyExecutionNode, prioritizeCommunicationCandidates, reservationFairUsage, treeDxAuthorizedPaths, workdayConcurrencyAvailable } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/living-execution-assignment.ts';
import { canonicalOfferBuildInput, withIdentityRead } from '../fixtures/assignment-attempt-fixtures.ts';
import { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import * as accounting from '../../../../../../src/api/capacity/services/capacity/accounting/accounting-observations.ts';
import * as transactions from '../../../../../../src/api/capacity/transaction.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../../../src/api/capacity/control-plane.ts';
import { CapacityGovernanceError } from '../../../../../../src/api/capacity/database.ts';

describe('living execution TreeDX path authority', () => {
	it.each([false, true])('replays original authority after a competing synthesis (commit after absence read: %s)', async lateCommit => {
		// API625: native start0924f9a2 left an issued assignment after a graph
		// conflict. A second synthesis rebuilt that identity with a new createdAt.
		// This controlled UNIT models that interleaving; it is not SQL race proof.
		const input = canonicalOfferBuildInput(), issued = buildAssignmentAttempt(input).assignment;
		const retained = { id: issued.id, createdAt: issued.createdAt, teamId: issued.teamId, capacityProviderId: issued.provider.providerId,
			executionNodeId: issued.nodeId, executionNodeRevision: issued.nodeRevision,
			assignmentAttempt: structuredClone(issued), explanation: {} };
		const host = new ControlPlaneStore({}, { prepare: () => { throw new Error('Unexpected native SQL in UNIT'); } });
		host.ensureInitialized = vi.fn(); host.all = vi.fn().mockResolvedValue([]);
		host.first = vi.fn(async <T extends Record<string, unknown>>(query: string) =>
			query.startsWith('SELECT node.id') ? { id: input.candidate.node.id } as unknown as T : null);
		host.listTeamProjects = vi.fn().mockResolvedValue([{ id: input.candidate.node.projectId, slug: input.candidate.node.projectId }]);
		host.getProjectByTeamAndSlug = vi.fn().mockResolvedValue(null); host.getProjectTreeDxLibrary = vi.fn().mockResolvedValue(null);
		const store = createCapacityControlPlane(host);
		boundary.runs.mockResolvedValue([{ ...input.run, parameters: { ...input.run.parameters,
			projects: [input.candidate.node.projectId], scheduledProjectIds: [input.candidate.node.projectId] } }]);
		boundary.ready.mockResolvedValue([input.candidate]); boundary.allocation.mockResolvedValue(input.allocationInputs);
		const actual = await vi.importActual<typeof import('../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts')>(
			'../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts');
		boundary.admit.mockReset().mockImplementation(async (_database, value) => {
			retained.assignmentAttempt = structuredClone(value.assignment);
			retained.explanation = { metadata: { allocation: structuredClone(value.allocation) } };
			return retained;
		});
		await assignNextReadyExecutionNode(store, input.principal, input.providerSessionId, input.providers, input.now);
		const original = structuredClone(retained);
		const lookup = vi.spyOn(ProviderAssignmentRepository.prototype, 'get').mockResolvedValue(retained as never);
		const observation = vi.spyOn(accounting, 'recordCapacityAccountingObservation').mockResolvedValue({} as never);
		const transaction = vi.spyOn(transactions, 'capacityTransaction').mockImplementation(async (database, apply) => apply(database));
		boundary.admit.mockImplementation(actual.admitLivingExecutionAssignment);
		try {
			await expect(assignNextReadyExecutionNode(store, input.principal, input.providerSessionId, input.providers, input.now))
				.resolves.toMatchObject({ assignment: retained });
			const later = new Date(Date.parse(input.now) + 1_000).toISOString();
			if (lateCommit) lookup.mockResolvedValueOnce(null);
			await expect(assignNextReadyExecutionNode(store, input.principal, input.providerSessionId, input.providers, later))
				.resolves.toMatchObject({ assignment: retained });
			const changed = structuredClone(input.candidate);
			changed.effectiveProfile.parameters = { changed: true };
			boundary.ready.mockResolvedValue([changed]);
			await expect(assignNextReadyExecutionNode(store, input.principal, input.providerSessionId, input.providers, later))
				.rejects.toMatchObject({ code: 'execution_assignment_idempotency_conflict' });
		} finally {
			lookup.mockRestore(); observation.mockRestore(); transaction.mockRestore();
			expect(retained).toEqual(original);
		}
	});
	it.each(['bound', 'missing', 'ambiguous'])('creates a shared proposal estimate workspace only through its unique team library owner: %s', async mode => {
		const input = canonicalOfferBuildInput(), candidate = structuredClone(input.candidate);
		candidate.node.kind = 'estimating'; candidate.node.pairRole = null; delete candidate.node.workItemId; candidate.node.workspace = 'treedx';
		candidate.node.sourceRef = { ...candidate.node.sourceRef, repository: 'ui-library' };
		candidate.node.requestedPermissions = { content: { read: ['proposal'], write: ['proposal'] }, tools: ['source.read'] };
		candidate.effectiveProfile.activity = 'estimating'; candidate.effectiveProfile.permissionCeiling = withIdentityRead(candidate.node.requestedPermissions) as never;
		candidate.contextRefs = [candidate.node.sourceRef]; candidate.projectContentRepositoryId = 'worker-library';
		const plan = input.run.parameters.appliedPlan;
		const run = { ...input.run, parameters: { ...input.run.parameters, projects: [candidate.node.projectId],
			scheduledProjectIds: [candidate.node.projectId], appliedPlan: { ...plan,
				planningRounds: plan.planningRounds.map((round,index)=>({ ...round, state: index === 0 ? 'active' : 'pending' })) } } };
		const host = new ControlPlaneStore({}, { prepare: () => { throw new Error('Unexpected SQL in controlled admission UNIT'); } });
		host.ensureInitialized = vi.fn(); host.all = vi.fn().mockResolvedValue([]); host.first = vi.fn().mockResolvedValue(null);
		host.listTeamProjects = vi.fn().mockResolvedValue([{ id: candidate.node.projectId, slug: candidate.node.projectId },
			...(mode === 'missing' ? [] : [{ id: 'ui', slug: 'ui' }]), ...(mode === 'ambiguous' ? [{ id: 'duplicate-owner', slug: 'duplicate-owner' }] : [])]);
		host.getProjectByTeamAndSlug = vi.fn().mockResolvedValue(null);
		host.getProjectTreeDxLibrary = vi.fn(async (id: string) => ({ repositoryId: id === candidate.node.projectId ? 'worker-library' : 'ui-library' })) as never;
		const store = createCapacityControlPlane(host);
		const createWorkspace = vi.spyOn(store, 'createCapacityWorkdayTreeDxWorkspace').mockResolvedValue({ baseCommitSha: candidate.node.sourceRef.commit });
		boundary.runs.mockResolvedValue([run]); boundary.ready.mockResolvedValue([candidate]); boundary.allocation.mockResolvedValue(input.allocationInputs);
		boundary.admit.mockReset().mockImplementation(async (_store, value) => ({ id: value.assignment.id,
			assignmentAttempt: value.assignment, treedxProxyHandle: value.treedxProxyHandle }));
		const execute = () => assignNextReadyExecutionNode(store, input.principal, input.providerSessionId, input.providers, input.now);
		if (mode === 'bound') {
			const result = await execute(); expect(result.assignment?.assignmentAttempt?.projectId).toBe(candidate.node.projectId);
			expect(createWorkspace).toHaveBeenCalledWith({ id: 'ui' }, run,
				expect.objectContaining({ repositoryId: 'ui-library', baseRef: candidate.node.sourceRef.commit }));
			expect(boundary.admit.mock.calls[0]![1].treedxProxyHandle).toMatchObject({ projectId: candidate.node.projectId, repositoryProjectId: 'ui' });
			const lookup = vi.spyOn(ProviderAssignmentRepository.prototype, 'get').mockResolvedValue(result.assignment as never);
			try {
				const replay = await assignNextReadyExecutionNode(store, input.principal, input.providerSessionId, input.providers,
					new Date(Date.parse(input.now) + 1_000).toISOString());
				expect(replay.assignment).toEqual(result.assignment);
				expect(createWorkspace).toHaveBeenCalledTimes(1);
			} finally { lookup.mockRestore(); }
		} else {
			await expect(execute()).rejects.toMatchObject({ code: 'assignment_content_project_mismatch' });
			expect(createWorkspace).not.toHaveBeenCalled(); expect(boundary.admit).not.toHaveBeenCalled();
		}
	});
	it('ranks only fully provider-qualified candidates and records the exact eligible inventory without changing rejected high-priority input', async () => {
		const input = canonicalOfferBuildInput(), qualified = { ...input.candidate, node: { ...input.candidate.node, id: 'qualified', priority: 1 } };
		const denied = { ...qualified, node: { ...qualified.node, id: 'denied', priority: 100, requiredCapabilities: ['unavailable-capability'] } };
		for (const priority of [100, -100]) for (const candidates of [
			[{ ...denied, node: { ...denied.node, priority } }, qualified],
			[qualified, { ...denied, node: { ...denied.node, priority } }],
		]) {
			const held = structuredClone({ candidates, input });
			const host = new ControlPlaneStore({}, { prepare: () => { throw new Error('Unexpected native SQL in UNIT'); } });
			host.ensureInitialized = vi.fn(); host.all = vi.fn().mockResolvedValue([]);
			vi.spyOn(host, 'first').mockImplementation(async <T extends Record<string, unknown>>(query: string) => {
				const row: Record<string, unknown> = { id: qualified.node.id };
				return query.startsWith('SELECT node.id') ? row as T : null;
			});
			host.listTeamProjects = vi.fn().mockResolvedValue([{ id: qualified.node.projectId, slug: qualified.node.projectId }]);
			host.getProjectByTeamAndSlug = vi.fn().mockResolvedValue(null); host.getProjectTreeDxLibrary = vi.fn().mockResolvedValue(null);
			boundary.runs.mockResolvedValue([{ ...input.run, parameters: { ...input.run.parameters, projects: [qualified.node.projectId], scheduledProjectIds: [qualified.node.projectId] } }]);
			boundary.ready.mockResolvedValue(candidates); boundary.allocation.mockResolvedValue(input.allocationInputs);
			boundary.admit.mockReset().mockImplementation(async (_store, value) => ({ id: value.assignment.id,
				assignmentAttempt: value.assignment, explanation: { metadata: { allocation: value.allocation } } }));
			const observed = await assignNextReadyExecutionNode(createCapacityControlPlane(host), input.principal, input.providerSessionId, input.providers, input.now);
			expect(boundary.admit).toHaveBeenCalledTimes(1);
			expect(observed.assignment?.assignmentAttempt?.nodeId).toBe(qualified.node.id);
			expect(boundary.admit.mock.calls[0]![1].allocation.selection.input.nodes).toEqual([{ id: 'qualified', projectId: qualified.node.projectId,
				agentClass: qualified.node.agentClass, priority: 1, readyAt: qualified.readyAt }]);
			expect(observed.selection.providerUnavailable).toBe(1); expect({ candidates, input }).toEqual(held);
		}
	});
	it('admits a healthy other-project candidate while auditing an invalid predecessor candidate', async () => {
		const input = canonicalOfferBuildInput();
		const rejected = { ...input.candidate, node: { ...input.candidate.node, id: 'invalid-rework', projectId: 'project-a', priority: 100 } };
		const healthy = { ...input.candidate, node: { ...input.candidate.node, id: 'healthy-other-project', projectId: 'project-b', priority: 1 } };
		const host = new ControlPlaneStore({}, { prepare: () => { throw new Error('Unexpected native SQL in UNIT'); } });
		host.ensureInitialized = vi.fn(); host.all = vi.fn().mockResolvedValue([]);
		vi.spyOn(host, 'first').mockImplementation(async <T extends Record<string, unknown>>(query: string) => {
			const row: Record<string, unknown> = { id: healthy.node.id };
			return query.startsWith('SELECT node.id') ? row as T : null;
		});
		host.listTeamProjects = vi.fn().mockResolvedValue([{ id: 'project-a', slug: 'a' }, { id: 'project-b', slug: 'b' }]);
		host.getProjectByTeamAndSlug = vi.fn().mockResolvedValue(null); host.getProjectTreeDxLibrary = vi.fn().mockResolvedValue(null);
		boundary.runs.mockResolvedValue([{ ...input.run, parameters: { ...input.run.parameters, projects: ['project-a', 'project-b'], scheduledProjectIds: ['project-a', 'project-b'] } }]);
		boundary.ready.mockImplementation(async (_store, _run, project) => [rejected, healthy].filter(candidate => candidate.node.projectId === project.id));
		boundary.allocation.mockResolvedValue(input.allocationInputs);
		boundary.admit.mockImplementation(async (_store, value) => {
			if (value.assignment.nodeId === rejected.node.id) throw new CapacityGovernanceError(
				'assignment_predecessor_authority_mismatch', 'Every predecessor artifact requires its exact context and read grant.', 409,
				{ predecessorId: 'prior-result' });
			return { id: value.assignment.id, assignmentAttempt: value.assignment };
		});
		const observed = await assignNextReadyExecutionNode(createCapacityControlPlane(host), input.principal, input.providerSessionId, input.providers, input.now);
		expect(observed.assignment?.assignmentAttempt?.nodeId).toBe(healthy.node.id);
		expect(observed.selection.deferredCandidates).toEqual([{
			runId: input.run.id, nodeId: rejected.node.id, code: 'assignment_predecessor_authority_mismatch',
			reason: 'Every predecessor artifact requires its exact context and read grant.', details: { predecessorId: 'prior-result' },
		}]);
		boundary.allocation.mockRejectedValue(new CapacityGovernanceError(
			'execution_assignment_authority_mismatch', 'Shared authority context is invalid.', 403));
		await expect(assignNextReadyExecutionNode(createCapacityControlPlane(host), input.principal,
			input.providerSessionId, input.providers, input.now)).rejects.toMatchObject({
			code: 'execution_assignment_authority_mismatch', message: 'Shared authority context is invalid.',
		});
	});
	it('keeps communication admission independent of the ordinary workday slot', () => {
		const policy = { maximumConcurrency: 1, communicationConcurrency: 2 };
		expect(workdayConcurrencyAvailable('acting', { workday: 1, conversation: 0 }, policy)).toBe(false);
		expect(workdayConcurrencyAvailable('communication', { workday: 1, conversation: 1 }, policy)).toBe(true);
		expect(workdayConcurrencyAvailable('communication', { workday: 0, conversation: 2 }, policy)).toBe(false);
		expect(workdayConcurrencyAvailable('reviewing', { workday: 0, conversation: 2 }, policy)).toBe(true);
	});
	it('services ready communication before ordinary workday candidates', () => {
		const planning = { node: { kind: 'planning', id: 'planning' } };
		const communication = { node: { kind: 'communication', id: 'communication' } };
		expect(prioritizeCommunicationCandidates([planning, communication])).toEqual([communication]);
		expect(prioritizeCommunicationCandidates([planning])).toEqual([planning]);
	});
	it('counts active reservations once and releases unused terminal capacity for fairness', () => {
		const rows = ['reserved', 'consuming', 'consumed', 'released'].map((state) => ({
			project_id: 'sdk', agent_class: 'engineer', state, reserved_seconds: 180, active_seconds: 30, elapsed_seconds: 900 }));
		expect(reservationFairUsage(rows).map((entry) => entry.seconds)).toEqual([180, 180, 30, 30]);
		expect(reservationFairUsage(rows)[0]).toMatchObject({ projectId: 'sdk', agentClass: 'engineer' });
	});
	it('authorizes the resolved file for an extensionless logical path without widening its basename', () => {
		expect(treeDxAuthorizedPaths(['objectives/core', 'README.md', 'discussion-messages/**'])).toEqual([
			'objectives/core', 'objectives/core.md', 'objectives/core.mdx', 'objectives/core.yaml',
			'objectives/core.yml', 'objectives/core.json', 'README.md', 'discussion-messages/**',
		]);
	});
});
