import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('manages team profiles, invites, member roles, and guarded deletion', async () => {
		const acceptanceHeaders = {
			'x-treeseed-acceptance-email-bypass': '1',
			'x-treeseed-service-id': 'web',
			'x-treeseed-service-secret': 'web-test-secret',
		};
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const created = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
				...acceptanceHeaders,
			},
			body: JSON.stringify({
				name: 'Alpha-Team',
				displayName: 'Alpha Team',
				logoUrl: 'https://example.com/logo.png',
				description: 'Public team summary.',
			}),
		}));
		expect(created.ok).toBe(true);
		expect(created.payload).toMatchObject({
			name: 'alpha-team',
			displayName: 'Alpha Team',
			logoUrl: 'https://example.com/logo.png',
			profileSummary: 'Public team summary.',
		});
		const creatorMembers = await json(await app.request(`/v1/teams/${created.payload.id}/members`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		const creatorMember = creatorMembers.payload.find((entry: { userId: string }) => entry.userId === 'user-1');
		expect(creatorMembers.ownerCount).toBe(1);
		expect(creatorMember).toMatchObject({ roleKey: 'team_owner' });
		expect(creatorMember.roles).toContain('team_owner');
		const creatorAccess = await json(await app.request(`/v1/teams/${created.payload.id}/permissions`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(creatorAccess.payload.capabilities).toEqual(expect.arrayContaining(['launch_projects', 'manage_billing']));
		expect(creatorAccess.payload.teamPermissions).toEqual(expect.arrayContaining(['project:create', 'billing:manage']));

		const updated = await json(await app.request(`/v1/teams/${created.payload.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'alpha-collective',
				displayName: 'Alpha Collective',
			}),
		}));
		expect(updated.ok).toBe(true);
		expect(updated.team.name).toBe('alpha-collective');
		expect(updated.team.displayName).toBe('Alpha Collective');
		const profileUpdate = await json(await app.request('/v1/auth/web/profile', {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				displayName: 'Market User',
				image: 'https://example.com/market-user.png',
			}),
		}));
		expect(profileUpdate.ok).toBe(true);
		const updatedHome = await json(await app.request(`/v1/teams/${created.payload.id}/home`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		const updateActivity = updatedHome.payload.auditEvents.find((event: { eventType: string }) => event.eventType === 'team.updated');
		expect(updateActivity.actor).toMatchObject({
			type: 'user',
			displayName: 'Market User',
			username: expect.any(String),
			image: 'https://example.com/market-user.png',
		});
		expect(updateActivity.data.changes).toEqual(expect.arrayContaining([
			expect.objectContaining({ field: 'name', label: 'Team address', before: 'alpha-team', after: 'alpha-collective' }),
			expect.objectContaining({ field: 'displayName', label: 'Display name', before: 'Alpha Team', after: 'Alpha Collective' }),
		]));

		const duplicate = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'other-team',
				displayName: 'Other Team',
			}),
		}));
		const renameTaken = await json(await app.request(`/v1/teams/${duplicate.payload.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ name: 'alpha-collective' }),
		}));
		expect(renameTaken).toMatchObject({ ok: false, code: 'taken' });

		const invite = await json(await app.request(`/v1/teams/${created.payload.id}/invites`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
				...acceptanceHeaders,
			},
			body: JSON.stringify({
				email: 'new-member@example.com',
				roleKey: 'reviewer',
			}),
		}));
		expect(invite.ok).toBe(true);
		expect(invite.token).toMatch(/^tiv_/);

		const signup = await json(await app.request('/v1/auth/web/sign-up', {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...acceptanceHeaders },
			body: JSON.stringify({
				email: 'new-member@example.com',
				username: 'new-member',
				password: 'invite-password-123',
				displayName: 'Invited User',
				inviteToken: invite.token,
			}),
		}));
		expect(signup).toMatchObject({ ok: true, payload: { confirmationRequired: true } });
		const confirmed = await json(await app.request('/v1/auth/web/confirm-email', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: signup.payload.confirmationToken }),
		}));
		expect(confirmed.payload.accessToken).toEqual(expect.any(String));
		const accepted = await json(await app.request(`/v1/team-invites/${invite.token}/accept`, {
			method: 'POST',
			headers: { authorization: `Bearer ${confirmed.payload.accessToken}` },
		}));
		expect(accepted.ok).toBe(true);
		const invitedHome = await app.request(`/v1/teams/${created.payload.id}/home`, {
			headers: { authorization: `Bearer ${confirmed.payload.accessToken}` },
		});
		expect(invitedHome.status).toBe(200);
		const memberDirectory = await json(await app.request(
			`/v1/teams/${created.payload.id}/members?q=Market&page=1&limit=25`,
			{ headers: { authorization: `Bearer ${confirmed.payload.accessToken}` } },
		));
		expect(memberDirectory).toMatchObject({
			ok: true,
			payload: {
				total: 1,
				items: [expect.objectContaining({ userId: 'user-1', displayName: 'Market User' })],
			},
		});
		const memberInviteDenied = await app.request(`/v1/teams/${created.payload.id}/invites`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${confirmed.payload.accessToken}`,
				...acceptanceHeaders,
			},
			body: JSON.stringify({ email: 'denied-invite@example.com', roleKey: 'contributor' }),
		});
		expect(memberInviteDenied.status).toBe(403);

		const members = await json(await app.request(`/v1/teams/${created.payload.id}/members`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(members.ownerCount).toBe(1);
		const member = members.payload.find((entry: { email: string }) => entry.email === 'new-member@example.com');
		expect(member.roles).toContain('reviewer');

		const updatedRole = await json(await app.request(`/v1/teams/${created.payload.id}/members/${member.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ roleKey: 'contributor' }),
		}));
		expect(updatedRole.ok).toBe(true);

		const removedMember = await json(await app.request(`/v1/teams/${created.payload.id}/members/${member.id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(removedMember.ok).toBe(true);
		const removedHome = await app.request(`/v1/teams/${created.payload.id}/home`, {
			headers: { authorization: `Bearer ${confirmed.payload.accessToken}` },
		});
		expect(removedHome.status).toBe(403);

		const archived = await json(await app.request(`/v1/teams/${created.payload.id}/archive`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ lifecycleVersion: updated.team.lifecycleVersion }),
		}));
		expect(archived.ok).toBe(true);
		const eventTypes = (await store.all(`SELECT event_type FROM audit_events ORDER BY created_at`)).map((row) => row.event_type);
		expect(eventTypes).toEqual(expect.arrayContaining([
			'team.created',
			'team.updated',
			'team.invitation.created',
			'team.invitation.accepted',
			'team.member.role_changed',
			'team.member.removed',
			'team.archived',
		]));
	});

	it('reports operational collection counts instead of deriving them from user capabilities', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app, { principalId: 'collection-owner' });
		const created = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: 'collection-team', displayName: 'Collection Team' }),
		}));
		const teamId = created.payload.id;
		const now = new Date().toISOString();
		await store.run(`INSERT INTO projects
			(id, team_id, slug, name, metadata_json, created_at, updated_at)
			VALUES (?, ?, 'collection-project', 'Collection Project', '{}', ?, ?)`, [
			'collection-project',
			teamId,
			now,
			now,
		]);
		const activityTimes = [
			new Date(Date.now() - 3 * 86_400_000).toISOString(),
			new Date(Date.now() - 2 * 86_400_000).toISOString(),
			new Date(Date.now() - 86_400_000).toISOString(),
		];
		for (const [id, contentType, resourceId, createdAt] of [
			['activity-note-created', 'notes', 'note-1', activityTimes[0]],
			['activity-question-created', 'questions', 'question-1', activityTimes[1]],
			['activity-note-updated', 'notes', 'note-1', activityTimes[2]],
		]) {
			await store.run(`INSERT INTO notification_events
				(id, event_type, content_type, project_id, actor_id, resource_id, title, summary, target_url, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`, [
				id,
				`content.${String(contentType).replace(/s$/u, '')}.published`,
				contentType,
				'collection-project',
				'collection-owner',
				resourceId,
				`${resourceId} published`,
				`/app/projects/collection-project/${resourceId}`,
				createdAt,
			]);
		}
		await store.run(`INSERT INTO capacity_providers
			(id, fingerprint, public_jwk_json, display_name, status, metadata_json, created_at, updated_at)
			VALUES (?, ?, '{}', 'Collection Provider', 'active', '{}', ?, ?)`, [
			'collection-provider',
			'collection-provider-fingerprint',
			now,
			now,
		]);
		await store.run(`INSERT INTO capacity_provider_team_memberships
			(id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at)
			VALUES (?, ?, ?, 'approved', ?, ?, '{}', ?, ?)`, [
			'collection-provider-membership',
			teamId,
			'collection-provider',
			now,
			'collection-owner',
			now,
			now,
		]);

		const collection = await json(await app.request('/v1/teams', {
			headers: { authorization: `Bearer ${token}` },
		}));
		const team = collection.payload.find((entry: { id: string }) => entry.id === teamId);
		expect(team.counts).toMatchObject({
			projects: 1,
			capacityProviders: 1,
			members: 1,
			pendingInvitations: 0,
		});
		const home = await json(await app.request(`/v1/teams/${teamId}/home`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(home.payload.contentActivity).toEqual([
			expect.objectContaining({ id: 'activity-note-created', type: 'notes', action: 'created' }),
			expect.objectContaining({ id: 'activity-question-created', type: 'questions', action: 'created' }),
			expect.objectContaining({ id: 'activity-note-updated', type: 'notes', action: 'updated' }),
		]);
	});
});
