import { describe, expect, it } from 'vitest';
import { digestSeedBundle, type SeedBundleV2 } from '@treeseed/sdk/operator-contracts';
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
});
