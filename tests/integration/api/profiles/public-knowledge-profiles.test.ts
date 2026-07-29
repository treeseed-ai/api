import { createTestPostgresDatabase, createTestStore, describe, expect, it } from '../../../support/api-harness.ts';

describe('public knowledge profiles', () => {
	it('publishes explicit knowledge while redacting memberships and private work', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		try {
			await store.ensureInitialized();
			const now = '2026-07-28T12:00:00.000Z';
			await store.run(`INSERT INTO users (id, email, username, display_name, status, metadata_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`, [
				'profile-user',
				'private@example.test',
				'profile-author',
				'Profile Author',
				JSON.stringify({
					headline: 'Researching durable knowledge systems',
					profileSummary: 'Turns difficult work into reusable knowledge.',
					expertise: ['Research', 'Knowledge systems'],
				}),
				now,
				now,
			]);
			const team = await store.createTeam({
				id: 'public-profile-team',
				name: 'public-profile-team',
				displayName: 'Public Profile Team',
				profileSummary: 'Publishes reusable research.',
				metadata: { visibility: 'public' },
			});
			await store.upsertTeamMember(team.id, 'profile-user', 'viewer');
			await store.createProject(team.id, {
				slug: 'public-project',
				name: 'Public Project',
				description: 'A public knowledge project.',
				metadata: { visibility: 'public' },
			});
			await store.createProject(team.id, {
				slug: 'private-project',
				name: 'Private Project',
				description: 'Must never appear.',
				metadata: { visibility: 'private' },
			});
			const publicItem = await store.upsertCatalogItem(team.id, {
				id: 'public-template',
				kind: 'template',
				slug: 'public-template',
				title: 'Public Research Template',
				summary: 'A reusable public workflow.',
				visibility: 'public',
				listingEnabled: true,
				offerMode: 'free',
			});
			await store.upsertCatalogItem(team.id, {
				id: 'private-template',
				kind: 'template',
				slug: 'private-template',
				title: 'Private Research Template',
				summary: 'Must never appear.',
				visibility: 'private',
				listingEnabled: false,
			});
			await store.run(`INSERT INTO commerce_contributions
				(id, product_id, contributor_type, contributor_id, role, summary, attribution_visibility, effective_at, metadata_json, created_at, updated_at)
				VALUES (?, ?, 'user', ?, 'researcher', 'Prepared the public method.', 'public', ?, '{}', ?, ?)`, [
				'public-contribution',
				publicItem.id,
				'profile-user',
				now,
				now,
				now,
			]);

			const teamProfile = await store.loadTeamProfileByName(team.name);
			expect(teamProfile).toMatchObject({
				team: { name: team.name },
				knowledge: {
					stats: { templates: 1, projects: 1 },
					catalog: [{ title: 'Public Research Template' }],
					projects: [{ name: 'Public Project' }],
				},
			});
			expect(teamProfile?.team).not.toHaveProperty('id');
			expect(JSON.stringify(teamProfile)).not.toMatch(/Private Project|Private Research Template|membership|email|role/iu);

			const userProfile = await store.loadUserProfileByUsername('profile-author');
			expect(userProfile).toMatchObject({
				user: {
					username: 'profile-author',
					headline: 'Researching durable knowledge systems',
					expertise: ['Research', 'Knowledge systems'],
				},
				knowledge: {
					stats: { contributions: 1, templates: 1 },
					contributions: [{ role: 'researcher', item: { title: 'Public Research Template' } }],
				},
			});
			expect(userProfile?.user).not.toHaveProperty('id');
			expect(JSON.stringify(userProfile)).not.toMatch(/profile-user|private@example|Public Profile Team|membership|Private Project|Private Research Template/iu);
		} finally {
			db.close();
		}
	});
});
