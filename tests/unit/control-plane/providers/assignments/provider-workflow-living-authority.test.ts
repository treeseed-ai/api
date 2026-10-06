import { describe, expect, it } from 'vitest';
import { createProviderWorkflowService } from '../../../../../src/api/control-plane/repositories/providers/provider-workflow-service.ts';

const principal = { membershipId: 'membership', teamId: 'team', capacityProviderId: 'provider', scopes: ['provider:assignments:write'] };
const assignment = {
	id: 'assignment', membershipId: 'membership', teamId: 'team', capacityProviderId: 'provider',
	status: 'leased', leaseState: 'leased', leaseToken: 'lease', leaseExpiresAt: '9999-01-01T00:00:00Z',
	mode: 'acting', decisionId: 'decision', reservationId: 'reservation', executionNodeId: 'node',
	capabilityHandles: { workflowOperations: [] },
};

describe('provider workflow living-graph authority', () => {
	it('accepts node and reservation provenance without a retired allocation set', async () => {
		const service = createProviderWorkflowService({ getProviderAssignment: async () => assignment } as never);
		await expect(service.dispatch({ principal }, assignment.id, 'operation', { leaseToken: 'lease' }))
			.rejects.toMatchObject({ code: 'assignment_workflow_handle_denied' });
	});

	it('denies missing living-graph reservation or node', async () => {
		for (const missing of ['reservationId', 'executionNodeId'] as const) {
			const service = createProviderWorkflowService({ getProviderAssignment: async () => ({ ...assignment, [missing]: null }) } as never);
			await expect(service.dispatch({ principal }, assignment.id, 'operation', { leaseToken: 'lease' }))
				.rejects.toMatchObject({ code: 'assignment_workflow_acting_readiness_required' });
		}
	});
});
