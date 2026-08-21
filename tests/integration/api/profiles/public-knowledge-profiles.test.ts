import { createTestPostgresDatabase,createTestStore,describe,expect,it } from '../../../support/api-harness.ts';

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
			const teamProfile = await store.loadTeamProfileByName(team.name);
			expect(teamProfile).toMatchObject({
				team: { name: team.name },
				knowledge: {
					stats: { templates: 0, projects: 1 },
					catalog: [],
					projects: [{ name: 'Public Project' }],
				},
			});
			expect(teamProfile?.team).not.toHaveProperty('id');
			expect(JSON.stringify(teamProfile)).not.toMatch(/Private Project|membership|email|role/iu);

			const userProfile = await store.loadUserProfileByUsername('profile-author');
			expect(userProfile).toMatchObject({
				user: {
					username: 'profile-author',
					headline: 'Researching durable knowledge systems',
					expertise: ['Research', 'Knowledge systems'],
				},
				knowledge: {
					stats: { contributions: 0, templates: 0 },
					contributions: [],
				},
			});
			expect(userProfile?.user).not.toHaveProperty('id');
			expect(JSON.stringify(userProfile)).not.toMatch(/profile-user|private@example|Public Profile Team|membership|Private Project/iu);
		} finally {
			db.close();
		}
	});
});
