import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('tracks platform repository claims with runner ownership and safe release metadata', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		await store.ensureInitialized();
		await store.upsertMarketOperationRunner({
			runnerId: 'treeseed-ops-runner-01',
			environment: 'staging',
			metadata: { dataDir: '/data' },
		});
		const operation = await store.createPlatformOperation({
			namespace: 'repository',
			operation: 'write_content_record',
			input: {
				repository: {
					provider: 'local',
					owner: 'treeseed',
					name: 'market',
					defaultBranch: 'staging',
					cloneUrl: '/tmp/market',
				},
			},
			requestedByType: 'user',
			requestedById: 'user-1',
		});
		expect(operation).not.toBeNull();
		const claimed = await store.claimPlatformOperation({
			runnerId: 'treeseed-ops-runner-01',
			operationId: operation!.id,
			leaseSeconds: 120,
		});
		expect(claimed).not.toBeNull();
		expect(claimed!.assignedRunnerId).toBe('treeseed-ops-runner-01');
		const claimRows = await store.all(`SELECT * FROM platform_repository_claims`);
		expect(claimRows).toHaveLength(1);
		expect(claimRows[0]).toMatchObject({
			repository_key: 'local-treeseed-market',
			runner_id: 'treeseed-ops-runner-01',
			workspace_path: '/data/repositories/local-treeseed-market/repo',
			branch: 'staging',
			claim_state: 'active',
		});
		const events = await store.listPlatformOperationEvents(operation!.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toEqual(['created', 'claimed', 'repository.claimed']);
		await store.renewPlatformOperationLease(operation!.id, {
			runnerId: 'treeseed-ops-runner-01',
			leaseSeconds: 240,
		});
		const renewed = await store.all(`SELECT * FROM platform_repository_claims`);
		expect(renewed[0].lease_expires_at).toEqual(expect.any(String));
		await store.completePlatformOperation(operation!.id, {
			runnerId: 'treeseed-ops-runner-01',
			output: {
				branch: 'treeseed/platform-test',
				commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
			},
		});
		const released = await store.all(`SELECT * FROM platform_repository_claims`);
		expect(released[0]).toMatchObject({
			claim_state: 'released',
			branch: 'treeseed/platform-test',
			commit_sha: 'abcdef1234567890abcdef1234567890abcdef12',
			lease_expires_at: null,
		});
	});
});
