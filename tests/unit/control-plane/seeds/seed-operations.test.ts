import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS, digestSeedBundle } from '@treeseed/sdk/operator-contracts';
import { createSeedOperations } from '../../../../src/api/control-plane/catalog/seeds/index.ts';
import { createSeedOperationService, reconcileSeedProviderPrerequisites } from '../../../../src/api/control-plane/seeds/seed-operation-service.ts';
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

	it('turns a trusted local seed prerequisite into a bounded enrollment handoff', async () => {
		const providers = { connect: vi.fn().mockResolvedValue({ enrollmentToken: 'one-time', connectionState: 'enrollment_required' }) };
		const plan = { seed: 'treeseed', version: 4, actions: [{ key: 'team:treeseed', existing: { id: 'team-1' } }], runtime: { capacityProviders: [{
			key: 'capacity-provider:treeseed/local', team: 'team:treeseed', approval: 'trusted-local-owner', requiredLanePurposes: ['communication', 'platform', 'workday'], projects: [], environments: ['local'],
		}] } };
		const closure = await reconcileSeedProviderPrerequisites({ first: vi.fn().mockResolvedValue(null) } as any, { providers }, plan, true, { id: 'owner-1' });
		expect(providers.connect).toHaveBeenCalledWith({ id: 'owner-1' }, 'team-1', 'seed:treeseed:4:capacity-provider:treeseed/local:enroll');
		expect(closure).toEqual({ status: 'waiting_provider', receipts: [expect.objectContaining({
			key: 'capacity-provider:treeseed/local', status: 'enrollment_required', teamId: 'team-1', connectionId: 'local-team-1', approval: 'trusted-local-owner', enrollmentToken: 'one-time',
		})] });
	});

	it('verifies provider readiness only when an active allocation covers every seeded project', async () => {
		const allocation = {
			id: 'allocation-1', team_id: 'team-1', version: 1, status: 'active', effective_from: '2026-08-25T00:00:00.000Z', effective_until: null,
			reserve_policy_json: JSON.stringify({ percent: 0, overflow: 'deny' }),
			slices_json: JSON.stringify([{ id: 'slice-1', scope: 'project', targetId: 'project-1', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }]),
			borrowing_rules_json: '[]', metadata_json: '{}', created_by_id: 'owner-1', activated_at: '2026-08-25T00:00:00.000Z', superseded_by_id: null,
			created_at: '2026-08-25T00:00:00.000Z', updated_at: '2026-08-25T00:00:00.000Z',
		};
		const store = {
			ensureInitialized: vi.fn(), all: vi.fn().mockResolvedValue([{ id: 'lane-1', purpose: 'communication', execution_provider_id: 'execution-1' }]),
			first: vi.fn(async (query: string) => {
				if (query.includes('capacity_provider_team_memberships membership')) return { id: 'membership-1', capacity_provider_id: 'provider-1' };
				if (query.includes('capacity_provider_availability_sessions')) return { id: 'session-1' };
				if (query.includes('capacity_grants')) return { id: 'grant-1', status: 'active' };
				if (query.includes("capacity_allocation_sets\n\t\t\t WHERE team_id = ? AND status = 'active'")) return allocation;
				return null;
			}), run: vi.fn(),
		};
		const plan = { seed: 'treeseed', version: 4, actions: [
			{ key: 'team:treeseed', existing: { id: 'team-1' } },
			{ key: 'project:treeseed/sdk', existing: { id: 'project-1' } },
		], runtime: { capacityProviders: [{ key: 'capacity-provider:treeseed/local', team: 'team:treeseed', approval: 'trusted-local-owner',
			requiredLanePurposes: ['communication'], projects: ['project:treeseed/sdk'], environments: ['local'] }] } };
		await expect(reconcileSeedProviderPrerequisites(store as any, {}, plan, false)).resolves.toEqual({ status: 'verified', receipts: [expect.objectContaining({
			status: 'verified', allocation: { status: 'active', allocationSetId: 'allocation-1', version: 1 },
		})] });
	});

	it('reconciles seeded grants with the execution provider capabilities required by agent work', async () => {
		const allocation = {
			id: 'allocation-1', team_id: 'team-1', version: 1, status: 'active', effective_from: '2026-08-25T00:00:00.000Z', effective_until: null,
			reserve_policy_json: JSON.stringify({ percent: 0, overflow: 'deny' }),
			slices_json: JSON.stringify([{ id: 'slice-1', scope: 'project', targetId: 'project-1', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }]),
			borrowing_rules_json: '[]', metadata_json: '{}', created_by_id: 'owner-1', activated_at: '2026-08-25T00:00:00.000Z', superseded_by_id: null,
			created_at: '2026-08-25T00:00:00.000Z', updated_at: '2026-08-25T00:00:00.000Z',
		};
		const store = {
			ensureInitialized: vi.fn(),
			all: vi.fn().mockResolvedValue([
				{ id: 'communication', purpose: 'communication', execution_provider_id: 'execution-1', execution_provider_capabilities_json: JSON.stringify(['treeseed.coordination.conversation']) },
				{ id: 'workday', purpose: 'workday', execution_provider_id: 'execution-1', execution_provider_capabilities_json: JSON.stringify(['treeseed.engineering.code-change']) },
			]),
			first: vi.fn(async (query: string) => {
				if (query.includes('capacity_provider_team_memberships membership')) return { id: 'membership-1', capacity_provider_id: 'provider-1' };
				if (query.includes('capacity_provider_availability_sessions')) return { id: 'session-1' };
				if (query.includes('capacity_grants')) return { id: 'grant-1', status: 'active' };
				if (query.includes("capacity_allocation_sets\n\t\t\t WHERE team_id = ? AND status = 'active'")) return allocation;
				return null;
			}),
			run: vi.fn(),
		};
		const plan = { seed: 'treeseed', version: 4, actions: [
			{ key: 'team:treeseed', existing: { id: 'team-1' } },
			{ key: 'project:treeseed/sdk', existing: { id: 'project-1' } },
		], runtime: { capacityProviders: [{ key: 'capacity-provider:treeseed/local', team: 'team:treeseed', approval: 'trusted-local-owner',
			requiredLanePurposes: ['communication', 'workday'], projects: ['project:treeseed/sdk'], environments: ['local'] }] } };

		await reconcileSeedProviderPrerequisites(store as any, {}, plan, true, { id: 'owner-1' });

		expect(store.all).toHaveBeenCalledWith(expect.stringContaining('execution_provider.capacity_provider_id = lane.capacity_provider_id'), ['provider-1']);
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('capabilities_json = ?'), [
			JSON.stringify(['execution-1']), JSON.stringify(['communication', 'workday']),
			JSON.stringify(['treeseed.coordination.conversation', 'treeseed.engineering.code-change']), expect.any(String), 'grant-1', 'membership-1',
		]);
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
