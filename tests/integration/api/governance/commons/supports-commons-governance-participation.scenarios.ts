import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('supports TreeSeed Commons governance participation', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		async function signUpParticipant(email: string, username: string, name: string) {
			const signup = await json(await app.request('/v1/auth/web/sign-up', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email, username, password: 'TreeSeed-commons-test-123!', name }),
			}));
			expect(signup.ok).toBe(true);
			const confirmed = await json(await app.request('/v1/auth/web/confirm-email', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: signup.payload.confirmationToken }),
			}));
			expect(confirmed.ok).toBe(true);
			return confirmed.payload;
		}

		const first = await signUpParticipant('commons-one@example.com', 'commons-one', 'Commons One');
		const second = await signUpParticipant('commons-two@example.com', 'commons-two', 'Commons Two');
		expect(await store.getTeamBySlug('treeseed')).toMatchObject({ id: 'treeseed', displayName: 'TreeSeed' });
		expect(await store.listTeamMembers('treeseed')).toEqual(expect.arrayContaining([
			expect.objectContaining({ userId: first.principal.id, roles: ['viewer'] }),
			expect.objectContaining({ userId: second.principal.id, roles: ['viewer'] }),
		]));

		const me = await json(await app.request('/v1/commons/participants/me', {
			headers: { authorization: `Bearer ${first.accessToken}` },
		}));
		expect(me.ok).toBe(true);
		expect(me.payload).toMatchObject({
			userId: first.principal.id,
			teamId: 'treeseed',
			status: 'active',
			verifiedEmail: true,
		});

		const question = await json(await app.request('/v1/commons/questions', {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'How should the Commons prioritize engineering work?',
				body: 'I want a structured way to raise roadmap questions before proposals.',
			}),
		}));
		expect(question.ok).toBe(true);
		expect(question.payload.status).toBe('open');

		const proposal = await json(await app.request('/v1/commons/proposals', {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Create a Commons proposal lane',
				summary: 'Participants can submit, back, vote, and steward decisions.',
				body: 'The lane should preserve cooperative governance and ownership model boundaries.',
			}),
		}));
		expect(proposal.ok).toBe(true);
		expect(proposal.payload.status).toBe('draft');
		const submitted = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/submit`, {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}` },
		}));
		expect(submitted.ok).toBe(true);
		expect(submitted.payload.status).toBe('submitted');

		const backed = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/back`, {
			method: 'POST',
			headers: { authorization: `Bearer ${second.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ reason: 'This improves participant signal without making votes automatically binding.' }),
		}));
		expect(backed.ok).toBe(true);
		expect(backed.payload.backingCount).toBe(1);
		expect(backed.payload.status).toBe('backing');

		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commons-governance' }),
		}));
		const adminToken = seeded.payload.actors.siteAdmin.accessToken;
		const voting = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/start-voting`, {
			method: 'POST',
			headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ reason: 'Steward opened a bounded voting window.' }),
		}));
		expect(voting.ok).toBe(true);
		expect(voting.payload.status).toBe('voting');

		const voted = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/vote`, {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ vote: 'support', reason: 'Transparent participant governance matters.' }),
		}));
		expect(voted.ok).toBe(true);
		expect(voted.payload.voteSupportWeight).toBeGreaterThan(0);

		const decision = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/steward-decision`, {
			method: 'POST',
			headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				status: 'accepted',
				reason: 'Accepted as advisory Commons capacity.',
				capacityBudget: 'commons',
			}),
		}));
		expect(decision.ok).toBe(true);
		expect(decision.payload.proposal.status).toBe('accepted');
		expect(decision.payload.decision.status).toBe('accepted');

		const secondParticipant = await store.getCommonsParticipantByUserId(second.principal.id);
		const delegation = await json(await app.request('/v1/commons/delegations', {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				toParticipantId: secondParticipant!.id,
				scope: 'treeseed_commons',
				reason: 'Delegate Commons review when unavailable.',
			}),
		}));
		expect(delegation.ok).toBe(true);
		expect(delegation.payload.status).toBe('active');

		const events = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/events`));
		expect(events.ok).toBe(true);
		expect(events.payload.map((entry: any) => entry.eventType)).toEqual(expect.arrayContaining([
			'proposal.created',
			'proposal.submitted',
			'proposal.backed',
			'proposal.voting_started',
			'proposal.voted',
			'proposal.steward_decision',
			'decision.created',
		]));
		expect(JSON.stringify({ decision, events })).not.toMatch(/payout|commission|dividend|patronage|secret_?/iu);
	});
});
