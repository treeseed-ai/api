import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createProviderAssignmentOperations } from '../../../../src/api/control-plane/catalog/providers/assignments.ts';
import { createProviderAssignmentService } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';

function dependencies() {
	return {
		providerAssignments: { sourceCandidate: vi.fn(), sourceChunk: vi.fn(), sourceWorkspace: vi.fn(), next: vi.fn(), show: vi.fn(), explain: vi.fn(), renew: vi.fn(), startExecution: vi.fn(), startCloseout: vi.fn(),
			preflight: vi.fn(), respondToDiscussion: vi.fn(), acknowledgeCommunication: vi.fn(), traceCommunication: vi.fn(), returnAssignment: vi.fn(), complete: vi.fn(), fail: vi.fn(), reportUsage: vi.fn(), settle: vi.fn(), createModeRun: vi.fn(), createEvent: vi.fn() },
		providerSignals: vi.fn(),
		providerWorkflows: { dispatch: vi.fn(), show: vi.fn() },
	} as any;
}

describe('provider assignment operation catalog', () => {
	it('requires provider authentication and signed bounded candidate input before storage', async () => {
		const store = { first: vi.fn(async () => ({ id: 'assignment-1' })) };
		const service = createProviderAssignmentService(store as never, undefined, store, undefined, { controlPlaneId: 'control' });
		await expect(service.sourceCandidate({}, 'assignment-1', {})).rejects.toMatchObject({ code: 'provider_access_token_required' });
		const auth = { principal: { teamId: 'team-1', membershipId: 'membership-1', capacityProviderId: 'provider-1', scopes: ['provider:assignments:write'] } };
		await expect(service.sourceCandidate(auth, 'assignment-1', { verification: { objectClosure: true, ancestry: true } })).rejects.toMatchObject({ code: 'source_candidate_request_invalid' });
		expect(store.first).not.toHaveBeenCalled();
	});
	it('binds runtime and source operations to exact SDK objects', () => {
		const operations = createProviderAssignmentOperations(dependencies());
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.providers.sourceCandidate, CONTROL_PLANE_OPERATIONS.providers.sourceChunk, CONTROL_PLANE_OPERATIONS.providers.sourceWorkspace,
			CONTROL_PLANE_OPERATIONS.providers.nextAssignment, CONTROL_PLANE_OPERATIONS.providers.assignment,
			CONTROL_PLANE_OPERATIONS.providers.assignmentExplanation, CONTROL_PLANE_OPERATIONS.providers.renewAssignment,
			CONTROL_PLANE_OPERATIONS.providers.startExecution, CONTROL_PLANE_OPERATIONS.providers.startCloseout,
			CONTROL_PLANE_OPERATIONS.providers.completionPreflight, CONTROL_PLANE_OPERATIONS.providers.discussionResponse,
			CONTROL_PLANE_OPERATIONS.providers.notificationAcknowledge, CONTROL_PLANE_OPERATIONS.providers.traceEvent,
			CONTROL_PLANE_OPERATIONS.providers.returnAssignment,
			CONTROL_PLANE_OPERATIONS.providers.completeAssignment, CONTROL_PLANE_OPERATIONS.providers.failAssignment,
			CONTROL_PLANE_OPERATIONS.providers.reportUsage, CONTROL_PLANE_OPERATIONS.providers.settleAssignment,
			CONTROL_PLANE_OPERATIONS.providers.createModeRun, CONTROL_PLANE_OPERATIONS.providers.createEvent,
			CONTROL_PLANE_OPERATIONS.providers.publishSignal, CONTROL_PLANE_OPERATIONS.providers.dispatchWorkflow,
			CONTROL_PLANE_OPERATIONS.providers.workflowRun,
		]);
	});

	it('passes provider identity and protocol receipts without REST knowledge', async () => {
		const deps = dependencies(); deps.providerAssignments.reportUsage.mockResolvedValue({ id: 'usage-1' });
		const operation = createProviderAssignmentOperations(deps).find((entry) => entry.binding === CONTROL_PLANE_OPERATIONS.providers.reportUsage)!;
		const auth = { principal: { membershipId: 'membership-1' } };
		await operation.handler({ path: { assignmentId: 'assignment-1' }, query: {}, body: { activeSeconds: 3 } }, {
			interface: 'rest', requestId: 'request-1', idempotencyKey: 'usage-key', providerAuth: auth,
		});
		expect(deps.providerAssignments.reportUsage).toHaveBeenCalledWith(auth, 'assignment-1', { activeSeconds: 3 }, 'usage-key');
	});
});
