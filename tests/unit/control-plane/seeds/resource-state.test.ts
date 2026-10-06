import { describe, expect, it } from 'vitest';
import { actionIsUnchanged } from '../../../../src/control-plane/seeds/apply-support/support/canonicalization.ts';
import { projectCurrentPayload } from '../../../../src/control-plane/seeds/apply-support/support/resource-state.ts';

describe('project seed read-back state', () => {
	it('preserves a canonical null submodule path', async () => {
		const repository = {
			role: 'primary', provider: 'github', owner: 'treeseed-ai', name: 'skill',
			gitUrl: 'https://github.com/treeseed-ai/skill.git', defaultBranch: 'main',
			repositoryPolicy: { stagingBranch: 'staging' }, submodulePath: null,
		};
		const action = { payload: {
			teamKey: 'team:treeseed', slug: 'skill', name: 'TreeSeed Skill', description: 'Reusable skill.',
			kind: 'package', repository, library: null, architecture: {}, metadata: {},
		} } as any;
		const project = {
			id: 'project-skill', slug: 'skill', name: 'TreeSeed Skill', description: 'Reusable skill.',
			metadata: { kind: 'package', repository, metadata: {} },
		};
		const store = { listHubRepositories: async () => [{
			...repository, url: repository.gitUrl, submodulePath: null,
		}] };

		const current = await projectCurrentPayload(store, action, project);

		expect(current.repository.submodulePath).toBeNull();
		expect(actionIsUnchanged(action, current)).toBe(true);
	});
});
