import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { MarketPostgresDatabase } from '../../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../../src/api/store.js';
import { createCapacityControlPlane } from '../../../src/api/capacity/control-plane.ts';
import { CapacityRuntimeEvidenceRepository } from '../../../src/api/capacity/repositories/runtime-evidence.ts';
import type { CapacityGovernanceDatabase } from '../../../src/api/capacity/database.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: packageRoot }, database));
	return { database, store };
}

describe('capacity runtime evidence repository', () => {
	it('persists scoped handles, fallback outputs, and bounded proxy audit evidence', async () => {
		const { database, store } = harness();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['team-evidence', 'team-evidence', 'Evidence Team', now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['project-evidence', 'team-evidence', 'project-evidence', 'Evidence Project', now, now]);
			await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-evidence', 'sha256:provider-evidence', '{}', 'Evidence Provider', 1, 'active', '{}', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-evidence', 'team-evidence', 'provider-evidence', 'approved', ?, 'owner-evidence', '{}', ?, ?)`, [now, now, now]);
			await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, created_at, updated_at) VALUES ('class-evidence', 'team-evidence', 'project-evidence', 'researcher', 'Researcher', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, project_agent_class_id, mode, created_at, updated_at) VALUES ('assignment-evidence', 'membership-evidence', 'team-evidence', 'project-evidence', 'provider-evidence', 'class-evidence', 'planning', ?, ?)`, [now, now]);

			const handle = await store.issueTreeDxProxyHandle({
				id: 'handle-evidence',
				projectId: 'project-evidence',
				assignmentId: 'assignment-evidence',
				repositoryId: 'repository-evidence',
				workspaceId: 'workspace-evidence',
				token: 'one-time-handle-token',
				scopes: ['project:read'],
				allowedOperations: ['files:read'],
				allowedPaths: ['docs/**'],
				allowedReadPaths: ['docs/**'],
				allowedWritePaths: [],
			});
			expect(handle).toMatchObject({
				id: 'handle-evidence',
				teamId: 'team-evidence',
				projectId: 'project-evidence',
				allowedReadPaths: ['docs/**'],
				allowedWritePaths: [],
				tokenHash: createHash('sha256').update('one-time-handle-token').digest('hex'),
			});
			expect(JSON.stringify(handle)).not.toContain('one-time-handle-token');

			await store.recordAgentFallbackOutput({ id: 'fallback-a', projectId: 'project-evidence', mode: 'planning', code: 'bounded-a', output: { title: 'A' } });
			await store.recordAgentFallbackOutput({ id: 'fallback-b', projectId: 'project-evidence', mode: 'planning', code: 'bounded-b', output: { title: 'B' } });
			const fallbackFirst = await store.listAgentFallbackOutputsPage('project-evidence', { limit: 1 });
			expect(fallbackFirst.page).toMatchObject({ limit: 1, hasMore: true, nextCursor: expect.any(String) });
			const fallbackSecond = await store.listAgentFallbackOutputsPage('project-evidence', {
				limit: 1,
				cursor: decodeCapacityPageCursor(fallbackFirst.page.nextCursor),
			});
			expect(new Set([...fallbackFirst.items, ...fallbackSecond.items].map((item) => item.id))).toEqual(new Set(['fallback-a', 'fallback-b']));
			await expect(store.recordAgentFallbackOutput({ id: 'fallback-a', projectId: 'project-evidence', mode: 'planning', code: 'bounded-a', output: { title: 'changed replay' } })).resolves.toMatchObject({
				id: 'fallback-a',
				output: { title: 'A' },
			});
			await expect(store.recordAgentFallbackOutput({ id: 'fallback-a', projectId: 'project-evidence', mode: 'planning', code: 'conflicting-code' })).rejects.toMatchObject({
				code: 'agent_fallback_id_conflict',
			});
			const deterministic = await store.recordAgentFallbackOutput({ assignmentId: 'assignment-evidence', projectId: 'project-evidence', mode: 'planning', code: 'bounded-deterministic' });
			await expect(store.recordAgentFallbackOutput({ assignmentId: 'assignment-evidence', projectId: 'project-evidence', mode: 'planning', code: 'bounded-deterministic' })).resolves.toMatchObject({ id: deterministic.id });

			await store.recordTreeDxProxyAudit({ id: 'audit-a', teamId: 'team-evidence', projectId: 'project-evidence', actorType: 'capacity_provider', method: 'GET', path: '/a', resultStatus: 'proxied' });
			await store.recordTreeDxProxyAudit({ id: 'audit-b', teamId: 'team-evidence', projectId: 'project-evidence', actorType: 'capacity_provider', method: 'GET', path: '/b', resultStatus: 'denied' });
			const auditFirst = await store.listTreeDxProxyAuditPage('project-evidence', { limit: 1 });
			const auditSecond = await store.listTreeDxProxyAuditPage('project-evidence', {
				limit: 1,
				cursor: decodeCapacityPageCursor(auditFirst.page.nextCursor),
			});
			expect(new Set([...auditFirst.items, ...auditSecond.items].map((item) => item.id))).toEqual(new Set(['audit-a', 'audit-b']));

			await expect(store.revokeTreeDxProxyHandle('team-evidence', 'project-evidence', 'handle-evidence', { metadata: { reason: 'operator_revoke' } })).resolves.toMatchObject({
				status: 'revoked',
				revokedAt: expect.any(String),
				metadata: { reason: 'operator_revoke' },
			});
		} finally {
			await database.close();
		}
	});

	it('surfaces persistence failures instead of reporting missing or empty evidence', async () => {
		const schemaFailure = new Error('schema_failure');
		const failingDatabase: CapacityGovernanceDatabase = {
			async ensureInitialized() {},
			async run() { throw schemaFailure; },
			async first() { throw schemaFailure; },
			async all() { throw schemaFailure; },
			async batch() { throw schemaFailure; },
		};
		const repository = new CapacityRuntimeEvidenceRepository(failingDatabase);
		await expect(repository.getProxyHandle('team', 'project', 'handle')).rejects.toThrow('schema_failure');
		await expect(repository.listProxyAudit('project')).rejects.toThrow('schema_failure');
		await expect(repository.listFallbackOutputs('project')).rejects.toThrow('schema_failure');
		await expect(repository.revokeProxyHandle('team', 'project', 'handle')).rejects.toThrow('schema_failure');
	});
});
