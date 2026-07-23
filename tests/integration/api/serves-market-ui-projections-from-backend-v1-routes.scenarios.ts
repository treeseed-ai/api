import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('serves Market UI projections from backend v1 routes', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app, { principalId: 'ui-projection-user', displayName: 'UI Projection User' });
		const headers = { authorization: `Bearer ${token}` };
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'ui-projection-project',
			slug: 'ui-projection-project',
			name: 'UI Projection Project',
		});
		const approval = await store.createApprovalRequest({
			id: 'ui-approval-1',
			teamId: team.id,
			projectId: project.id,
			workDayId: 'ui-workday-1',
			kind: 'publish_report',
			severity: 'high',
			requestedByType: 'platform',
			requestedById: 'operations-runner',
			title: 'Publish projection report',
			summary: 'Review the generated projection report.',
			options: [{ id: 'approve', label: 'Approve', state: 'approved' }],
		});
		if (!approval) throw new Error('Expected UI projection approval fixture to be created.');
		const createdUiWorkday = await json(await app.request('/v1/workdays', {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
				'idempotency-key': 'ui-workday-1-create',
			},
			body: JSON.stringify({
				id: 'ui-workday-1',
				projectId: project.id,
				environment: 'staging',
				status: 'active',
				metadata: { summary: { objective: 'Verify backend UI projections' } },
			}),
		}));
		expect(createdUiWorkday.ok).toBe(true);

		const governance = await json(await app.request('/v1/ui/governance', { headers }));
		expect(governance).toMatchObject({
			ok: true,
			payload: {
				pendingApprovals: expect.arrayContaining([
					expect.objectContaining({ approvalId: approval.id, href: `/app/work/decisions/${approval.id}` }),
				]),
			},
		});

		const approvalDetail = await json(await app.request(`/v1/ui/governance/${approval.id}`, { headers }));
		expect(approvalDetail).toMatchObject({
			ok: true,
			payload: {
				approval: expect.objectContaining({ approvalId: approval.id, title: 'Publish projection report' }),
				decisionOptions: expect.arrayContaining([expect.objectContaining({ id: 'approve' })]),
			},
		});

		const decided = await json(await app.request(`/v1/ui/governance/${approval.id}/decision`, {
			method: 'POST',
			headers: { ...headers, 'content-type': 'application/json' },
			body: JSON.stringify({ optionId: 'approve', note: 'Looks ready.' }),
		}));
		expect(decided).toMatchObject({
			ok: true,
			payload: expect.objectContaining({ id: approval.id, state: 'approved' }),
		});

		const infrastructure = await json(await app.request('/v1/ui/infrastructure', { headers }));
		expect(infrastructure).toMatchObject({ ok: true, payload: expect.any(Object) });

		const knowledge = await json(await app.request('/v1/ui/knowledge', { headers }));
		expect(knowledge).toMatchObject({ ok: true, payload: expect.objectContaining({ artifacts: expect.any(Array) }) });

		const workday = await json(await app.request('/v1/ui/workdays/ui-workday-1', { headers }));
		expect(workday).toMatchObject({
			ok: true,
			payload: {
				workday: expect.objectContaining({
					id: 'ui-workday-1',
					objective: 'Verify backend UI projections',
				}),
			},
		});

		const missingArtifact = await app.request('/v1/ui/knowledge/missing-artifact', { headers });
		expect(missingArtifact.status).toBe(404);
		expect(await json(missingArtifact)).toMatchObject({ ok: false, error: 'Unknown knowledge artifact.' });

		const anonymous = await app.request('/v1/ui/governance');
		expect(anonymous.status).toBe(401);
		expect(await json(anonymous)).toMatchObject({ ok: false });
	}, 30000);
});
