import { describe,expect,it } from 'vitest';
import { buildRepositoryTopologySnapshotMethod } from '../../../../../src/api/store/repositories/creation/build-repository-topology-snapshot.ts';
import { mergeRepositoryTopologyMetadata } from '../../../../../src/api/store/projects/knowledge/creation/upsert-project-tree-dx-library.ts';

describe('repository topology snapshot', () => {
	it('preserves an explicit content authoring branch independently from the observed ref', () => {
		const topology = buildRepositoryTopologySnapshotMethod.call({} as never, {
			project: { slug: 'visual-audit-project' },
			instance: { id: 'local-treedx', baseUrl: 'http://127.0.0.1:4000' },
			binding: {
				libraryId: 'team/project', repositoryId: 'repo-one', contentPath: 'src/content',
				contentRepositoryDefaultBranch: 'main', contentRepositoryRef: 'refs/heads/main',
			},
			softwareRepository: null,
			workspaceLink: null,
			metadata: { contentRepository: { authoringBranch: 'main' } },
		});

		expect(topology.contentRepository).toMatchObject({
			defaultBranch: 'main', ref: 'refs/heads/main', authoringBranch: 'main',
		});
	});

	it('retains topology-owned authoring policy across partial binding refreshes', () => {
		const topology = mergeRepositoryTopologyMetadata({
			contentRepository: { authoringBranch: 'main', accessMode: 'treedx' },
			siteRepository: { checkoutPath: '/existing/site' },
		}, { contentRepository: { ref: 'refs/heads/main' } });

		expect(topology).toMatchObject({
			contentRepository: { authoringBranch: 'main', accessMode: 'treedx', ref: 'refs/heads/main' },
			siteRepository: { checkoutPath: '/existing/site' },
		});
	});
});
