import { describe, expect, it } from 'vitest';
import { ensureProjectSeedDependencies } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-dependencies.ts';

describe('legacy Git content binding cleanup', () => {
	it('removes only the obsolete content role from a seed-reconciled project', async () => {
		const deleted: Array<{ projectId: string; role: string }> = [];
		const store = {
			async listHubRepositories() {
				return [{ role: 'content' }, { role: 'primary' }];
			},
			async deleteHubRepositoryByRole(projectId: string, role: string) {
				deleted.push({ projectId, role });
				return 1;
			},
		};
		const repairs = await ensureProjectSeedDependencies({
			action: {
				kind: 'project', key: 'project:fixture/knowledge', existing: null,
				payload: { teamKey: 'team:fixture', slug: 'knowledge', repository: null, metadata: {} },
			},
			store,
			ids: { projects: new Map([['project:fixture/knowledge', 'project-1']]), teams: new Map([['team:fixture', 'team-1']]) },
			manifestHash: 'sha256:fixture', appliedAt: '2026-08-23T00:00:00.000Z', env: {}, localOnly: false,
			dependencyState: {}, plan: { actions: [] },
		});
		expect(deleted).toEqual([{ projectId: 'project-1', role: 'content' }]);
		expect(repairs).toContainEqual({ kind: 'legacyContentRepositoryRemoved', projectId: 'project-1' });
	});
});
