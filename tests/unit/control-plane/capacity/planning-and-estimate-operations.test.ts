import { describe, expect, it, vi } from 'vitest';
import { createPlanningAndEstimateOperations } from '../../../../src/api/control-plane/catalog/capacity/planning-and-estimates.ts';
import { createAgentGovernanceOperations } from '../../../../src/api/control-plane/catalog/capacity/agent-governance.ts';
import { createCommunicationOperations } from '../../../../src/api/control-plane/catalog/capacity/communications.ts';
import { createPlanningAndEstimateService } from '../../../../src/api/control-plane/repositories/capacity/planning-and-estimate-service.ts';
import { createCommunicationService } from '../../../../src/api/control-plane/repositories/capacity/communication-service.ts';

const principal = { id: 'user-a', roles: [], permissions: [] };

function store(overrides: Record<string, unknown> = {}) {
	return {
		async getProjectDetails() { return { project: { id: 'project-a', teamId: 'team-a' } }; },
		async principalCanAccessTeam() { return true; },
		async getTeamAccessSummary() { return { permissions: ['projects:read:team', 'projects:manage:team'] }; },
		...overrides,
	};
}

describe('planning and estimate catalog operations', () => {
	it('binds exactly the retained planning and estimate operation classes', () => {
		const service = new Proxy({}, { get: () => vi.fn() });
		const operations = createPlanningAndEstimateOperations({ planningAndEstimates: service as never });
		expect(operations.map((operation) => operation.binding.descriptor.operationId)).toEqual([
			'planning.status.show', 'planning.input.requests.create', 'planning.execution.inputs.list',
			'planning.execution.inputs.create', 'planning.execution.inputs.accept', 'planning.execution.inputs.revision.request',
			'estimates.create', 'estimates.list', 'estimates.accept', 'estimates.reject',
		]);
	});

	it('binds exactly the retained graph, research, and communication operation classes', () => {
		const service = new Proxy({}, { get: () => vi.fn() });
		expect(createAgentGovernanceOperations({ agentGovernance: service as never })).toHaveLength(12);
		expect(createCommunicationOperations({ communications: service as never })
			.map((operation) => operation.binding.descriptor.operationId)).toEqual([
				'communications.invocations.list', 'communications.invocations.show', 'communications.status.show',
				'communications.handoffs.list', 'communications.client.actions.list', 'communications.invocations.cancel',
			]);
	});

	it('validates filters before querying execution-input persistence', async () => {
		const list = vi.fn();
		const service = createPlanningAndEstimateService(store({
			async getDecisionPlanningStatus() { return { projectId: 'project-a' }; },
			listDecisionExecutionInputs: list,
		}));
		await expect(service.executionInputs(principal, 'decision-a', { status: 'approved' }))
			.rejects.toMatchObject({ code: 'decision_execution_input_status_invalid', status: 400 });
		expect(list).not.toHaveBeenCalled();
	});

	it('authorizes the target project before estimate mutation', async () => {
		const update = vi.fn();
		const service = createPlanningAndEstimateService(store({
			async principalCanAccessTeam() { return false; },
			async getStructuredAgentEstimate() { return { id: 'estimate-a', projectId: 'project-a' }; },
			updateStructuredAgentEstimateStatus: update,
		}));
		await expect(service.transitionEstimate(principal, 'estimate-a', 'accepted', {}))
			.rejects.toMatchObject({ code: 'team_access_denied', status: 403 });
		expect(update).not.toHaveBeenCalled();
	});

	it('rejects a stale invocation revision before communication mutation', async () => {
		const update = vi.fn();
		const service = createCommunicationService({
			async principalCanAccessTeam() { return true; },
			async getTeamAccessSummary() { return { permissions: ['projects:manage:team'] }; },
			async first() { return { id: 'invocation-a', team_id: 'team-a', status: 'queued', updated_at: 'revision-2' }; },
			run: update,
		});
		await expect(service.cancel(principal, 'team-a', 'invocation-a', {}, 'request-a', 'revision-1'))
			.rejects.toMatchObject({ code: 'agent_invocation_precondition_failed', status: 412 });
		expect(update).not.toHaveBeenCalled();
	});
});
