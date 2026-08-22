import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createPlatformOperations } from '../../../../src/api/control-plane/catalog/operations/index.ts';
import { createOperationService } from '../../../../src/api/control-plane/repositories/operations/operation-service.ts';

const principal = { id: 'user-1', permissions: ['platform:operations:create', 'platform:operations:read'] };
describe('platform operation catalog', () => {
	it('binds the six durable operation resources', () => {
		const platformOperations = Object.fromEntries(['list', 'create', 'show', 'events', 'cancel', 'retry'].map((name) => [name, vi.fn()])) as any;
		expect(createPlatformOperations({ platformOperations }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.operations.list, CONTROL_PLANE_OPERATIONS.operations.create,
			CONTROL_PLANE_OPERATIONS.operations.show, CONTROL_PLANE_OPERATIONS.operations.events,
			CONTROL_PLANE_OPERATIONS.operations.cancel, CONTROL_PLANE_OPERATIONS.operations.retry,
		]);
	});

	it('creates an operation with API-derived actor and header idempotency', async () => {
		const store = { createPlatformOperation: vi.fn(async (input) => input) };
		await expect(createOperationService(store).create(principal, { namespace: 'workflow', operation: 'dispatch' }, 'operation-1'))
			.resolves.toMatchObject({ namespace: 'workflow', operation: 'dispatch', requestedById: 'user-1', idempotencyKey: 'operation-1' });
	});
});
