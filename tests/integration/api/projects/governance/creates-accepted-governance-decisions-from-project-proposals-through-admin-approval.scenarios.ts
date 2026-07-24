import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('creates accepted governance decisions from project proposals through admin approval', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app, { principalId: 'project-governance-user', displayName: 'Project Governance User' });
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'governance-project',
			name: 'Governance Project',
		});
		const headers = {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		};

		const defaultPolicy = await json(await app.request(`/v1/projects/${project.id}/governance-policy`, { headers }));
		expect(defaultPolicy.ok).toBe(true);
		expect(defaultPolicy.payload).toMatchObject({
			teamId: team.id,
			providerId: 'admin_approval_v1',
			active: true,
		});

		const proposal = await json(await app.request(`/v1/projects/${project.id}/proposals`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				title: 'Adopt proposal governance',
				summary: 'Use accepted proposals as the only source of executable decisions.',
				body: 'The decision record should be generated from the accepted proposal snapshot and voting evidence.',
				proposalType: 'architecture',
			}),
		}));
		expect(proposal.ok).toBe(true);
		expect(proposal.payload).toMatchObject({
			projectId: project.id,
			status: 'draft',
			governanceProviderId: 'admin_approval_v1',
			activeVersion: 1,
		});

		const opened = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/open`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ reason: 'Ready for manager approval.' }),
		}));
		expect(opened.ok).toBe(true);
		expect(opened.payload.status).toBe('open');

		const accepted = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/admin-decision`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ status: 'approved', reason: 'Approved by project manager.' }),
		}));
		expect(accepted.ok).toBe(true);
		expect(accepted.payload.status).toBe('accepted');
		expect(accepted.payload.decisionId).toEqual(expect.any(String));
		expect(accepted.payload.outcome).toMatchObject({
			status: 'accepted',
			decisionEligible: true,
		});

		const decisions = await json(await app.request(`/v1/projects/${project.id}/decisions`, { headers }));
		expect(decisions.ok).toBe(true);
		expect(decisions.payload).toEqual([
			expect.objectContaining({
				proposalId: proposal.payload.id,
				status: 'accepted',
				proposalContentHash: proposal.payload.activeContentHash,
				governanceProviderId: 'admin_approval_v1',
			}),
		]);

		const events = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/events`, { headers }));
		expect(events.ok).toBe(true);
		expect(events.payload.map((event: any) => event.eventType)).toEqual(expect.arrayContaining([
			'proposal.created',
			'proposal.open',
			'proposal.accepted',
			'decision.created',
		]));
	});
});
