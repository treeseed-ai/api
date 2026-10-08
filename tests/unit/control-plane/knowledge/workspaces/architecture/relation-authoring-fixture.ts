import assert from 'node:assert/strict';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { stringify } from 'yaml';
import { FetchTransport, TreeDxClient } from '@treeseed/treedx/treedx/client';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { TreeDxInfrastructureClient } from '../../../../../../src/api/control-plane/treedx/infrastructure-client.ts';
import { createKnowledgeWorkspaceService } from '../../../../../../src/api/control-plane/knowledge/knowledge-workspace-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { completedGraphRefresh, requireIndexedSourceClosure, treeDxResult } from '../../../../../../src/operations-runner/knowledge/publication-executor.ts';
import { loadTeamExactDependencyLinks } from '../../../../../../src/api/capacity/services/capacity/execution/exact-dependency-links.ts';
import { relationInputs, relationPath } from '../../../capacity/execution/graph/architecture/relations/relation-fixture.ts';
import { postgresGraph } from '../../../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import { translateControlPlaneSqlToPostgres } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { treeDxDelegationAuthority } from '../../../../../../src/api/control-plane/treedx/delegation-authority.ts';

type Row = Record<string, unknown>;
export const object = (value: unknown): Row => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };
export const noteSource = () => `---\n${stringify(relationInputs().note)}---\n\nReviewed precursor governs dependent work.\n`;

