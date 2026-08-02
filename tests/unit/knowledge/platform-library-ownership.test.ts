import { describe, expect, it } from 'vitest';
import { syncPlatformAdminOwnersMethod } from '../../../src/api/store/teams/contracts/administration/sync-platform-admin-owners.ts';

describe('central platform knowledge ownership', () => {
	it('synchronizes every platform administrator as an owner and creates the managed platform library', async () => {
		const writes: Array<{ query: string; params: unknown[] }> = [];
		const store = {
			async first(query: string) {
				if (query.includes('FROM teams')) return { id: 'team-treeseed' };
				if (query.includes('FROM roles')) return { id: 'role-owner' };
				if (query.includes('COUNT(DISTINCT memberships.user_id)')) return { count: 2 };
				if (query.includes('FROM team_memberships')) return null;
				if (query.includes('FROM team_role_bindings')) return null;
				if (query.includes('FROM book_collections')) return null;
				return null;
			},
			async all(query: string) {
				if (query.includes('user_role_bindings')) return [{ id: 'admin-a' }, { id: 'admin-b' }];
				if (query.includes('bindings.id LIKE')) return [];
				return [];
			},
			async run(query: string, params: unknown[] = []) { writes.push({ query, params }); return { success: true, meta: { changes: 1 } }; },
		};

		await expect(syncPlatformAdminOwnersMethod.call(store as any)).resolves.toMatchObject({
			added: 2, libraryChanged: true, administratorCount: 2, ownerCount: 2,
		});
		expect(writes.filter((write) => write.query.includes('INSERT INTO team_role_bindings'))).toHaveLength(2);
		const library = writes.find((write) => write.query.includes('INSERT INTO book_collections'));
		expect(library?.params).toContain('treeseed-platform-library');
		expect(String(library?.params[2])).toContain('treeseed-platform-architecture-development');
	});
});
