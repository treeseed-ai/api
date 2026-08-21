import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { TreeDxApiError } from '@treeseed/sdk/treedx';
import { createKnowledgePublicationStorage } from '../../src/api/knowledge/publication-storage.ts';
import { buildKnowledgePublication } from '../../src/api/knowledge/build-publication.ts';
import { resolveKnowledgeGatewayConnection } from '../../src/api/knowledge/gateway-treedx-connection.ts';
import { loadKnowledgeSnapshotProjects } from '../../src/api/knowledge/snapshot-projects.ts';
import { ControlPlaneStore } from '../../src/api/persistence/store.ts';
import { createControlPlanePostgresDatabase } from '../../src/api/support/control-plane-postgres.ts';
import { createLocalPrivateObjectStorage } from '../../src/api/storage/private-object-storage.ts';

type RunValue = { value?: Record<string, unknown>; device?: string };

assert.equal(process.env.TREESEED_ACCEPTANCE_ENVIRONMENT, 'local', 'Knowledge cleanup is local-only.');
const packageRoot = resolve(import.meta.dirname, '../..');
process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT ||= resolve(packageRoot, '.treeseed/runtime/published-knowledge');
process.env.TREESEED_PRIVATE_OBJECT_ROOT ||= resolve(packageRoot, '.treeseed/runtime/private-objects');
const databaseUrl = process.env.TREESEED_DATABASE_URL
	?? 'postgresql://treeseed:treeseed-local-dev@127.0.0.1:54329/treeseed_api';
const runState = JSON.parse(process.env.TREESEED_GUARANTEE_RUN_STATE ?? '{}') as Record<string, RunValue>;
const expected = Object.entries(runState).filter(([key]) => key.startsWith('knowledge.published@')).map(([key, entry]) => ({
	device: entry.device ?? key.split('@').at(-1) ?? 'unknown',
	bookId: String(entry.value?.bookId ?? ''), pageId: String(entry.value?.pageId ?? ''),
}));
assert.ok(expected.length, 'Run state contains no UI-created knowledge identifiers.');
for (const item of expected) {
	assert.match(item.bookId, /^guarantee-book-[a-z0-9]+-(desktop|tablet|mobile)(?:-chromium)?$/u);
	assert.match(item.pageId, /^guarantee-page-[a-z0-9]+-(desktop|tablet|mobile)(?:-chromium)?$/u);
}

const database = createControlPlanePostgresDatabase(databaseUrl);
const store = new ControlPlaneStore({
	environment: 'local', TREESEED_ENVIRONMENT: 'local', baseUrl: 'http://127.0.0.1:3000',
	TREESEED_TREEDX_URL: process.env.TREESEED_TREEDX_URL ?? 'http://127.0.0.1:4000',
	TREESEED_TREEDX_JWT_HS256_SECRET: process.env.TREESEED_TREEDX_JWT_HS256_SECRET ?? 'treeseed-local-treedx-jwt-secret',
}, database);
const publications = createKnowledgePublicationStorage({ environment: 'local' });
const privateObjects = createLocalPrivateObjectStorage();

