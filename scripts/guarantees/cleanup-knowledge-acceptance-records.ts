import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveKnowledgeGatewayConnection } from '../../src/api/knowledge/gateway-treedx-connection.ts';
import { MarketControlPlaneStore } from '../../src/api/persistence/store.ts';
import { createMarketPostgresDatabase } from '../../src/api/support/market-postgres.ts';
import { createLocalPrivateObjectStorage } from '../../src/api/storage/private-object-storage.ts';

assert.equal(process.env.TREESEED_ACCEPTANCE_ENVIRONMENT, 'local', 'Knowledge record cleanup is local-only.');
const packageRoot = resolve(import.meta.dirname, '../..');
process.env.TREESEED_PRIVATE_OBJECT_ROOT ||= resolve(packageRoot, '.treeseed/runtime/private-objects');
const projectId = String(process.env.TREESEED_KNOWLEDGE_PROJECT_ID ?? '').trim();
assert.match(projectId, /^[a-f0-9-]{36}$/u, 'An exact acceptance project ID is required.');
const database = createMarketPostgresDatabase(process.env.TREESEED_DATABASE_URL
	?? 'postgresql://treeseed:treeseed-local-dev@127.0.0.1:54329/treeseed_api');
const store = new MarketControlPlaneStore({ environment: 'local', TREESEED_ENVIRONMENT: 'local',
	baseUrl: 'http://127.0.0.1:3000', TREESEED_TREEDX_URL: process.env.TREESEED_TREEDX_URL ?? 'http://127.0.0.1:4000',
	TREESEED_TREEDX_JWT_HS256_SECRET: process.env.TREESEED_TREEDX_JWT_HS256_SECRET ?? 'treeseed-local-treedx-jwt-secret' }, database);
const objects = createLocalPrivateObjectStorage();
const visualEmails = ['visual.platform-admin@treeseed.io', 'visual.knowledge-reviewer@treeseed.io'];

try {
	await store.ensureInitialized();
	const actors = await database.prepare('SELECT id, email FROM users WHERE email = ANY(?::text[])')
		.bind(visualEmails).all();
	assert.equal(actors.results.length, visualEmails.length, 'The exact visual acceptance principals are missing.');
	const actorIds = actors.results.map((row) => String(row.id));
	const workspaces = await database.prepare(`SELECT workspaces.* FROM knowledge_authoring_workspaces workspaces
		WHERE workspaces.project_id = ? AND workspaces.actor_user_id = ANY(?::text[])`)
		.bind(projectId, actorIds).all();
	const unrelated = await database.prepare(`SELECT id FROM knowledge_authoring_workspaces
		WHERE project_id != ? OR actor_user_id != ALL(?::text[]) LIMIT 1`).bind(projectId, actorIds).first();
	assert.equal(unrelated, null, 'Knowledge workflow storage contains non-acceptance work and cannot be bulk reconciled.');
	const connection = await resolveKnowledgeGatewayConnection(store, { projectId, write: false });
	assert.ok(connection, 'TreeDX is unavailable for knowledge record cleanup.');
	const refs = await connection!.client.listRepositoryRefs(connection!.repositoryId);
	assert.equal(refs.some((ref) => /^refs\/heads\/knowledge\//u.test(ref.name)), false,
		'Knowledge records cannot be removed while an authoring ref remains.');
	for (const workspace of workspaces.results) {
		await connection!.client.closeWorkspace(String(workspace.treedx_workspace_id));
	}

	const builds = await database.prepare(`SELECT * FROM knowledge_pack_builds
		WHERE requested_by_user_id = ANY(?::text[])`).bind(actorIds).all();
	const unrelatedBuild = await database.prepare(`SELECT id FROM knowledge_pack_builds
		WHERE requested_by_user_id != ALL(?::text[]) LIMIT 1`).bind(actorIds).first();
	assert.equal(unrelatedBuild, null, 'Knowledge-pack storage contains non-acceptance builds.');
	for (const build of builds.results) {
		const artifact = JSON.parse(String(build.artifact_json ?? '{}')) as Record<string, unknown>;
		if (artifact.storageKey) await objects.delete(String(artifact.storageKey));
	}

	const operations = await database.prepare(`SELECT operations.id FROM platform_operations operations
		WHERE operations.namespace = 'knowledge' AND operations.requested_by_id = ANY(?::text[])`).bind(actorIds).all();
	const unrelatedOperation = await database.prepare(`SELECT id FROM platform_operations
		WHERE namespace = 'knowledge' AND requested_by_id != ALL(?::text[]) LIMIT 1`).bind(actorIds).first();
	assert.equal(unrelatedOperation, null, 'Knowledge operations contain a non-acceptance principal.');
	const workspaceIds = workspaces.results.map((row) => String(row.id));
	const operationIds = operations.results.map((row) => String(row.id));
	await database.batch([
		{ query: `DELETE FROM knowledge_review_comments WHERE review_id IN
			(SELECT id FROM knowledge_reviews WHERE workspace_id = ANY(?::text[]))`, params: [workspaceIds] },
		{ query: 'DELETE FROM knowledge_publications WHERE workspace_id = ANY(?::text[])', params: [workspaceIds] },
		{ query: 'DELETE FROM knowledge_reviews WHERE workspace_id = ANY(?::text[])', params: [workspaceIds] },
		{ query: 'DELETE FROM knowledge_workspace_presence WHERE workspace_id = ANY(?::text[])', params: [workspaceIds] },
		{ query: 'DELETE FROM knowledge_authoring_workspaces WHERE id = ANY(?::text[])', params: [workspaceIds] },
		{ query: 'DELETE FROM knowledge_pack_builds WHERE id = ANY(?::text[])', params: [builds.results.map((row) => String(row.id))] },
		{ query: `DELETE FROM book_collections WHERE id != 'treeseed-platform-library'
			AND name LIKE 'Guarantee Collection %'`, params: [] },
		{ query: 'DELETE FROM platform_operation_events WHERE operation_id = ANY(?::text[])', params: [operationIds] },
		{ query: 'DELETE FROM platform_operations WHERE id = ANY(?::text[])', params: [operationIds] },
	]);
	const counts = await Promise.all(['knowledge_authoring_workspaces', 'knowledge_reviews', 'knowledge_review_comments',
		'knowledge_publications', 'knowledge_workspace_presence', 'knowledge_pack_builds'].map(async (table) => ({
		table, count: Number((await database.prepare(`SELECT COUNT(*)::int AS count FROM ${table}`).first())?.count ?? -1),
	})));
	assert.equal(counts.some((entry) => entry.count !== 0), false, 'Acceptance knowledge records remain after cleanup.');
	const collectionCount = Number((await database.prepare(`SELECT COUNT(*)::int AS count FROM book_collections
		WHERE id != 'treeseed-platform-library'`).first())?.count ?? -1);
	assert.equal(collectionCount, 0, 'Acceptance book collections remain after cleanup.');
	process.stdout.write(`${JSON.stringify({ ok: true, projectId, workspacesRemoved: workspaceIds.length,
		buildsRemoved: builds.results.length, operationsRemoved: operationIds.length, counts }, null, 2)}\n`);
} finally {
	await database.close();
}
