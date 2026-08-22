import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATION_LIST } from '@treeseed/sdk/operator-contracts';
import { createApiControlPlaneOperations } from '../../../../src/api/control-plane/catalog/index.ts';

describe('control-plane catalog completeness', () => {
	it('binds every accepted SDK operation exactly once', () => {
		const service = new Proxy({}, { get: () => async () => ({}) });
		const dependencies = new Proxy({ store: service, capacity: service }, { get: (target, key) => (target as any)[key] ?? service });
		const registry = createApiControlPlaneOperations(dependencies as any);
		expect([...registry.operations.keys()].sort()).toEqual(CONTROL_PLANE_OPERATION_LIST.map((operation) => operation.descriptor.operationId).sort());
	});
});