// Native integration requires the EXISTING disposable TreeDX SDK conformance
// server and its configured trust of the original API delegation authority.
// Never start a server, install/build an engine, fall back to controlled replies,
// weaken authorization, print tokens or operate on an existing portfolio repo.
// Administrative principal and proposal endpoints are supplied inputs; this is
// not authenticated API HTTP, native proposal creation, provider charges or E2E.
export async function relationAuthoringDatabase(nativePostgres = false) {
	const baseUrl = process.env.TREEDX_BASE_URL ?? '', token = process.env.TREEDX_TOKEN ?? '';
	assert.ok(baseUrl && token, 'Disposable native TreeDX conformance URL and token required; never skip');
	const url = new URL(baseUrl);
	assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol));
	assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.pathname, '/'); assert.equal(url.search, ''); assert.equal(url.hash, '');
	assert.equal(process.env.TREEDX_CONFORMANCE_ALLOW_ADMIN, '1');
	assert.equal(process.env.TREEDX_CONFORMANCE_ALLOW_DESTRUCTIVE, '1');
	const conformanceRoot = realpathSync(process.env.TREEDX_CONFORMANCE_TMP ?? '');
	assert.ok(conformanceRoot !== '/' && conformanceRoot.startsWith('/tmp/'), 'Original disposable conformance root required');
	for (const key of ['TREESEED_TREEDX_URL', 'TREESEED_TREEDX_BASE_URL']) {
		assert.ok(!process.env[key] || process.env[key]?.replace(/\/+$/u, '') === baseUrl.replace(/\/+$/u, ''), 'Native server override must not redirect custody');
	}
	// The configured bootstrap scope is controlled test authority, not an agent
	// lease. Use the existing issuer/auth-provider path with its unchanged120s
	// expiry so a complete suite does not reuse an expired startup credential.
	const authority = treeDxDelegationAuthority(), parts = token.split('.'); assert.equal(parts.length, 3);
	const header = object(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
	const claims = object(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
	assert.equal(header.alg, 'RS256'); assert.equal(header.kid, authority.currentJwk.kid);
	assert.ok(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
		createPublicKey({ key: authority.currentJwk, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url')));
	assert.equal(claims.iss, authority.issuer); assert.equal(claims.aud, authority.audience);
	assert.ok(Number(claims.exp) - Number(claims.iat) <= 125 && Number(claims.exp) > Number(claims.iat));
	const scope = (key: string) => { const values = claims[key]; assert.ok(Array.isArray(values));
		return values.map(value => { assert.equal(typeof value, 'string'); assert.ok(value); return String(value); }); };
	const identity = (key: string) => { assert.equal(typeof claims[key], 'string'); assert.ok(claims[key]); return String(claims[key]); };
	const delegation = { actorId: identity('treedx_actor_id'), tenantId: identity('treedx_tenant_id'),
		projectId: identity('treeseed_project_id'), connectionId: identity('treeseed_connection_id'),
		scope: { repositoryIds: scope('treedx_repo_ids'), capabilities: scope('treedx_capabilities'),
			refs: scope('treedx_refs'), paths: scope('treedx_paths') } };
	const client = new TreeDxClient({ baseUrl, transport: new FetchTransport({ baseUrl,
		authProvider: { getToken: () => authority.mint(delegation).token }, timeoutMs: 15_000 }) });
	const nativeNode = object(object(await client.registry.localNode()).node), nodeId = String(nativeNode.id ?? '');
	assert.ok(nodeId, 'Native server must expose its actual broker node identity');
	const postgres = nativePostgres ? await postgresGraph() : undefined, lite = postgres ? undefined : new PGlite();
	const db = postgres ? { query: <T extends Row>(sql: string, params: unknown[] = []) => postgres.left.pool.query<T>(sql, params),
		exec: (sql: string) => postgres.left.pool.query(sql), close: postgres.close } : lite!;
	const repositories: string[] = [], workspaces = new Set<string>();
	const bootstrap = new TreeDxInfrastructureClient(client);
	const query = (sql: string, params: unknown[] = []) => postgres
		? postgres.left.pool.query<Row>(translateControlPlaneSqlToPostgres(sql), params)
		: lite!.query<Row>(translateControlPlaneSqlToPostgres(sql), params);
	class Statement {
		constructor(readonly sql: string, readonly params: unknown[]) {}
		async run() { const result = await query(this.sql, this.params); return { success: true as const, results: result.rows, meta: {
			changes: 'affectedRows' in result ? result.affectedRows ?? result.rows.length : result.rowCount ?? result.rows.length } }; }
		async first() { return (await query(this.sql, this.params)).rows[0] ?? null; }
		async all() { return { results: (await query(this.sql, this.params)).rows }; }
	}
	const close = async () => {
		const failures: unknown[] = [];
		for (const workspace of workspaces) try { await client.workspaces.close(workspace); } catch (error) { failures.push(error); }
		for (const repo of repositories) try {
			await client.repositories.retire(repo);
			try { await client.repositories.get(repo); failures.push(new Error('Retired native fixture repository remains publicly readable')); }
			catch (error) { if (object(error).status !== 404) failures.push(error); }
		} catch (error) { failures.push(error); }
		await db.close();
		if (failures.length) throw new AggregateError(failures, 'Native relation fixture teardown remains unproven');
	};
	try {
		for (const file of postgres ? [] : ['0000_control_plane.sql', '0006_treedx_commit_replication.sql', '0017_remove_git_backup_replication.sql', '0018_repair_git_backup_column_removal.sql', '0023_living_execution_graph.sql', '0032_execution_graph_revision_integrity.sql', '0041_execution_content_output_authority.sql', '0044_execution_priority_dependency_provenance.sql']) {
			await db.exec(readFileSync(`drizzle/control-plane/${file}`, 'utf8'));
		}
		const config = { TREESEED_TREEDX_URL: baseUrl, TREESEED_TREEDX_NODE_ID: nodeId, TREESEED_ENVIRONMENT: 'test' };
		const store = new ControlPlaneStore(config, postgres?.left ?? {
			prepare: (sql: string) => ({ bind: (...params: unknown[]) => new Statement(sql, params) }),
			batch: (statements: unknown[]) => { assert.ok(lite); return lite.transaction(async transaction => {
				for (const statement of statements) {
					assert.ok(statement instanceof Statement); let index = 0;
					await transaction.query(statement.sql.replace(/\?/gu, () => `$${++index}`), statement.params);
				}
			}); },
		});
		// Original DDL above is already applied. Preserve the actual store methods;
		// avoid invoking unrelated owner-account/environment seeding in this fixture.
		store.initializationPromise = Promise.resolve();
		const peerStore = postgres ? new ControlPlaneStore(config, postgres.right) : undefined;
		if (peerStore) peerStore.initializationPromise = Promise.resolve();
		const input = relationInputs(), now = new Date().toISOString();
		if (!postgres) await query('INSERT INTO teams (id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?)', ['team', 'team', 'Team', '{}', now, now]);
		// Existing public publication methods update the represented binding.
		// This fresh instance row is connection INPUT, not provisioning evidence.
		await query(`INSERT INTO treedx_instances (id,team_id,kind,provider,name,base_url,status,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?)`, ['native-conformance', 'team', 'local', 'treedx', 'Disposable native authority fixture', baseUrl, 'active', now, now]);
		for (const source of input.sources) {
			const name = `api-relation-${randomUUID()}`;
			const response = object(await client.repositories.create({ repositoryName: name })), repo = object(response.repo);
			assert.equal(repo.repositoryName, name); assert.equal(repo.storageKind, 'managed'); assert.ok(!repo.remoteUrl);
			const repoId = String(repo.repoId ?? ''); assert.ok(repoId); repositories.push(repoId);
			const refsResponse = object(await client.repositories.refs(repoId)); assert.ok(Array.isArray(refsResponse.refs));
			const initial = refsResponse.refs.map(object).find(ref => ref.name === 'refs/heads/main'); assert.ok(initial);
			const baseCommit = String(initial.target ?? initial.sha ?? ''); assert.match(baseCommit, /^[a-f0-9]{40}$/u);
			// Native repositories initialize main. Create a disposable staging base
			// through native SDK workspace/file/commit operations, without touching
			// main or external refs and without inventing a bootstrap Git route.
			const seed = object(await client.workspaces.create(repoId, { baseRef: baseCommit, branchName: 'refs/heads/staging', mode: 'writable', allowedPaths: ['README.md'] }));
			const seedId = String(seed.workspaceId ?? ''); assert.ok(seedId); workspaces.add(seedId);
			await client.files.write(seedId, { path: 'README.md', content: 'Disposable native relation fixture\n' });
			const seedCommit = object(await client.files.commit(seedId, { message: 'Disposable staging base', author: { name: 'Relation fixture', email: 'relation-fixture@example.invalid' } }));
			const stagingBase = String(seedCommit.commitSha ?? ''); assert.match(stagingBase, /^[a-f0-9]{40}$/u);
			await client.workspaces.close(seedId); workspaces.delete(seedId);
			await query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
				[source.projectId, 'team', source.projectId, source.projectId, '{}', now, now]);
			await query(`INSERT INTO treedx_project_libraries
				(id,team_id,project_id,instance_id,library_id,repository_id,content_path,content_repository_ref,content_repository_default_branch,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [`binding-${source.projectId}`, 'team', source.projectId, 'native-conformance', source.projectId,
					repoId, '.', stagingBase, 'staging', now, now]);
			source.repository = repoId;
		}
		// These exact proposal endpoints remain controlled accepted-proposal INPUTS.
		// The note itself, workspace changeset, commit and graph index are native.
		input.link.from.repository = input.sources[0]!.repository; input.link.to.repository = input.sources[1]!.repository;
		input.note.subjectRefs = [input.link.from, input.link.to]; input.note.links = [input.link];
		const content = `---\n${stringify(input.note)}---\n\nReviewed precursor governs dependent work.\n`;
		const service = createKnowledgeWorkspaceService(store, { projectCatalog: async () => { throw new Error('Unrelated page catalog is outside relation authoring'); } });
		const principal = { id: 'operator', roles: ['admin'], scopes: [], permissions: [] };
		const create = async (requestId = randomUUID()) => {
			const workspace = await service.create(principal, 'precursor', { requestId });
			assert.ok(workspace); workspaces.add(String(workspace.treeDxWorkspaceId)); return workspace;
		};
		const write = (workspace: { id: string; version: number }, value = content, extra: Row = {}) => service.updateContent(principal, workspace.id,
			{ kind: 'operational-content', version: workspace.version, create: true, sourcePath: relationPath, content: value, ...extra });
		const snapshot = async () => ({ workspaces: await store.all('SELECT * FROM knowledge_authoring_workspaces ORDER BY id'),
			audits: await store.all('SELECT * FROM audit_events ORDER BY id'), reviews: await store.all('SELECT * FROM knowledge_reviews ORDER BY id'),
			publications: await store.all('SELECT * FROM knowledge_publications ORDER BY id'), ledger: await store.all('SELECT * FROM capacity_ledger_entries ORDER BY id') });
		const commitAndLoad = async (workspace: { treeDxWorkspaceId: string; branchName: string; baseCommitSha: string }) => {
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: 'precursor', write: true, workspaceRefs: [workspace.branchName] }); assert.ok(connection);
			const committed = object(await connection.client.commit({ workspaceId: workspace.treeDxWorkspaceId, message: 'Native exact relation fixture',
				author: { name: 'Relation fixture', email: 'relation-fixture@example.invalid' } }));
			const commit = String(committed.commitSha ?? ''); assert.match(commit, /^[a-f0-9]{40}$/u);
			// Fixture-only native exact CAS into this fresh repository's staging.
			// Not a substitute for the public governed submission/publication runner.
			const promotion = object(await bootstrap.promoteRef({ repoId: input.sources[0]!.repository, sourceRef: workspace.branchName,
				destinationRef: 'refs/heads/staging', expectedDestinationHead: workspace.baseCommitSha }));
			assert.equal(promotion.afterHead, commit);
			await query('UPDATE treedx_project_libraries SET content_repository_ref=? WHERE project_id=?', [commit, 'precursor']);
			const read = await resolveKnowledgeGatewayConnection(store, { projectId: 'precursor', write: true, relationPaths: true, readRefs: [commit] }); assert.ok(read);
			const graph = await completedGraphRefresh(read.client, { repoId: input.sources[0]!.repository, ref: commit, paths: ['notes/**'], changedPaths: [relationPath] });
			const search = treeDxResult(await read.client.refreshSearchIndex({ repoId: input.sources[0]!.repository, ref: commit, paths: ['notes/**'] }), 'index');
			requireIndexedSourceClosure({ projectId: 'precursor', commitSha: commit, graph, search });
			const file = object(await read.client.readRepositoryFile({ repoId: input.sources[0]!.repository, ref: commit, path: relationPath }));
			assert.equal(file.resolvedRef, commit); const nativeFile = object(file.file ?? (Array.isArray(file.files) ? file.files[0] : undefined));
			assert.equal(nativeFile.path, relationPath); assert.equal(nativeFile.content, content);
			await completedGraphRefresh(read.client, { repoId: read.repositoryId, ref: read.publicationRef, paths: ['notes/**'] });
			// Loader queries every selected project's publication branch. Build the
			// original native index for the other disposable selected library too.
			const secondary = await resolveKnowledgeGatewayConnection(store, { projectId: 'dependent', write: true }); assert.ok(secondary);
			await completedGraphRefresh(secondary.client, { repoId: secondary.repositoryId, ref: 'refs/heads/staging', paths: ['notes/**'] });
			const loaded = await loadTeamExactDependencyLinks(store, input.sources);
			return { commit, graph, search, file, loaded, read };
		};
		return { ...input, db, store, peerStore, client, principal, service, content, create, write, snapshot, commitAndLoad, close, query };
	} catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native relation setup and cleanup failed'); } throw error; }
}
