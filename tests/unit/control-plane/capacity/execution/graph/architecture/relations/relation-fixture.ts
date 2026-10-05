import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { exactDependencyLinkSchema } from '@treeseed/sdk/content-validation';
import { loadTeamExactDependencyLinks } from '../../../../../../../../src/api/capacity/services/capacity/execution/exact-dependency-links.ts';
import { projectTeamExecutionGraph, type VerifiedDependencyLink } from '../../../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';
import { treeDxDelegationAuthority } from '../../../../../../../../src/api/control-plane/treedx/delegation-authority.ts';
import { splitPostgresSqlStatements } from '../../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { emptyLivingGraph, graphProfiles, graphSource, livingGraphDatabase } from '../living/living-graph-fixture.ts';

export const relationCommit = 'd'.repeat(40), relationPath = 'notes/exact-dependency.md';
export function relationInputs() {
	const sources = [graphSource('precursor'), graphSource('dependent')];
	const endpoint = (source: typeof sources[number]) => ({ store: 'treedx' as const, model: 'proposal',
		id: String(source.frontmatter.id), repository: source.repository, commit: source.commit, path: source.path,
		digest: source.digest, revision: source.proposalRevision, anchor: 'work-item/first' });
	const link = exactDependencyLinkSchema.parse({ relation: 'depends_on', from: endpoint(sources[0]!), to: endpoint(sources[1]!) });
	const note = { schemaVersion: 'treeseed.note/v1', id: 'exact-dependency', projectId: 'precursor',
		classification: 'general', subjectRefs: [link.from, link.to], body: 'Reviewed precursor governs dependent work.',
		createdAt: '2026-10-03T00:00:00Z', links: [link] };
	const content = '  # Exact dependency bytes\n\nReviewed precursor governs dependent work.\n';
	const sourceRef = { store: 'treedx' as const, model: 'note', id: note.id, repository: sources[0]!.repository,
		commit: relationCommit, path: relationPath, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
	const dependency: VerifiedDependencyLink = { from: link.from, to: link.to, sourceRef };
	const profiles = graphProfiles(sources.map(source => source.projectId));
	const project = (links: VerifiedDependencyLink[] = [dependency], revision = 1) => projectTeamExecutionGraph({
		teamId: 'team', revision, sources, profiles, dependencyLinks: links, createdAt: '2026-10-03T00:00:00Z' });
	const graph = { resolvedRef: relationCommit, nodes: [{ node: { id: 'from', nodeType: 'Reference', entityType: 'ExactEntityReference', data: link.from } },
		{ node: { id: 'to', nodeType: 'Reference', entityType: 'ExactEntityReference', data: link.to } }],
		edges: [{ type: 'DEPENDS_ON', sourceId: 'from', targetId: 'to', data: { link, ownerPath: relationPath } }] };
	return { sources, profiles, link, note, content, dependency, project, graph };
}

type Captured = { route: string; body: Record<string, unknown>; scope: Record<string, unknown> };
type Fault = 'none' | '403' | '503' | 'reset' | 'json';

// Actual gateway/signing authority/official TreeDX SDK/native HTTP and owning
// graph SQL/read service. Source proposals, decisions, endpoint replies and library
// bindings are controlled INPUTS, not native relation creation, API authentication,
// provider dispatch/charge, TreeDX server, Kata or physical resource closure.
export async function relationDatabase() {
	if (process.env.TREESEED_TREEDX_URL || process.env.TREESEED_TREEDX_BASE_URL) throw new Error('Isolated relation fixture requires no external TreeDX URL override');
	if (process.env.NODE_ENV !== 'test' && process.env.TREESEED_ENVIRONMENT !== 'test') throw new Error('Disposable test delegation authority required');
	const input = relationInputs(), f = await livingGraphDatabase();
	const calls: Captured[] = [];
	let graphReply: unknown = input.graph, noteReply: unknown = { resolvedRef: relationCommit,
		files: [{ path: relationPath, content: input.content, frontmatter: input.note }] };
	let fault: Fault = 'none', faultBoundary: 'graph' | 'note' = 'graph';
	let publicKey: ReturnType<typeof createPublicKey> | undefined;
	const server = createServer(async (request, response) => {
		try {
			let raw = ''; for await (const part of request) raw += String(part);
			const body = JSON.parse(raw) as Record<string, unknown>;
			const parts = String(request.headers.authorization ?? '').replace(/^Bearer /u, '').split('.');
			if (!publicKey || parts.length !== 3 || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url'))) {
				response.writeHead(401); response.end(); return;
			}
			const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
			const scope = Object.fromEntries(['treedx_repo_ids', 'treedx_refs', 'treedx_paths', 'treedx_capabilities', 'treeseed_project_id', 'treeseed_connection_id'].map(key => [key, claims[key]]));
			const route = request.url ?? ''; calls.push({ route, body, scope });
			const graph = route.endsWith('/graph/query'), note = route.endsWith('/files/read');
			if (request.method !== 'POST' || ![...input.sources.map(source => `/api/v1/repos/${source.repository}/graph/query`),
				`/api/v1/repos/${input.sources[0]!.repository}/files/read`].includes(route)) { response.writeHead(403); response.end(); return; }
			if ((faultBoundary === 'graph' && graph) || (faultBoundary === 'note' && note)) {
				if (fault === 'reset') { request.socket.destroy(); return; }
				if (fault === '403' || fault === '503') { response.writeHead(Number(fault)); response.end(JSON.stringify({ error: { code: 'controlled_failure', message: 'Controlled relation read failure.' } })); return; }
				if (fault === 'json') { response.end('{invalid'); return; }
			}
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify(note ? noteReply : route.includes('/precursor-library/') ? graphReply : { resolvedRef: 'e'.repeat(40), nodes: [], edges: [] }));
		} catch { response.writeHead(400); response.end(); }
	});
	const close = async () => {
		try { if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } }
		finally { await f.db.close(); }
	};
	try {
		publicKey = createPublicKey({ key: treeDxDelegationAuthority().currentJwk, format: 'jwk' });
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'))
			.filter(sql => sql.startsWith('CREATE TABLE "treedx_project_libraries" ('));
		if (ddl.length !== 1) throw new Error('Original library binding DDL required'); await f.db.exec(ddl[0]!);
		for (const source of input.sources) await f.query(`INSERT INTO treedx_project_libraries
			(id,team_id,project_id,instance_id,library_id,repository_id,content_path,content_repository_ref,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`, [`binding-${source.projectId}`, 'team', source.projectId, 'isolated-connection',
				source.projectId, source.repository, '.', source.commit, '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z']);
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native HTTP endpoint required');
		const store = { ...f.store, config: { TREESEED_TREEDX_URL: `http://127.0.0.1:${address.port}` },
			getProjectTreeDxLibrary: (id: string) => f.store.first(`SELECT repository_id AS "repositoryId",instance_id AS "instanceId",
				content_path AS "contentPath",content_repository_ref AS "contentRepositoryRef" FROM treedx_project_libraries WHERE project_id=?`, [id]) };
		const load = () => loadTeamExactDependencyLinks(store, input.sources);
		const snapshot = async () => ({ ...await f.snapshot(), libraries: await f.store.all('SELECT * FROM treedx_project_libraries ORDER BY id') });
		return { ...f, ...input, calls, load, snapshot, close, empty: emptyLivingGraph,
			setGraph: (value: unknown) => { graphReply = value; }, setNote: (value: unknown) => { noteReply = value; },
			setFault: (value: Fault, boundary: 'graph' | 'note' = 'graph') => { fault = value; faultBoundary = boundary; } };
	} catch (error) { await close(); throw error; }
}
