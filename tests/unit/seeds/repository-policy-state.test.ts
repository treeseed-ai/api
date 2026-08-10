import { describe, expect, it, vi } from 'vitest';
import {
	hubRepositoryCurrentPayload,
	projectCurrentPayload,
} from '../../../src/market/seeds/apply-support/support/resource-state.ts';

const repositoryPolicy = {
	visibility: 'public',
	lifecycle: 'create-or-adopt',
	deletionPolicy: 'retain',
};

describe('seed repository policy state', () => {
	it('compares project repository policy as provider-owned desired state', async () => {
		const payload = await projectCurrentPayload({
			listHubRepositories: vi.fn(async () => [{
				role: 'primary', provider: 'github', owner: 'treeseed-ai', name: 'sdk',
				url: 'https://github.com/treeseed-ai/sdk.git', defaultBranch: 'main',
			}]),
		}, {
			payload: {
				teamKey: 'team:treeseed', kind: 'package', metadata: {},
				repository: {
					role: 'primary', provider: 'github', owner: 'treeseed-ai', name: 'sdk',
					gitUrl: 'https://github.com/treeseed-ai/sdk.git', repositoryPolicy,
				},
			},
		}, { id: 'project-sdk', slug: 'sdk', name: 'SDK', metadata: {} });

		expect(payload.repository.repositoryPolicy).toEqual(repositoryPolicy);
	});

	it('compares content repository policy as provider-owned desired state', () => {
		const payload = hubRepositoryCurrentPayload({
			payload: { projectKey: 'project:treeseed/sdk', metadata: {}, repositoryPolicy },
		}, {
			role: 'content', provider: 'github', owner: 'treeseed-ai', name: 'sdk-content',
			url: 'https://github.com/treeseed-ai/sdk-content.git', defaultBranch: 'main',
		});

		expect(payload.repositoryPolicy).toEqual(repositoryPolicy);
	});
});
