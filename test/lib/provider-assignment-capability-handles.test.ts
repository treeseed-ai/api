import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../src/api/store.js';

const packageRoot = process.cwd();
const marketMigrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function createTestPostgresDatabase() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	return MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot: marketMigrationRoot });
}

function createTestStore() {
	return new MarketControlPlaneStore({
		repoRoot: packageRoot,
		authSecret: 'test-secret',
		baseUrl: 'https://market.example.com',
		siteUrl: 'https://market.example.com',
		issuer: 'https://market.example.com',
		projectId: 'treeseed-market',
		projectApiKey: 'market-project-key',
		projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
		serviceId: 'web',
		serviceSecret: 'web-test-secret',
		assertionSecret: 'web-assertion-secret',
	}, createTestPostgresDatabase());
}

async function seedAssignmentScope(store: MarketControlPlaneStore) {
	const team = await store.createTeam({ id: 'team-1', slug: 'team-one', name: 'team-one' });
	await store.createProject(team.id, { id: 'project-1', slug: 'project-one', name: 'Project One' });
	const project = await store.getProject('project-1');
	const provider = await store.upsertCapacityProvider(team.id, {
		id: 'provider-1',
		name: 'Provider One',
		provider: '@treeseed/agent',
		status: 'active',
	});
	const agentClass = await store.upsertProjectAgentClass(project.id, {
		id: 'class-1',
		slug: 'engineer',
		name: 'Engineer',
		allowedModes: ['planning', 'acting'],
		requiredCapabilities: ['repo_read'],
	});
	return { team, project, provider, agentClass };
}

describe('provider assignment capability handles', () => {
	it('derives provider-safe repository and TreeDX handles from assignment proxy metadata', async () => {
		const store = createTestStore();
		const { team, project, provider, agentClass } = await seedAssignmentScope(store);
		const assignment = await store.createProviderAssignment(team.id, {
			id: 'assignment-1',
			projectId: project.id,
			capacityProviderId: provider.id,
			projectAgentClassId: agentClass!.id,
			mode: 'planning',
			agentId: 'engineer',
			capacityEnvelope: { teamId: team.id, projectId: project.id, mode: 'planning', capacityProviderId: provider.id },
			decisionInput: { teamId: team.id, projectId: project.id, projectAgentClassId: agentClass!.id, mode: 'planning', input: {} },
			treedxProxyHandle: {
				id: 'tdx-handle-1',
				teamId: team.id,
				projectId: project.id,
				assignmentId: 'assignment-1',
				repositoryId: 'repo-1',
				workspaceId: 'workspace-1',
				allowedOperations: ['files:read'],
				allowedPaths: ['docs/**'],
				expiresAt: '2099-01-01T00:00:00.000Z',
			},
		});

		expect(assignment).toMatchObject({
			capabilityHandles: {
				workspaceAccessMode: 'context_only',
				treeDx: [expect.objectContaining({
					kind: 'treedx_workspace',
					proxyHandleId: 'tdx-handle-1',
					repositoryId: 'repo-1',
				})],
				repository: [expect.objectContaining({
					kind: 'repository_access',
					provider: 'treedx_proxy',
					credentialMode: 'brokered',
				})],
			},
		});
		expect(JSON.stringify(assignment!.capabilityHandles)).not.toContain('ghs_');
		expect(JSON.stringify(assignment!.capabilityHandles)).not.toContain('token');
	});

	it('rejects plaintext-like provider assignment capability handles before persistence', async () => {
		const store = createTestStore();
		const { team, project, provider, agentClass } = await seedAssignmentScope(store);

		await expect(store.createProviderAssignment(team.id, {
			id: 'assignment-secret',
			projectId: project.id,
			capacityProviderId: provider.id,
			projectAgentClassId: agentClass!.id,
			mode: 'planning',
			agentId: 'engineer',
			capacityEnvelope: { teamId: team.id, projectId: project.id, mode: 'planning', capacityProviderId: provider.id },
			decisionInput: { teamId: team.id, projectId: project.id, projectAgentClassId: agentClass!.id, mode: 'planning', input: {} },
			capabilityHandles: {
				workspaceAccessMode: 'brokered_workspace',
				repository: [{
					id: 'repo-handle-secret',
					kind: 'repository_access',
					teamId: team.id,
					projectId: project.id,
					assignmentId: 'assignment-secret',
					operations: ['read'],
					githubInstallationToken: 'ghs_nope',
				}],
			},
		})).rejects.toMatchObject({ code: 'assignment_capability_handle_secret_material' });
	});
});
