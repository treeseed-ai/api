import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../src/api/support/market-postgres.js';
import { MarketControlPlaneStore } from '../../../src/api/persistence/store.js';
import { compileAssignmentCapabilityContext } from '../../../src/api/capacity/services/capacity/assignments/admission/assignment-capability-service.js';

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

describe('provider assignment capability handles', () => {
	it('derives provider-safe repository and TreeDX handles from assignment proxy metadata', async () => {
		const workspaceContext = compileAssignmentCapabilityContext({
			id: 'assignment-1',
			teamId: 'team-1',
			projectId: 'project-1',
			mode: 'planning',
			treedxProxyHandle: {
				id: 'tdx-handle-1',
				teamId: 'team-1',
				projectId: 'project-1',
				assignmentId: 'assignment-1',
				repositoryId: 'repo-1',
				workspaceId: 'workspace-1',
				allowedOperations: ['files:read'],
				allowedPaths: ['docs/**'],
				expiresAt: '2099-01-01T00:00:00.000Z',
			},
		});

		expect(workspaceContext).toMatchObject({
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
		expect(JSON.stringify(workspaceContext.capabilityHandles)).not.toContain('ghs_');
		expect(JSON.stringify(workspaceContext.capabilityHandles)).not.toContain('token');
	});

	it('rejects plaintext-like provider assignment capability handles before persistence', async () => {
		expect(() => compileAssignmentCapabilityContext({
			id: 'assignment-secret',
			teamId: 'team-1',
			projectId: 'project-1',
			mode: 'planning',
			capabilityHandles: {
				workspaceAccessMode: 'brokered_workspace',
				repository: [{
					id: 'repo-handle-secret',
					kind: 'repository_access',
					teamId: 'team-1',
					projectId: 'project-1',
					assignmentId: 'assignment-secret',
					operations: ['read'],
					githubInstallationToken: 'ghs_nope',
				}],
			},
		})).toThrow(expect.objectContaining({ code: 'assignment_capability_handle_secret_material' }));
	});

	it('binds acting repository authority to the governed exact base ref', () => {
		const exactBaseRef = '0123456789abcdef0123456789abcdef01234567';
		const workspaceContext = compileAssignmentCapabilityContext({
			id: 'assignment-acting', teamId: 'team-1', projectId: 'project-1', mode: 'acting',
			decisionInput: { input: { exactBaseRef } },
			synthesizedFrom: 'capacity_plan',
			metadata: { capacityPlanId: 'plan-1' },
			treedxProxyHandle: {
				id: 'tdx-acting', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-acting',
				repositoryId: 'repo-1', workspaceId: 'workspace-1', allowedOperations: ['files:read'], allowedPaths: ['**'],
			},
		});
		expect(workspaceContext.capabilityHandles.repository).toEqual([
			expect.objectContaining({ allowedRefs: [exactBaseRef] }),
		]);
	});
});
