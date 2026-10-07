import assert from 'node:assert/strict';
import { dependencyLease } from '../leasing/dependency-lease-fixture.ts';
import { ControlPlaneStore } from '../../../../../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../../../../../src/api/capacity/control-plane.ts';

// Actual original store/synthesis/recovery/lease SQL. No lifecycle method, query,
// clock or serializer is mocked. Principal and reviewed predecessor rows remain
// INPUTS, not wire authentication, native model output or provider usage.
export async function dependencyPoll() {
	const f = await dependencyLease(() => new Date().toISOString(), true);
	try {
		class Statement {
			constructor(readonly sql: string, readonly params: unknown[]) {}
			async run() { const result = await f.query(this.sql, this.params); return { success: true as const, results: result.rows, meta: { changes: result.affectedRows ?? result.rows.length } }; }
			async first() { return (await f.query(this.sql, this.params)).rows[0] ?? null; }
			async all() { return { results: (await f.query(this.sql, this.params)).rows }; }
		}
		const host = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: (...params: unknown[]) => new Statement(sql, params) }),
			batch: (statements: unknown[]) => f.db.transaction(async transaction => {
				const results: Array<{ results: Record<string, unknown>[]; success: boolean; meta: { changes: number } }> = [];
				for (const statement of statements) {
					assert.ok(statement instanceof Statement); let index = 0;
					const result = await transaction.query<Record<string, unknown>>(statement.sql.replace(/\?/gu, () => `$${++index}`), statement.params);
					results.push({ results: result.rows, success: true, meta: { changes: result.affectedRows ?? result.rows.length } });
				}
				return results;
			}),
		});
		host.initializationPromise = Promise.resolve(); // Original schema already applied; no unrelated owner seeding.
		// This component fixture owns one represented project, not the default
		// eight-project portfolio. Supply that exact selection before polling;
		// retain the original admitted Attempt and all its timing/financial bytes.
		await f.query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
			[f.attempt.projectId, f.attempt.teamId, 'isolated-project', 'Supplied component project', '{}', f.now, f.now]);
		await f.query("UPDATE capacity_workday_runs SET parameters_json=jsonb_set(parameters_json::jsonb,'{projects}',?::jsonb)::text WHERE id=?",
			[JSON.stringify([f.attempt.projectId]), f.attempt.workdayId]);
		await f.query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
			['supplied-team-library', f.attempt.teamId, 'team', 'Supplied library binding', '{}', f.now, f.now]);
		for (const projectId of [f.attempt.projectId, 'supplied-team-library']) await f.query(`INSERT INTO treedx_project_libraries
			(id,team_id,project_id,instance_id,library_id,repository_id,content_repository_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
			[`supplied-library-${projectId}`, f.attempt.teamId, projectId, 'supplied-instance', `supplied-library-${projectId}`,
				`supplied-repository-${projectId}`, 'a'.repeat(40), f.now, f.now]);
		const originalApprovals = host.listApprovalRequestsForProject.bind(host);
		const originalProjects = host.listTeamProjects.bind(host), originalRun = host.run.bind(host);
		const originalRepositories = host.listHubRepositories.bind(host);
		const owner = Object.assign(host, { listApprovalRequestsForProject: async (projectId: string, limit: number) => {
			const rows = await originalApprovals(projectId, limit);
			return rows.map(row => { assert.ok(row, 'Original approval projection must be readable'); return row; });
		}, listTeamProjects: async (teamId: string) => {
			const rows = await originalProjects(teamId);
			return rows.map(row => { assert.ok(row, 'Original project projection must be readable'); return row; });
		}, listHubRepositories: async (projectId: string) => {
			const rows = await originalRepositories(projectId);
			return rows.map(row => { assert.ok(row, 'Original repository projection must be readable'); return row; });
		}, run: async (sql: string, params: unknown[] = []) => { await originalRun(sql, params); } });
		const store = createCapacityControlPlane(owner);
		await f.query('UPDATE capacity_provider_availability_sessions SET execution_providers_json=? WHERE id=?',
			[JSON.stringify([{ id: f.attempt.provider.executionProviderId, runtimeBuild: f.attempt.provider.runtimeBuild,
				status: 'available', maxConcurrentRunners: 1, capabilities: f.attempt.requiredCapabilities,
				lanes: [{ id: 'workday', purpose: 'workday', maxConcurrentRunners: 1 }] }]), 'session']);
		const request = { providerSessionId: 'session', runnerId: 'dependent-runner', leaseSeconds: 30, laneId: 'workday', lanePurpose: 'workday' as const };
		const poll = (input = request, principal = f.principal) => store.leaseNextProviderAssignment(principal, input);
		const custody = async () => ({ attempt: (await f.repository.get(f.principal.teamId, f.attempt.id))?.assignmentAttempt,
			predecessors: (await f.repository.get(f.principal.teamId, f.attempt.id))?.workspaceContext.predecessorResults,
			reservations: (await f.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
			usage: (await f.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
			ledger: (await f.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows,
			edges: (await f.query('SELECT * FROM execution_edges ORDER BY id')).rows });
		const snapshot = async () => ({ ...await f.snapshot(), audit: (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows });
		// Fail the future test if setup consumed the ORIGINAL window; never skip,
		// extend/rewrite deadline, create a late fixture or use fake clocks.
		assert.ok(Date.now() < Date.parse(f.attempt.deadline), 'Original three-second poll authority elapsed during setup');
		return { ...f, store, host: owner, request, poll, custody, snapshot };
	} catch (error) { await f.db.close(); throw error; }
}
