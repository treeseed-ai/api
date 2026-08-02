import assert from 'node:assert/strict';
import { TreeDxApiError } from '@treeseed/sdk/treedx';
import { resolveKnowledgeGatewayConnection } from '../../src/api/knowledge/gateway-treedx-connection.ts';
import { MarketControlPlaneStore } from '../../src/api/persistence/store.ts';
import { createMarketPostgresDatabase } from '../../src/api/support/market-postgres.ts';

assert.equal(process.env.TREESEED_ACCEPTANCE_ENVIRONMENT, 'local', 'Knowledge ref reconciliation is local-only.');
const projectId = String(process.env.TREESEED_KNOWLEDGE_PROJECT_ID ?? '').trim();
assert.match(projectId, /^[a-f0-9-]{36}$/u, 'An exact acceptance project ID is required.');
const database = createMarketPostgresDatabase(process.env.TREESEED_DATABASE_URL
	?? 'postgresql://treeseed:treeseed-local-dev@127.0.0.1:54329/treeseed_api');
const store = new MarketControlPlaneStore({ environment: 'local', TREESEED_ENVIRONMENT: 'local',
	baseUrl: 'http://127.0.0.1:3000', TREESEED_TREEDX_URL: process.env.TREESEED_TREEDX_URL ?? 'http://127.0.0.1:4000',
	TREESEED_TREEDX_JWT_HS256_SECRET: process.env.TREESEED_TREEDX_JWT_HS256_SECRET ?? 'treeseed-local-treedx-jwt-secret' }, database);
try {
	await store.ensureInitialized();
	const reader = await resolveKnowledgeGatewayConnection(store, { projectId, write: false });
	assert.ok(reader, 'TreeDX is unavailable for knowledge ref reconciliation.');
	const refs = await reader!.client.listRepositoryRefs();
	const destinationName = reader!.baseRef.startsWith('refs/') ? reader!.baseRef : `refs/heads/${reader!.baseRef}`;
	const destination = refs.find((ref) => ref.name === destinationName);
	assert.ok(destination?.target, 'The exact publication ref is missing.');
	const candidates = refs.filter((ref) => /^refs\/heads\/knowledge\/[a-f0-9-]{36}$/u.test(ref.name));
	const publisher = candidates.length ? await resolveKnowledgeGatewayConnection(store, { projectId, write: false,
		publishRefs: [destinationName, ...candidates.map((ref) => ref.name)] }) : null;
	const retired: string[] = [];
	const abandoned: string[] = [];
	const discardedOrphans: string[] = [];
	const retained: Array<{ ref: string; head: string; reason: string }> = [];
	for (const candidate of candidates) {
		assert.ok(candidate.target, `The ref ${candidate.name} has no target.`);
		try {
			await publisher!.client.retireRef({ repoId: reader!.repositoryId, ref: candidate.name,
				mergedIntoRef: destinationName, expectedHead: candidate.target!, expectedMergedIntoHead: destination!.target! });
			retired.push(candidate.name);
		} catch (error) {
			if (!(error instanceof TreeDxApiError) || error.code !== 'conflict') throw error;
			const row = await database.prepare(`SELECT workspaces.treedx_workspace_id,
				(SELECT reviews.commit_sha FROM knowledge_reviews reviews WHERE reviews.workspace_id = workspaces.id
				 AND reviews.commit_sha IS NOT NULL ORDER BY reviews.created_at DESC LIMIT 1) AS commit_sha,
				(SELECT reviews.changed_paths_json FROM knowledge_reviews reviews WHERE reviews.workspace_id = workspaces.id
				 AND reviews.commit_sha IS NOT NULL ORDER BY reviews.created_at DESC LIMIT 1) AS changed_paths_json
				FROM knowledge_authoring_workspaces workspaces WHERE workspaces.branch_name = ? LIMIT 1`)
				.bind(candidate.name).first();
			const paths = JSON.parse(String(row?.changed_paths_json ?? '[]')) as string[];
			const acceptancePath = /(?:^|\/)guarantee-(?:book|page)-[a-z0-9]+-(?:desktop|tablet|mobile|desktop-chromium)(?:\.md|\/)/u;
			const diff = row?.treedx_workspace_id
				? await reader!.client.diff({ workspaceId: String(row.treedx_workspace_id) }).catch(() => null) : null;
			const acceptanceDiff = /guarantee-(?:book|page)-[a-z0-9]+-(?:desktop|tablet|mobile|desktop-chromium)/u;
			if (!row?.treedx_workspace_id) {
				const maintainer = await resolveKnowledgeGatewayConnection(store, { projectId, write: false,
					maintenanceRefs: [destinationName, candidate.name] });
				assert.ok(maintainer, 'TreeDX maintenance custody is unavailable.');
				const changed = await maintainer!.client.queryRepository({ repoId: reader!.repositoryId,
					ref: candidate.name, type: 'changed_path', baseRef: destinationName,
					paths: reader!.allowedPaths, limit: 2_000 });
				const changedPaths = (changed.results ?? []).map((entry) => typeof entry === 'string' ? entry
					: String((entry as Record<string, unknown>).path ?? ''));
				if (!changedPaths.length || changedPaths.some((path) => !acceptancePath.test(path))) {
					retained.push({ ref: candidate.name, head: candidate.target!,
						reason: 'The orphan ref contains changes outside the strict acceptance path contract.' });
					continue;
				}
				await maintainer!.client.discardOrphanRef({ repoId: reader!.repositoryId, ref: candidate.name,
					expectedHead: candidate.target!, reason: 'Local acceptance ref proven orphaned by exact changed paths.' });
				discardedOrphans.push(candidate.name);
				continue;
			}
			if (row.commit_sha !== candidate.target
				|| !(paths.some((path) => acceptancePath.test(path)) || acceptanceDiff.test(JSON.stringify(diff)))) {
				retained.push({ ref: candidate.name, head: candidate.target!, reason: error.message });
				continue;
			}
			await reader!.client.abandonWorkspace(String(row.treedx_workspace_id), candidate.target!);
			abandoned.push(candidate.name);
		}
	}
	const remaining = await reader!.client.listRepositoryRefs();
	assert.equal(remaining.some((ref) => [...retired, ...abandoned, ...discardedOrphans].includes(ref.name)), false,
		'TreeDX retained a reconciled acceptance ref.');
	assert.deepEqual(retained, [], 'Uncorrelated unmerged knowledge refs require operator review.');
	process.stdout.write(`${JSON.stringify({ ok: true, projectId, destination: destinationName,
		destinationHead: destination!.target, retired, abandoned, discardedOrphans, retained }, null, 2)}\n`);
} finally { await database.close(); }
