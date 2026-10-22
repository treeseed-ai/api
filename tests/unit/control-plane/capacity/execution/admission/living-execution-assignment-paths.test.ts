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
import { canonicalOfferBuildInput } from '../fixtures/assignment-attempt-fixtures.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../../../src/api/capacity/control-plane.ts';
import { CapacityGovernanceError } from '../../../../../../src/api/capacity/database.ts';

describe('living execution TreeDX path authority', () => {
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
		expect(boundary.admit).toHaveBeenCalledTimes(2);
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
