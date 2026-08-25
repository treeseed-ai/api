import { describe, expect, it, vi } from 'vitest';
import { digestSeedBundle, type SeedBundleV2 } from '@treeseed/sdk/operator-contracts';
import { applyAction } from '../../../../src/control-plane/seeds/apply-support/support/action-dispatch.ts';
import { planPortableSeedBundle } from '../../../../src/control-plane/seeds/planning/plan-portable-seed-bundle.ts';

describe('content-only seed projects', () => {
	it('plans the root project without inventing a Git repository', async () => {
		const unsigned: Omit<SeedBundleV2, 'digest'> = {
			schemaVersion: 'treeseed.seed-bundle/v2',
			name: 'knowledge',
			version: 1,
			description: 'Content-only project fixture.',
			environments: ['local'],
			resources: {
				teams: [{ key: 'team:fixture', slug: 'fixture', name: 'fixture', displayName: 'Fixture' }],
				memberships: [],
				projects: [{ key: 'project:fixture/knowledge', team: 'team:fixture', slug: 'knowledge', name: 'Knowledge', description: 'Virtual knowledge only.', kind: 'content' }],
				repositories: [],
			},
			runtime: { capacityProviders: [] },
		};
		const bundle = { ...unsigned, digest: await digestSeedBundle(unsigned) };
		const result = await planPortableSeedBundle({ bundle, seedName: 'knowledge', mode: 'plan' });
		const project = result.plan?.actions.find((action) => action.kind === 'project');
		expect(result.ok).toBe(true);
		expect(project?.payload.repository).toBeNull();
		expect(result.plan?.actions.some((action) => action.kind === 'hubRepository')).toBe(false);
	});

	it('does not persist an empty legacy architecture object', async () => {
		const updateProject = vi.fn(async (_projectId, input) => ({ id: 'project-1', ...input }));
		await applyAction({
			action: {
				kind: 'project', key: 'project:fixture/knowledge', action: 'update', existing: { id: 'project-1', metadata: {} },
				payload: { teamKey: 'team:fixture', slug: 'knowledge', name: 'Knowledge', description: 'Virtual knowledge only.',
					kind: 'content', repository: null, architecture: {}, metadata: {} },
			},
			store: { updateProject },
			ids: { teams: new Map([['team:fixture', 'team-1']]), projects: new Map(), projectTeams: new Map() },
			manifestHash: `sha256:${'0'.repeat(64)}`, appliedAt: '2026-08-23T00:00:00.000Z', plan: { seed: 'fixture' },
		} as never);
		expect(updateProject).toHaveBeenCalledWith('project-1', expect.objectContaining({
			metadata: expect.not.objectContaining({ architecture: expect.anything() }),
		}));
	});
});
