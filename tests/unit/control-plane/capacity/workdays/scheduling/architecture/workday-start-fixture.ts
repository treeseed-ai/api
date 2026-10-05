import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { parse } from 'yaml';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { createCapacityControlPlane, type CapacityControlPlaneHost } from '../../../../../../../src/api/capacity/control-plane.ts';
import { createWorkdayService } from '../../../../../../../src/api/control-plane/repositories/capacity/workday-service.ts';

// No seeded start receipt, applied plan, graph, reservation or assignment.
// Actual public service -> preflight -> owning run/schedule/profile repositories
// -> official TreeDX HTTP -> actual graph/event SQL. The remote content, admin
// principal and YAML are controlled inputs, not independent authorization,
// authenticated operator HTTP, provider dispatch/charges or physical teardown.
export async function workdayStartDatabase() {
	const db = new PGlite();
	const calls: Array<{ method: string; path: string; input: unknown }> = [];
	const upstream = { status: 200, resolvedRef: 'a'.repeat(40), malformed: false };
	const server = createServer(async (request, response) => {
		try {
			let body = ''; for await (const chunk of request) body += String(chunk);
			calls.push({ method: request.method ?? '', path: request.url ?? '', input: body ? JSON.parse(body) : null });
			if (request.method !== 'POST' || request.url !== '/api/v1/repos/planning-library/paths/list') {
				response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'permission_denied' } })); return;
			}
			response.writeHead(upstream.status, { 'content-type': 'application/json' });
			response.end(upstream.status !== 200 ? JSON.stringify({ error: { code: upstream.status === 403 ? 'permission_denied' : 'unavailable' } })
				: upstream.malformed ? '{invalid' : JSON.stringify({ resolvedRef: upstream.resolvedRef, paths: [], page: { hasMore: false, nextCursor: null } }));
		} catch { response.writeHead(400); response.end(); }
	});
	const closeServer = async () => {
		if (!server.listening) return;
		server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	};
	try {
		for (const file of ['0000_control_plane.sql', '0023_living_execution_graph.sql', '0031_workday_execution_mode_authority.sql',
			'0032_execution_graph_revision_integrity.sql', '0033_settle_actual_usage_without_approval.sql',
			'0034_recurring_workday_canonical_intent.sql', '0041_execution_content_output_authority.sql', '0044_execution_priority_dependency_provenance.sql']) {
			await db.exec(readFileSync(`drizzle/control-plane/${file}`, 'utf8'));
		}
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native HTTP address required');
		const endpoint = `http://127.0.0.1:${address.port}`;
		for (const key of ['TREESEED_TREEDX_URL', 'TREESEED_TREEDX_BASE_URL']) {
			if (process.env[key] && process.env[key] !== endpoint) throw new Error(`${key} must not redirect this disposable fixture to an external service`);
		}
		const query = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[] = []) => {
			let index = 0; return db.query<T>(sql.replace(/\?/gu, () => `$${++index}`), values);
		};
		const all = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await query<T>(sql, values)).rows;
		const first = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await all<T>(sql, values))[0] ?? null;
		const now = new Date().toISOString();
		const parsed = validateAgentDefinitionModel(parse(`
schemaVersion: treeseed.agent/v1
id: configured/renamed-planner
name: Renamed governed planner
agentClass: boundary-planner
purpose: Produce governed planning content within the original window.
responsibilities: [Preserve exact authority and report unfinished work.]
capabilities: [planning]
context: { include: [assignment-subject] }
activityProfiles:
  planning:
    handler: writer
    prompt: { system: Plan only the exact authorized subject. }
    permissions: { content: { read: [knowledge, proposal], write: [proposal] }, tools: [] }
`));
		if (!parsed.ok || !parsed.data) throw new Error(JSON.stringify(parsed.diagnostics));
		const definition = parsed.data;
		await query('INSERT INTO teams (id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?)', ['team', 'team', 'Team', '{}', now, now]);
		await query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', ['project', 'team', 'arbitrary-project', 'Project', JSON.stringify({ library: { role: 'library' } }), now, now]);
		// Required original provider FK, not an authentication or native offer proof.
		// Only this disposable PUBLIC key is persisted; no credential is printed.
		const publicJwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
		await query('INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)',
			['provider', createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex'), JSON.stringify(publicJwk), 'Disposable fixture provider', now, now]);
		await query('INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', ['membership', 'team', 'provider', now, 'operator', now, now]);
		await query('INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
			['class', 'team', 'project', 'boundary-planner', 'Configured planner', JSON.stringify({ agents: [definition] }), now, now]);
		await query(`INSERT INTO treedx_project_libraries (id,team_id,project_id,instance_id,library_id,repository_id,content_path,content_repository_default_branch,content_repository_ref,metadata_json,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ['binding', 'team', 'project', 'instance', 'library', 'planning-library', '.', 'staging', 'a'.repeat(40), JSON.stringify({ resolvedRef: 'a'.repeat(40) }), now, now]);
		const outside = async (): Promise<never> => { throw new Error('Unrelated host mutation is outside first-start coverage'); };
		const project = (id: string) => first<{ id: string; teamId: string; slug: string; metadata: unknown }>('SELECT id,team_id AS "teamId",slug,metadata_json::jsonb AS metadata FROM projects WHERE id=?', [id]);
		const host: CapacityControlPlaneHost = {
			config: { TREESEED_TREEDX_URL: endpoint, TREESEED_ENVIRONMENT: 'test' }, ensureInitialized: async () => undefined,
			all, first, run: async (sql, values = []) => { await query(sql, values); },
			batch: operations => db.transaction(async transaction => {
				const results = [];
				for (const operation of operations) {
					let index = 0;
					const result = await transaction.query(operation.query.replace(/\?/gu, () => `$${++index}`), operation.params ?? []);
					results.push({ results: result.rows });
				}
				return results;
			}), createTeam: outside, prepareTeamDeletion: outside, getProject: project,
			getProjectDetails: async id => { const value = await project(id); return value ? { project: value } : null; },
			getProjectTreeDxLibrary: id => first(`SELECT id,repository_id AS "repositoryId",content_path AS "contentPath",instance_id AS "instanceId",
				content_repository_ref AS "contentRepositoryRef",content_repository_default_branch AS "contentRepositoryDefaultBranch",
				metadata_json::jsonb AS metadata,topology_json::jsonb AS topology FROM treedx_project_libraries WHERE project_id=?`, [id]),
			listTeamProjects: team => all<{ id: string; slug: string }>('SELECT id,slug,metadata_json::jsonb AS metadata FROM projects WHERE team_id=? ORDER BY id', [team]),
			getTeam: team => first('SELECT * FROM teams WHERE id=?', [team]),
			listApprovalRequestsForProject: outside, listHubRepositories: outside, getProjectArchitecture: outside,
		};
		const store = createCapacityControlPlane(host), publicService = createWorkdayService(store);
		const principal = { id: 'operator', roles: ['admin'] };
		const intent = { schemaVersion: 'treeseed.workday-intent/v1', teamId: 'team', profileId: 'default', projects: ['project'],
			executionMode: 'simulation', startsAt: now, durationSeconds: 60, planningOnly: true,
			operatorConstraints: { providerIds: ['provider'], maxConcurrency: 1 } };
		const snapshot = async () => ({ workdays: await all('SELECT * FROM capacity_workday_runs ORDER BY id'),
			receipts: await all('SELECT * FROM capacity_operation_receipts ORDER BY id'), schedules: await all('SELECT * FROM capacity_workday_schedules ORDER BY id'),
			nodes: await all('SELECT * FROM execution_nodes ORDER BY id'), edges: await all('SELECT * FROM execution_edges ORDER BY id'),
			revisions: await all('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision'), events: await all('SELECT * FROM capacity_workday_events ORDER BY event_index,id'),
			assignments: await all('SELECT * FROM capacity_provider_assignments ORDER BY id'), reservations: await all('SELECT * FROM capacity_reservations ORDER BY id'),
			usage: await all('SELECT * FROM capacity_usage_actuals ORDER BY id'), ledger: await all('SELECT * FROM capacity_ledger_entries ORDER BY id') });
		const preflight = () => publicService.preflight(principal, 'team', intent);
		const start = (receipt: Awaited<ReturnType<typeof preflight>>, key = 'first-start') => publicService.start(principal, 'team',
			{ preflightId: receipt.id, preflightDigest: receipt.preflightDigest }, key);
		return { db, query, all, first, store, publicService, principal, intent, definition, upstream, calls, preflight, start, snapshot,
			close: async () => { try { await closeServer(); } finally { await db.close(); } } };
	} catch (error) { try { await closeServer(); } finally { await db.close(); } throw error; }
}
