import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';
import { createCapacityControlPlane } from '../../../src/api/capacity/control-plane.ts';
import { CapacityWorkdayDemandRepository } from '../../../src/api/capacity/repositories/capacity/workdays/workday-demand.ts';
import { assignNextCompiledDemand } from '../../../src/api/capacity/services/capacity/assignments/planning/assignment-function.ts';
import { compileProviderWorkdayDemand } from '../../../src/api/capacity/services/build/demand-compiler.ts';
import { MarketPostgresDatabase } from '../../../src/api/support/market-postgres.ts';
import { MarketControlPlaneStore } from '../../../src/api/persistence/store.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
const now = '2026-07-18T12:00:00.000Z';
const openDatabases: MarketPostgresDatabase[] = [];

async function harness() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	openDatabases.push(database);
	const store = new MarketControlPlaneStore({
		repoRoot: packageRoot,
		authSecret: 'synthesis-test-auth-secret',
		assertionSecret: 'synthesis-test-assertion-secret',
		serviceId: 'web',
		serviceSecret: 'synthesis-test-service-secret',
	}, database);
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, allowed_modes_json, handler_refs_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'planner', 'Planner', '["planning"]', ?, ?, ?)`, [
		JSON.stringify({ agents: [{ slug: 'architect', activities: { planning: { handler: 'writer', purpose: 'Plan the architecture.' } } }] }),
		now,
		now,
	]);
	await store.run(`INSERT INTO capacity_workday_runs (id, team_id, capacity_provider_id, scenario_id, status, environment, parameters_json, started_at, created_at, updated_at) VALUES ('run-a', 'team-a', 'provider-a', 'planning', 'running', 'local', '{"projects":["project-a"]}', ?, ?, ?)`, [now, now, now]);
	await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, workday_run_id, status, envelope_json, metadata_json, started_at, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'run-a', 'active', '{"availableCredits":10}', '{}', ?, ?, ?)`, [now, now, now]);
	await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner', '{}', ?, ?)`, [now, now, now]);
	return store;
}

afterEach(async () => {
	await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

describe('capacity assignment synthesis fail-closed guarantees', () => {
	it('records durable pre-admission denial evidence without writing a nonexistent assignment explanation', async () => {
		const store = await harness();
		await new CapacityWorkdayDemandRepository(store).create({
			id: 'demand-a',
			teamId: 'team-a',
			projectId: 'project-a',
			workdayRunId: 'run-a',
			workdayId: 'workday-a',
			sourceType: 'idle-intent',
			sourceId: 'architect',
			mode: 'planning',
			projectAgentClassId: 'class-a',
			agentId: 'architect',
			handlerId: 'writer',
			activityType: 'planning',
			priority: 1,
			requestedCredits: 1,
			idempotencyKey: 'demand-a',
			payload: { repositoryId: 'treeseed-project-a', contentRoot: 'src/content' },
			metadata: { environment: 'local' },
			availableAt: now,
			now,
		});
		const principal = { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' };
		await expect(assignNextCompiledDemand(createCapacityControlPlane(store), principal, 'session-a', [], now)).resolves.toBeNull();
		expect(await store.all(`SELECT id FROM capacity_provider_assignments`)).toEqual([]);
		expect(await store.first(`SELECT action, resource_id, metadata_json FROM capacity_audit_events WHERE resource_id = 'demand-a'`)).toEqual({
			action: 'assignment-function.denied',
			resource_id: 'demand-a',
			metadata_json: JSON.stringify({ reasons: ['capacity_execution_provider_unavailable'] }),
		});
	});

	it('fails closed for corrupt workday source state before assignment synthesis', async () => {
		const store = await harness();
		await store.run(`UPDATE capacity_workday_runs SET parameters_json = '{"deadlineAt":"not-a-date"}' WHERE id = 'run-a'`);
		await expect(compileProviderWorkdayDemand(createCapacityControlPlane(store), {
			membershipId: 'membership-a',
			teamId: 'team-a',
			capacityProviderId: 'provider-a',
		}, now)).rejects.toMatchObject({ code: 'capacity_workday_synthesis_parameter_invalid' });
		expect(await store.all(`SELECT id FROM capacity_workday_demands`)).toEqual([]);
	});

	it('fails closed instead of silently truncating active runs or omitting requested projects', async () => {
		const store = await harness();
		await store.run(`UPDATE capacity_workday_runs SET parameters_json = '{"projects":["project-a","missing-project"]}' WHERE id = 'run-a'`);
		await expect(compileProviderWorkdayDemand(createCapacityControlPlane(store), {
			membershipId: 'membership-a',
			teamId: 'team-a',
			capacityProviderId: 'provider-a',
		}, now)).rejects.toMatchObject({
			code: 'capacity_workday_project_missing',
			details: { missing: ['missing-project'] },
		});
		expect(await store.all(`SELECT id FROM capacity_workday_demands`)).toEqual([]);
	});
});
