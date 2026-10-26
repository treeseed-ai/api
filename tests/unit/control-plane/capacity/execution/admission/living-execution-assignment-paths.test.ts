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
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../../../src/api/capacity/control-plane.ts';

describe('living execution TreeDX path authority', () => {
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
		boundary.admit.mockReset().mockImplementation(async (_store, value) => ({ id: value.assignment.id, assignmentAttempt: value.assignment }));
		const execute = () => assignNextReadyExecutionNode(store, input.principal, input.providerSessionId, input.providers, input.now);
		if (mode === 'bound') {
			const result = await execute(); expect(result.assignment?.assignmentAttempt?.projectId).toBe(candidate.node.projectId);
			expect(createWorkspace).toHaveBeenCalledWith({ id: 'ui' }, run,
				expect.objectContaining({ repositoryId: 'ui-library', baseRef: candidate.node.sourceRef.commit }));
			expect(boundary.admit.mock.calls[0]![1].treedxProxyHandle).toMatchObject({ projectId: candidate.node.projectId, repositoryProjectId: 'ui' });
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
