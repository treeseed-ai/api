import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS, digestSeedBundle } from '@treeseed/sdk/operator-contracts';
import { createSeedOperations } from '../../../../src/api/control-plane/catalog/seeds/index.ts';
import { createSeedOperationService } from '../../../../src/api/control-plane/seeds/seed-operation-service.ts';
import { validateSeedSource } from '../../../../src/control-plane/seeds/contracts/index.ts';
import { actionIsUnchanged } from '../../../../src/control-plane/seeds/apply-support/index.ts';

describe('seed catalog operations', () => {
	it('binds the complete SDK-owned portable seed lifecycle', () => {
		const operations = createSeedOperations({ seeds: {} as any });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.seeds.runs,
			CONTROL_PLANE_OPERATIONS.seeds.run,
			CONTROL_PLANE_OPERATIONS.seeds.validate,
			CONTROL_PLANE_OPERATIONS.seeds.plan,
			CONTROL_PLANE_OPERATIONS.seeds.apply,
			CONTROL_PLANE_OPERATIONS.seeds.show,
			CONTROL_PLANE_OPERATIONS.seeds.verify,
			CONTROL_PLANE_OPERATIONS.seeds.reconcile,
			CONTROL_PLANE_OPERATIONS.seeds.resolveResources,
		]);
	});

	it('validates an uploaded digest-bound bundle without filesystem access', async () => {
		const unsigned: any = { schemaVersion: 'treeseed.seed-bundle/v3', name: 'treeseed', version: 1,
			description: 'test', environments: ['local'], resources: { teams: [], memberships: [], projects: [], repositories: [] },
			runtime: { capacityProviders: [] } };
		const value = { ...unsigned, digest: await digestSeedBundle(unsigned) };
		const service = createSeedOperationService({} as any);
		await expect(service.validate({ id: 'user-1' }, { bundle: value })).resolves.toMatchObject({ ok: true, name: 'treeseed' });
		await expect(service.validate({ id: 'user-1' }, { bundle: { ...value, digest: `sha256:${'0'.repeat(64)}` } }))
			.resolves.toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'seed_bundle_digest_mismatch' })] });
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

	it('rejects removed resource families instead of retaining dormant schemas', () => {
		const result = validateSeedSource(`name: clean\nversion: 1\nenvironments: [local]\nresources:\n  teams: []\n  teamMemberships: []\n  projects: []\n  hubRepositories: []\n  supportRepositories: []\n  products: []\n`);
		expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({
			code: 'seed.unsupported_resource_kind', path: 'resources.products',
		})] });
	});

	it('does not treat an action-only resource key as persisted-state drift', () => {
		expect(actionIsUnchanged({ payload: {
			key: 'team:treeseed', slug: 'treeseed',
			metadata: { seed: { name: 'treeseed', resourceKey: 'team:treeseed', version: 2 } },
		} }, {
			slug: 'treeseed',
			metadata: { seed: { name: 'treeseed', resourceKey: 'team:treeseed', version: 2,
				lastAppliedAt: '2026-08-23T00:00:00.000Z', manifestHash: 'sha256:test' } },
		})).toBe(true);
	});
});
