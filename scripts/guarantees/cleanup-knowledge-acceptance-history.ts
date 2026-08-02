import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildKnowledgePublication } from '../../src/api/knowledge/build-publication.ts';
import { resolveKnowledgeGatewayConnection } from '../../src/api/knowledge/gateway-treedx-connection.ts';
import { createKnowledgePublicationStorage } from '../../src/api/knowledge/publication-storage.ts';
import { loadKnowledgeSnapshotProjects } from '../../src/api/knowledge/snapshot-projects.ts';
import { MarketControlPlaneStore } from '../../src/api/persistence/store.ts';
import { createMarketPostgresDatabase } from '../../src/api/support/market-postgres.ts';

assert.equal(process.env.TREESEED_ACCEPTANCE_ENVIRONMENT, 'local', 'Knowledge history cleanup is local-only.');
const packageRoot = resolve(import.meta.dirname, '../..');
process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT ||= resolve(packageRoot, '.treeseed/runtime/published-knowledge');
const teamId = String(process.env.TREESEED_KNOWLEDGE_TEAM_ID ?? '').trim();
assert.match(teamId, /^[a-f0-9-]{36}$/u, 'An exact acceptance team ID is required.');
const acceptanceId = /^guarantee-(book|page)-[a-z0-9]+-(desktop|tablet|mobile)(?:-chromium)?$/u;
const database = createMarketPostgresDatabase(process.env.TREESEED_DATABASE_URL
	?? 'postgresql://treeseed:treeseed-local-dev@127.0.0.1:54329/treeseed_api');
const store = new MarketControlPlaneStore({ environment: 'local', TREESEED_ENVIRONMENT: 'local',
	baseUrl: 'http://127.0.0.1:3000', TREESEED_TREEDX_URL: process.env.TREESEED_TREEDX_URL ?? 'http://127.0.0.1:4000',
	TREESEED_TREEDX_JWT_HS256_SECRET: process.env.TREESEED_TREEDX_JWT_HS256_SECRET ?? 'treeseed-local-treedx-jwt-secret' }, database);
const storage = createKnowledgePublicationStorage({ environment: 'local' });
assert.ok(storage.listRevisions && storage.retireRevisions,
	'The local publication adapter does not support acceptance-history retirement.');

async function refreshGraph(client: any, input: any) {
	const refresh = await client.refreshGraph(input);
	if (!refresh.jobId) return refresh;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const job = await client.getGraphRefreshJob({ ...input, jobId: refresh.jobId });
		if (job.status === 'completed') return job;
		if (job.status === 'failed') throw new Error(`TreeDX graph cleanup failed: ${job.errorCode ?? 'unknown'}.`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('TreeDX graph cleanup timed out.');
}

const retiredBranches: string[] = [];
const updatedGraphRevisions: Record<string, string> = {};
try {
	await store.ensureInitialized();
	let current = await storage.readCurrent(teamId);
	assert.ok(current, 'The current knowledge publication is missing.');
	const runEntries = current!.entries.filter((entry) => acceptanceId.test(entry.id));
	for (const projectId of [...new Set(runEntries.map((entry) => entry.projectId))]) {
		const entries = runEntries.filter((entry) => entry.projectId === projectId);
		const project = current!.projects.find((candidate) => candidate.projectId === projectId);
		assert.ok(project, `The acceptance project ${projectId} is absent from the current source closure.`);
		const id = randomUUID();
		const branchName = `refs/heads/knowledge/${id}`;
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId, write: true, workspaceRefs: [branchName] });
		assert.ok(connection, `TreeDX is unavailable for acceptance project ${projectId}.`);
		const workspace = await connection!.client.createWorkspace({ workspaceId: `ws_${id}`, repoId: connection!.repositoryId,
			baseRef: connection!.baseRef, branchName, mode: 'writable', allowedPaths: connection!.allowedPaths, ttlSeconds: 3_600 });
		assert.equal(workspace.baseCommitSha, project!.commitSha, 'Acceptance cleanup refuses a stale publication base.');
		try {
			for (const entry of entries.sort((left) => left.kind === 'page' ? -1 : 1)) {
				const file = await connection!.client.readFile({ workspaceId: workspace.workspaceId, path: entry.sourcePath });
				await connection!.client.deleteFile({ workspaceId: workspace.workspaceId, path: entry.sourcePath, expectedSha: file.sha });
			}
			const commit = await connection!.client.commit({ workspaceId: workspace.workspaceId,
				message: 'Remove legacy acceptance knowledge',
				author: { name: 'TreeSeed acceptance cleanup', email: 'acceptance-cleanup@treeseed.local' } });
			const publisher = await resolveKnowledgeGatewayConnection(store, { projectId, write: false,
				publishRefs: [commit.branchName, connection!.baseRef] });
			assert.ok(publisher, 'TreeDX publication scope is unavailable during acceptance cleanup.');
			await publisher!.client.promoteRef({ repoId: connection!.repositoryId, sourceRef: commit.branchName,
				destinationRef: connection!.baseRef, expectedDestinationHead: workspace.baseCommitSha });
			await refreshGraph(publisher!.client, { repoId: connection!.repositoryId, ref: connection!.baseRef,
				paths: connection!.allowedPaths, forceFull: true });
			const search = await publisher!.client.refreshSearchIndex({ repoId: connection!.repositoryId,
				ref: connection!.baseRef, paths: connection!.allowedPaths });
			assert.equal(search.resolvedRef, commit.commitSha, 'Acceptance cleanup search closure is stale.');
			updatedGraphRevisions[projectId] = String(search.graphVersion ?? search.indexVersion);
			await publisher!.client.retireRef({ repoId: connection!.repositoryId, ref: commit.branchName,
				mergedIntoRef: connection!.baseRef, expectedHead: commit.commitSha, expectedMergedIntoHead: commit.commitSha });
			retiredBranches.push(commit.branchName);
		} finally { await connection!.client.closeWorkspace(workspace.workspaceId).catch(() => undefined); }
	}
	if (runEntries.length) {
		const snapshots = await loadKnowledgeSnapshotProjects(store, { teamId });
		const graphRevisions: Record<string, string> = {};
		const refs: Record<string, string> = {};
		for (const snapshot of snapshots) {
			const project = current!.projects.find((candidate) => candidate.projectId === snapshot.projectId);
			graphRevisions[snapshot.projectId] = updatedGraphRevisions[snapshot.projectId] ?? project?.graphRevision ?? '';
			assert.ok(graphRevisions[snapshot.projectId], `The graph revision for ${snapshot.projectId} is missing.`);
			refs[snapshot.projectId] = project?.ref ?? 'refs/heads/main';
		}
		const built = buildKnowledgePublication({ teamId, generatedAt: new Date().toISOString(),
			projects: snapshots, graphRevisions, refs });
		await storage.publish({ manifest: built.manifest, objects: built.objects, expectedRevision: current!.revision });
		current = built.manifest;
	}
	const retainedRevisions = new Set([current!.revision, current!.previousRevision].filter(Boolean));
	const revisions = (await storage.listRevisions!(teamId)).filter((manifest) => !retainedRevisions.has(manifest.revision));
	const retired = revisions.length ? await storage.retireRevisions!({ teamId,
		revisions: revisions.map((manifest) => manifest.revision), expectedCurrentRevision: current!.revision })
		: { revisionsRemoved: [], objectsRemoved: [] };
	process.stdout.write(`${JSON.stringify({ ok: true, teamId, entriesRemoved: runEntries.length,
		retiredBranches, ...retired }, null, 2)}\n`);
} finally { await database.close(); }
