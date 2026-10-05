import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { assignmentAttemptSchema, emptyCapacityBudget } from '@treeseed/sdk/agent-capacity';
import { createTreeDxOperations } from '../../../../../../src/api/control-plane/catalog/treedx/index.ts';
import { OperationRegistry, type OperationInvocationContext } from '../../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { createTreeDxProxyOperationService } from '../../../../../../src/api/control-plane/repositories/treedx/proxy-operation-service.ts';
import { TreeDxDelegationAuthority } from '../../../../../../src/api/control-plane/treedx/delegation-authority.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { CapacityRuntimeEvidenceRepository, type TreeDxProxyAuditWrite } from '../../../../../../src/api/capacity/repositories/runtime/runtime-evidence.ts';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { cancellationDatabase } from '../../../providers/assignments/architecture/cancellation-fixture.ts';

export const secondaryProject = 'secondary-project', secondaryRepository = 'secondary-library';
export const firstRef = 'b'.repeat(40), secondRef = 'c'.repeat(40);
export function readGrants() {
	return [
		{ projectId: secondaryProject, repositoryId: secondaryRepository, baseRef: firstRef, allowedPaths: ['books/first.md'] },
		{ projectId: secondaryProject, repositoryId: secondaryRepository, baseRef: secondRef, allowedPaths: ['books/second.md'] },
	];
}
type Fault = 'none' | '403' | '503' | 'reset' | 'json';
type Input = { path: Record<string, unknown>; query: Record<string, unknown>; body: Record<string, unknown> };
type Captured = { method: string; path: string; body: Record<string, unknown>; scope: Record<string, unknown> };

