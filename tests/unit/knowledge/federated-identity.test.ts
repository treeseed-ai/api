import { describe, expect, it } from 'vitest';
import { assertFederatedKnowledgeIdentity, mergeFederatedProjects } from '../../../src/api/knowledge/federated-catalog.ts';

const source = (projectId: string, path: string) => ({
	teamId: 'team-a', teamSlug: 'team-a', projectId, repositoryId: `repo-${projectId}`, commitSha: 'abc', path,
});

describe('federated knowledge identity', () => {
	it('fails closed when independent repositories publish the same stable page id', () => {
		expect(() => assertFederatedKnowledgeIdentity([], [
			{ id: 'shared.page', slug: 'one', source: source('one', 'knowledge/one.md') },
			{ id: 'shared.page', slug: 'two', source: source('two', 'knowledge/two.md') },
		] as any)).toThrow(/duplicate federated knowledge page id/iu);
	});

	it('accepts globally distinct book and page identities', () => {
		expect(() => assertFederatedKnowledgeIdentity(
			[{ id: 'book.one', slug: 'one', source: source('one', 'books/one.md') }] as any,
			[{ id: 'page.one', slug: 'one', source: source('one', 'knowledge/one.md') }] as any,
		)).not.toThrow();
	});

	it('includes public documentation for signed-in principals without duplicating member projects', () => {
		expect(mergeFederatedProjects(
			[{ id: 'member', name: 'Member' }, { id: 'shared', name: 'Member view' }],
			[{ id: 'public', name: 'Public' }, { id: 'shared', name: 'Public view' }],
		)).toEqual([
			{ id: 'public', name: 'Public' },
			{ id: 'shared', name: 'Member view' },
			{ id: 'member', name: 'Member' },
		]);
	});
});