async function refreshGraph(client: any, input: any) {
	const refresh = await client.refreshGraph(input);
	if (!refresh.jobId) return refresh;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const job = await client.getGraphRefreshJob({ ...input, jobId: refresh.jobId });
		if (job.status === 'completed') return { ...refresh, graphVersion: job.graphVersion ?? refresh.graphVersion };
		if (job.status === 'failed') throw new Error(`TreeDX cleanup graph refresh failed: ${job.errorCode ?? 'unknown'}.`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('TreeDX cleanup graph refresh timed out.');
}

async function publishCleanup(teamId: string, projectId: string, connection: any, commitSha: string,
	previousRevision: string | undefined, expectedRevision: string | undefined) {
	const snapshots = await loadKnowledgeSnapshotProjects(store, { teamId });
	const graphRevisions: Record<string, string> = {};
	const refs: Record<string, string> = {};
	for (const snapshot of snapshots) {
		const observed = await resolveKnowledgeGatewayConnection(store, { projectId: snapshot.projectId, write: false });
		assert.ok(observed, `TreeDX repository is unavailable for cleanup project ${snapshot.projectId}.`);
		const status = await observed!.client.refreshSearchIndex({ repoId: snapshot.repositoryId,
			ref: observed!.baseRef, paths: observed!.allowedPaths });
		assert.equal(String(status.resolvedRef ?? ''), snapshot.commitSha, `TreeDX cleanup search closure is stale for ${snapshot.projectId}.`);
		assert.equal(Boolean(status.stale), false, `TreeDX cleanup search index is stale for ${snapshot.projectId}.`);
		graphRevisions[snapshot.projectId] = String(status.graphVersion ?? status.indexVersion);
		refs[snapshot.projectId] = observed!.baseRef;
	}
	assert.equal(snapshots.find((candidate) => candidate.projectId === projectId)?.commitSha, commitSha);
	const built = buildKnowledgePublication({ teamId, generatedAt: new Date().toISOString(), previousRevision,
		projects: snapshots, graphRevisions, refs });
	await publications.publish({ manifest: built.manifest, objects: built.objects, expectedRevision });
	return built.manifest;
}

async function baselineRevision(current: any, ids: Set<string>) {
	let candidate = current;
	while (candidate?.entries?.some((entry: any) => ids.has(String(entry.id)))) {
		if (!candidate.previousRevision) return undefined;
		candidate = await publications.readRevision(candidate.teamId, candidate.previousRevision);
		assert.ok(candidate, 'The publication rollback chain is incomplete before acceptance cleanup.');
	}
	return candidate?.revision as string | undefined;
}

async function runWorkspaces(bookId: string) {
	return (await database.prepare(`SELECT workspaces.*,
		(SELECT reviews.commit_sha FROM knowledge_reviews reviews WHERE reviews.workspace_id = workspaces.id
		 AND reviews.commit_sha IS NOT NULL ORDER BY reviews.created_at DESC LIMIT 1) AS commit_sha
		FROM knowledge_authoring_workspaces workspaces WHERE EXISTS (
		 SELECT 1 FROM knowledge_reviews reviews WHERE reviews.workspace_id = workspaces.id
		 AND reviews.changed_paths_json LIKE ?)`
	).bind(`%${bookId}%`).all()).results;
}

async function retireRunWorkspaces(rows: Record<string, unknown>[], mergedIntoRef: string, mergedIntoHead: string) {
	for (const row of rows) {
		const projectId = String(row.project_id);
		const reader = await resolveKnowledgeGatewayConnection(store, { projectId, write: false });
		assert.ok(reader, `TreeDX repository is unavailable while retiring workspace ${String(row.id)}.`);
		if (row.commit_sha) {
			const branchName = String(row.branch_name);
			const existingRefs = await reader!.client.listRepositoryRefs(String(row.repository_id));
			if (existingRefs.some((ref) => ref.name === branchName)) {
				const publisher = await resolveKnowledgeGatewayConnection(store, { projectId, write: false,
					publishRefs: [String(row.branch_name), mergedIntoRef] });
				assert.ok(publisher, `TreeDX publication scope is unavailable while retiring ${String(row.branch_name)}.`);
				try {
					await publisher!.client.retireRef({ repoId: String(row.repository_id), ref: branchName, mergedIntoRef,
						expectedHead: String(row.commit_sha), expectedMergedIntoHead: mergedIntoHead });
				} catch (error) {
					if (!(error instanceof TreeDxApiError) || error.code !== 'conflict'
						|| !/fast-forward/iu.test(error.message)) throw error;
					await reader!.client.abandonWorkspace(String(row.treedx_workspace_id), String(row.commit_sha));
				}
			}
			const refs = await reader!.client.listRepositoryRefs(String(row.repository_id));
			assert.equal(refs.some((ref) => ref.name === branchName), false,
				`TreeDX retained the terminal workspace branch ${branchName}.`);
		}
		await reader!.client.closeWorkspace(String(row.treedx_workspace_id)).catch((error) => {
			if (!(error instanceof TreeDxApiError) || error.code !== 'not_found') throw error;
		});
	}
}

async function deleteOperationalRecords(bookId: string, workspaceRows: Record<string, unknown>[]) {
	const bookIds = JSON.stringify([bookId]);
	const builds = await database.prepare('SELECT * FROM knowledge_pack_builds WHERE book_ids_json::jsonb @> ?::jsonb')
		.bind(bookIds).all();
	for (const build of builds.results) {
		const artifact = JSON.parse(String(build.artifact_json ?? '{}'));
		if (artifact.storageKey) await privateObjects.delete(String(artifact.storageKey));
	}
	const workspaceIds = workspaceRows.map((row) => String(row.id));
	for (const id of workspaceIds) {
		await database.batch([
			{ query: 'DELETE FROM knowledge_review_comments WHERE review_id IN (SELECT id FROM knowledge_reviews WHERE workspace_id = ?)', params: [id] },
			{ query: 'DELETE FROM knowledge_publications WHERE workspace_id = ?', params: [id] },
			{ query: 'DELETE FROM knowledge_reviews WHERE workspace_id = ?', params: [id] },
			{ query: 'DELETE FROM knowledge_workspace_presence WHERE workspace_id = ?', params: [id] },
			{ query: 'DELETE FROM knowledge_authoring_workspaces WHERE id = ?', params: [id] },
		]);
	}
	await database.batch([
		{ query: 'DELETE FROM knowledge_pack_builds WHERE book_ids_json::jsonb @> ?::jsonb', params: [bookIds] },
		{ query: 'DELETE FROM book_collections WHERE book_ids_json::jsonb @> ?::jsonb', params: [bookIds] },
	]);
	return { workspacesRemoved: workspaceIds.length, buildsRemoved: builds.results.length };
}

async function retireRunPublicationHistory(workspaceRows: Record<string, unknown>[], teamId: string,
	expectedCurrentRevision: string) {
	const workspaceIds = workspaceRows.map((row) => String(row.id));
	if (!workspaceIds.length) return { revisionsRemoved: [], objectsRemoved: [] };
	const placeholders = workspaceIds.map(() => '?').join(', ');
	const result = await database.prepare(`SELECT DISTINCT published_revision FROM knowledge_publications
		WHERE workspace_id IN (${placeholders}) AND published_revision IS NOT NULL`).bind(...workspaceIds).all();
	const revisions = result.results.map((row) => String(row.published_revision));
	if (!revisions.length) return { revisionsRemoved: [], objectsRemoved: [] };
	assert.ok(publications.retireRevisions, 'The local publication adapter cannot retire acceptance revisions.');
	return publications.retireRevisions!({ teamId, revisions, expectedCurrentRevision });
}

const cleaned: Array<Record<string, unknown>> = [];
try {
	await store.ensureInitialized();
	for (const item of expected) {
		const bookAudit = await database.prepare(`SELECT data_json FROM audit_events
			WHERE target_id = ? AND event_type IN ('knowledge.book.created', 'knowledge.book.updated')
			ORDER BY created_at ASC LIMIT 1`).bind(item.bookId).first();
		assert.ok(bookAudit?.data_json, `No run-correlated workspace exists for ${item.bookId}.`);
		const auditData = JSON.parse(String(bookAudit!.data_json));
		const sourceWorkspace = await store.getKnowledgeWorkspace(String(auditData.workspaceId));
		const projectId = String(sourceWorkspace?.projectId ?? auditData.projectId ?? '');
		assert.ok(projectId, `The source project for ${item.bookId} is missing.`);
		const project = await database.prepare('SELECT team_id FROM projects WHERE id = ? LIMIT 1').bind(projectId).first();
		const teamId = String(sourceWorkspace?.teamId ?? project?.team_id ?? '');
		assert.ok(teamId, `The source team for ${item.bookId} is missing.`);
		const current = await publications.readCurrent(teamId);
		assert.ok(current, 'The current knowledge publication is missing.');
		const entries = current!.entries.filter((entry) => entry.id === item.bookId || entry.id === item.pageId);
		assert.ok(entries.length === 0 || entries.length === 2,
			'Cleanup refuses a partial current-manifest state for the run book and page.');
		assert.ok(entries.every((entry) => entry.projectId === projectId));
		if (!sourceWorkspace) {
			assert.equal(entries.length, 0,
				`The source workspace for ${item.bookId} is missing while its published content remains.`);
			cleaned.push({ ...item, alreadyClean: true, publicationRevision: current!.revision });
			continue;
		}
		let cleanupCommitSha: string | undefined;
		let publicationRevision = current!.revision;
		let mergedIntoHead = current!.projects.find((project) => project.projectId === sourceWorkspace!.projectId)?.commitSha;
		assert.ok(mergedIntoHead, 'The current publication has no project commit for run cleanup.');
		if (entries.length === 2) {
			const previousRevision = await baselineRevision(current, new Set([item.bookId, item.pageId]));
			const cleanupId = randomUUID();
			const workspaceId = `ws_${cleanupId}`;
			const branchName = `refs/heads/knowledge/${cleanupId}`;
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: sourceWorkspace!.projectId,
				write: true, workspaceRefs: [branchName] });
			assert.ok(connection, 'The TreeDX cleanup repository is unavailable.');
			const remote = await connection!.client.createWorkspace({ workspaceId, repoId: connection!.repositoryId,
				baseRef: connection!.baseRef, branchName, mode: 'writable', allowedPaths: connection!.allowedPaths, ttlSeconds: 3_600 });
			try {
			for (const entry of entries.sort((left) => left.kind === 'page' ? -1 : 1)) {
				const file = await connection!.client.readFile({ workspaceId: remote.workspaceId, path: entry.sourcePath });
				await connection!.client.deleteFile({ workspaceId: remote.workspaceId, path: entry.sourcePath,
					expectedSha: file.sha });
			}
			const commit = await connection!.client.commit({ workspaceId: remote.workspaceId,
				message: `Remove acceptance knowledge ${item.bookId}`,
				author: { name: 'TreeSeed acceptance cleanup', email: 'acceptance-cleanup@treeseed.local' } });
			const publisher = await resolveKnowledgeGatewayConnection(store, { projectId: sourceWorkspace!.projectId,
				write: false, publishRefs: [commit.branchName, connection!.baseRef] });
			assert.ok(publisher, 'The TreeDX cleanup publication scope is unavailable.');
			const promotion = await publisher!.client.promoteRef({ repoId: connection!.repositoryId,
				sourceRef: commit.branchName, destinationRef: connection!.baseRef,
				expectedDestinationHead: remote.baseCommitSha });
			assert.equal(promotion.rejectedRefs?.length ?? 0, 0, 'TreeDX rejected the cleanup ref promotion.');
			await refreshGraph(publisher!.client, { repoId: connection!.repositoryId, ref: connection!.baseRef,
				paths: connection!.allowedPaths, forceFull: true });
			const search = await publisher!.client.refreshSearchIndex({ repoId: connection!.repositoryId,
				ref: connection!.baseRef, paths: connection!.allowedPaths });
			assert.equal(String(search.resolvedRef ?? ''), commit.commitSha, 'Cleanup search did not resolve the cleanup commit.');
			assert.equal(Boolean(search.stale), false, 'Cleanup search index remained stale.');
			const manifest = await publishCleanup(sourceWorkspace!.teamId, sourceWorkspace!.projectId,
				connection, commit.commitSha, previousRevision, current!.revision);
			assert.equal(manifest.entries.some((entry) => entry.id === item.bookId || entry.id === item.pageId), false,
				'Atomic cleanup publication still contains run knowledge.');
			await publisher!.client.retireRef({ repoId: connection!.repositoryId, ref: commit.branchName,
				mergedIntoRef: connection!.baseRef, expectedHead: commit.commitSha,
				expectedMergedIntoHead: commit.commitSha });
			const refs = await connection!.client.listRepositoryRefs(connection!.repositoryId);
			assert.equal(refs.some((ref) => ref.name === commit.branchName), false,
				'TreeDX retained the merged cleanup branch.');
			cleanupCommitSha = commit.commitSha;
			mergedIntoHead = commit.commitSha;
			publicationRevision = manifest.revision;
			} finally {
				await connection!.client.closeWorkspace(remote.workspaceId).catch(() => undefined);
			}
		}
		const workspaces = await runWorkspaces(item.bookId);
		await retireRunWorkspaces(workspaces, sourceWorkspace!.baseRef, mergedIntoHead!);
		const retired = await retireRunPublicationHistory(workspaces, sourceWorkspace!.teamId, publicationRevision);
		const removed = await deleteOperationalRecords(item.bookId, workspaces);
		cleaned.push({ ...item, cleanupCommitSha, publicationRevision, ...retired, ...removed });
	}
} finally {
	await database.close();
}

process.stdout.write(`${JSON.stringify({ ok: true, cleaned }, null, 2)}\n`);