// Original owning DDL and actual repositories/catalog/service/signing authority/
// official upstream client/native HTTP. Persisted principal/lease/grants and
// upstream content are INPUTS, not API authentication/admission, a TreeDX server,
// canonical dependency relations, native charges or physical teardown proof.
export async function crossProjectProxy() {
	const f = await cancellationDatabase();
	let publicKey: ReturnType<typeof createPublicKey> | undefined;
	const calls: Captured[] = [];
	let fault: Fault = 'none';
	const server = createServer(async (request, response) => {
		try {
			let text = ''; for await (const part of request) text += String(part);
			const body = text ? JSON.parse(text) as Record<string, unknown> : {};
			const token = String(request.headers.authorization ?? '').replace(/^Bearer /u, '');
			const parts = token.split('.');
			if (!publicKey || parts.length !== 3 || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url'))) {
				response.writeHead(401); response.end(JSON.stringify({ error: { code: 'permission_denied', message: 'Disposable signature denied.' } })); return;
			}
			const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
			// Retain only credential-free signed scope facts, never bearer/proof/token.
			const scope = Object.fromEntries(['treedx_actor_id', 'treedx_tenant_id', 'treedx_repo_ids', 'treedx_capabilities',
				'treedx_refs', 'treedx_paths', 'treeseed_project_id', 'treeseed_connection_id'].map(key => [key, claims[key]]));
			calls.push({ method: request.method ?? '', path: request.url ?? '', body, scope });
			if (fault === 'reset') { request.socket.destroy(); return; }
			response.setHeader('content-type', 'application/json');
			if (fault === '403' || fault === '503') { response.writeHead(Number(fault)); response.end(JSON.stringify({ error: {
				code: fault === '403' ? 'permission_denied' : 'unavailable', message: 'Controlled upstream failure.' } })); return; }
			if (fault === 'json') { response.end('{invalid'); return; }
			if (request.method !== 'POST' || request.url !== `/api/v1/repos/${secondaryRepository}/files/read`) {
				response.writeHead(403); response.end(JSON.stringify({ error: { code: 'permission_denied', message: 'Unexpected fixture route.' } })); return;
			}
			response.end(JSON.stringify({ resolvedRef: body.ref, files: [{ path: (body.paths as string[])[0],
				content: '# Exact secondary bytes\n', encoding: 'utf8', frontmatter: { projectId: secondaryProject } }] }));
		} catch { response.writeHead(400); response.end(); }
	});
	const close = async () => {
		try { if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } }
		finally { await f.db.close(); }
	};
	try {
		const authority = new TreeDxDelegationAuthority({ TREESEED_ENVIRONMENT: 'test' });
		publicKey = createPublicKey({ key: authority.currentJwk, format: 'jwk' });
		const original = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['projects', 'treedx_project_libraries']) {
			const ddl = original.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (ddl.length !== 1) throw new Error(`Original ${table} DDL required`); await f.db.exec(ddl[0]!);
		}
		const createdAt = new Date().toISOString(), deadline = new Date(Date.parse(createdAt) + 60_000).toISOString();
		const attempt = assignmentAttemptSchema.parse({ ...f.attempt, createdAt, deadline });
		const budget = emptyCapacityBudget(deadline, attempt.limits.maximumSeconds);
		await f.query('UPDATE capacity_provider_assignments SET created_at=?,claimed_at=?,lease_expires_at=?,assignment_attempt_json=?,capacity_envelope_json=? WHERE id=?',
			[createdAt, createdAt, deadline, JSON.stringify(attempt), JSON.stringify({ teamId: attempt.teamId, projectId: attempt.projectId, mode: 'acting', budget }), attempt.id]);
		for (const [project, repository] of [['project', 'primary-library'], [secondaryProject, secondaryRepository]]) {
			await f.query('INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES (?,?,?,?,?,?)', [project, 'team', project, project, createdAt, createdAt]);
			await f.query('INSERT INTO treedx_project_libraries (id,team_id,project_id,instance_id,library_id,repository_id,content_repository_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
				[`binding-${project}`, 'team', project, 'isolated-connection', `library-${project}`, repository, 'a'.repeat(40), createdAt, createdAt]);
		}
		const handleId = 'cross-project-handle', handleToken = 'disposable-cross-project-handle-token';
		const metadata = { baseRef: 'a'.repeat(40), baseCommitSha: 'a'.repeat(40), readRepositories: readGrants() };
		await f.query(`INSERT INTO treedx_proxy_handles (id,team_id,project_id,assignment_id,repository_id,status,scopes_json,
			allowed_operations_json,allowed_read_paths_json,token_hash,expires_at,metadata_json,issued_at,created_at,updated_at)
			VALUES (?,?,?,?,?,'issued',?,?,?,?,?,?,?,?,?)`, [handleId, 'team', 'project', attempt.id, 'primary-library',
				JSON.stringify(['project:read', 'workspace:read', 'files:read', 'project:write', 'workspace:write', 'git:commit']),
				JSON.stringify(['files:read']), JSON.stringify(['books/primary.md']), createHash('sha256').update(handleToken).digest('hex'),
				deadline, JSON.stringify(metadata), createdAt, createdAt, createdAt]);
		const assignments = new ProviderAssignmentRepository(f.owner), evidence = new CapacityRuntimeEvidenceRepository(f.owner);
		const project = async (id: string) => f.owner.first<{ id: string; teamId: string }>('SELECT id,team_id AS "teamId" FROM projects WHERE id=?', [id]);
		const outside = async (): Promise<never> => { throw new Error('Unrelated project mutation is outside cross-project read coverage'); };
		const store = { ...f.owner, getProject: project, getProjectDetails: async (id: string) => { const value = await project(id); return value ? { project: value } : null; },
			getProjectTreeDxLibrary: (id: string) => f.owner.first('SELECT repository_id AS "repositoryId",instance_id AS "instanceId",content_repository_ref AS "contentRepositoryRef" FROM treedx_project_libraries WHERE project_id=?', [id]),
			getProviderAssignment: (team: string, id: string) => assignments.get(team, id),
			getTreeDxProxyHandle: (team: string, id: string, handle: string) => evidence.getProxyHandle(team, id, handle),
			recordTreeDxProxyAudit: (input: TreeDxProxyAuditWrite) => evidence.recordProxyAudit(input),
			principalCanAccessTeam: outside, principalCanManageTeam: outside };
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native HTTP endpoint required');
		const service = createTreeDxProxyOperationService(store, { treeDxDelegationAuthority: authority, env: {
			TREESEED_ENVIRONMENT: 'test', TREESEED_TREEDX_URL: `http://127.0.0.1:${address.port}`,
			TREESEED_TREEDX_PROXY_ACTOR_ID: 'isolated-service', TREESEED_TREEDX_PROXY_TENANT_ID: 'isolated-tenant' } });
		const registry = new OperationRegistry(createTreeDxOperations({ treeDxProxy: service }));
		const input: Input = { path: { projectId: secondaryProject, repoId: secondaryRepository }, query: {}, body: { ref: secondRef, paths: ['books/second.md'], encoding: 'utf8' } };
		const context = { interface: 'rest', requestId: 'isolated-secondary-read', providerAuth: {
			principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: ['provider:assignments:read', 'provider:assignments:write'] } },
			requestHeaders: { 'x-treeseed-assignment-id': attempt.id, 'x-treeseed-treedx-proxy-handle-id': handleId, 'x-treeseed-treedx-proxy-handle': handleToken } } satisfies OperationInvocationContext;
		const invoke = (value = input, auth: OperationInvocationContext = context, operation = 'treedx.repositories.files.read') => registry.require(operation).handler(value, auth);
		const snapshot = async () => ({ financial: await f.snapshot(), handles: await f.owner.all('SELECT * FROM treedx_proxy_handles ORDER BY id'),
			libraries: await f.owner.all('SELECT * FROM treedx_project_libraries ORDER BY id'), projects: await f.owner.all('SELECT * FROM projects ORDER BY id') });
		const audit = () => evidence.listProxyAudit(secondaryProject, { assignmentId: attempt.id, limit: 100 });
		const setGrants = (grants: unknown) => f.query('UPDATE treedx_proxy_handles SET metadata_json=? WHERE id=?', [JSON.stringify({ ...metadata, readRepositories: grants }), handleId]);
		return { ...f, attempt, calls, input, context, invoke, snapshot, audit, setGrants, handleId, deadline,
			setFault: (value: Fault) => { fault = value; }, close };
	} catch (error) { await close(); throw error; }
}
