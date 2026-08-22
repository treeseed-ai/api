import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createSeedOperations } from '../../../../src/api/control-plane/catalog/seeds/index.ts';
import { createSeedOperationService } from '../../../../src/api/control-plane/seeds/seed-operation-service.ts';

describe('seed catalog operations', () => {
	it('binds all five SDK-owned seed operations', () => {
		const operations = createSeedOperations({ seeds: {} as any });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.seeds.runs,
			CONTROL_PLANE_OPERATIONS.seeds.run,
			CONTROL_PLANE_OPERATIONS.seeds.plan,
			CONTROL_PLANE_OPERATIONS.seeds.apply,
			CONTROL_PLANE_OPERATIONS.seeds.resolveResources,
		]);
	});

	it('keeps run inspection authenticated and bounded', async () => {
		const service = createSeedOperationService({ async listSeedRuns(limit: number) { return [{ limit }]; } } as any, { repoRoot: '/tmp/unused' });
		await expect(service.runs({ id: 'user-1' }, { limit: 10_000 })).resolves.toEqual({ items: [{ limit: 100 }] });
		await expect(service.runs(undefined, {})).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
	});

	it('requires platform seed authority for resource resolution', async () => {
		const service = createSeedOperationService({} as any, { repoRoot: '/tmp/unused' });
		await expect(service.resolveResources({ id: 'user-1', roles: [], permissions: [] }, { keys: ['team:treeseed'] }))
			.rejects.toMatchObject({ status: 403, code: 'seed_global_access_denied' });
	});
});
