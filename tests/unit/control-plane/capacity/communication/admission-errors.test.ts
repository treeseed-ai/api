import { describe, expect, it, vi } from 'vitest';
import { createCommunicationOperations, type CommunicationOperationDependencies } from '../../../../../src/api/control-plane/catalog/capacity/communications.ts';
import { CapacityGovernanceError } from '../../../../../src/api/capacity/database.ts';
import { ControlPlaneOperationError } from '../../../../../src/api/control-plane/catalog/operation-registry.ts';

describe('communication admission diagnostics', () => {
	const input = { path: { teamId: 'team', channel: 'acceptance' }, query: {}, body: { message: '@sdk/architect Hello' } };
	const context = { interface: 'rest' as const, requestId: 'request', idempotencyKey: 'same-send', principal: { id: 'user' } };
	function operation(send: ReturnType<typeof vi.fn>) {
		return createCommunicationOperations({ communications: { send } as unknown as CommunicationOperationDependencies['communications'] })[0];
	}
	it.each([
		[404, 'communication_agent_not_found', 'No chat-enabled team agent matches @sdk/architect.'],
		[503, 'communication_agent_inventory_unavailable', 'Team agent inventory is unavailable.'],
		[409, 'capacity_unavailable', 'No eligible provider is available.'],
	])('preserves typed admission failure %s/%s', async (status, code, message) => {
		const send = vi.fn().mockRejectedValue(new CapacityGovernanceError(String(code), String(message), Number(status)));
		const failure = operation(send).handler(input, context);
		await expect(failure).rejects.toBeInstanceOf(ControlPlaneOperationError);
		await expect(failure).rejects.toMatchObject({ status, code, message });
	});
	it('keeps unexpected errors internal rather than trusting arbitrary error-shaped objects', async () => {
		const error = Object.assign(new Error('internal detail'), { status: 404, code: 'not_public' });
		await expect(operation(vi.fn().mockRejectedValue(error)).handler(input, context)).rejects.toBe(error);
	});
	it('preserves durable blocked receipts and idempotency instead of converting them into failures', async () => {
		const receipt = { sendId: 'send-1', status: 'blocked', targets: [{ invocationId: 'invocation-1', blockingState: { code: 'capacity_unavailable' } }] };
		const send = vi.fn().mockResolvedValue(receipt);
		await expect(operation(send).handler(input, context)).resolves.toEqual(receipt);
		expect(send).toHaveBeenCalledWith(context.principal, 'team', 'acceptance', input.body, 'same-send');
	});
});
