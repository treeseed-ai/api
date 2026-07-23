import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MarketPostgresDatabase } from '../../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../../src/api/store.js';
import { ProjectAgentClassService } from '../../../src/api/capacity/services/project-agent-class-service.ts';
import { installProjectAgentOperatorRoutes } from '../../../src/api/capacity/routes/project-agent-operator.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market')) ? resolve(packageRoot, '../sdk/drizzle/market') : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = new MarketControlPlaneStore({ repoRoot: packageRoot }, database);
	return { database, store, service: new ProjectAgentClassService(store) };
}

async function seed(store: MarketControlPlaneStore) {
	const now = new Date().toISOString();
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-b', 'team-a', 'project-b', 'Project B', ?, ?)`, [now, now]);
}

describe('project agent class service', () => {
	it('creates and updates one project-owned class without replace semantics', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			const created = await service.create('project-a', { id: 'class-a', slug: 'engineer', name: 'Engineer', allowedModes: ['planning'], requiredCapabilities: ['engineering'] }, 'create-class-a');
			expect(created).toMatchObject({ id: 'class-a', teamId: 'team-a', projectId: 'project-a', status: 'active', allowedModes: ['planning'] });
			const updated = await service.update('project-a', 'class-a', { status: 'paused', allowedModes: ['acting'] }, 'update-class-a');
			expect(updated).toMatchObject({ id: 'class-a', slug: 'engineer', status: 'paused', allowedModes: ['acting'] });
			expect((await store.all(`SELECT id, team_id, project_id FROM project_agent_classes`))).toEqual([{ id: 'class-a', team_id: 'team-a', project_id: 'project-a' }]);
		} finally { await database.close(); }
	});

	it('rejects invalid modes/status and conflicting slugs before mutation', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			await service.create('project-a', { id: 'class-a', slug: 'engineer' }, 'create-valid');
			await expect(service.create('project-a', { id: 'class-b', slug: 'engineer' }, 'create-conflict')).rejects.toMatchObject({ code: 'project_agent_class_conflict' });
			await expect(service.update('project-a', 'class-a', { status: 'unknown' }, 'update-status-invalid')).rejects.toMatchObject({ code: 'project_agent_class_status_invalid' });
			await expect(service.update('project-a', 'class-a', { allowedModes: ['testing'] }, 'update-modes-invalid')).rejects.toMatchObject({ code: 'project_agent_class_modes_invalid' });
			await expect(service.update('project-a', 'class-a', { handlerRefs: { agents: [{ slug: 'engineer', handler: 'actor' }] } }, 'update-refs-invalid'))
				.rejects.toMatchObject({ code: 'project_agent_activity_refs_invalid' });
			expect(await service.get('project-a', 'class-a')).toMatchObject({ status: 'active', allowedModes: ['planning', 'acting'] });
		} finally { await database.close(); }
	});

	it('reports a stable conflict when another project owns a requested global id', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			await service.create('project-a', { id: 'architecture', slug: 'architecture' }, 'create-architecture-a');
			await expect(service.create('project-b', { id: 'architecture', slug: 'architecture' }, 'create-architecture-conflict')).rejects.toMatchObject({
				code: 'project_agent_class_conflict',
				status: 409,
				details: { idOwnerProjectId: 'project-a' },
			});
			await expect(service.create('project-b', { id: 'project-b:architecture', slug: 'architecture' }, 'create-architecture-b')).resolves.toMatchObject({
				id: 'project-b:architecture',
				projectId: 'project-b',
			});
		} finally { await database.close(); }
	});

	it('fails closed on malformed durable class policy JSON', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			const now = new Date().toISOString();
			await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, allowed_modes_json, created_at, updated_at) VALUES ('class-corrupt', 'team-a', 'project-a', 'corrupt', 'Corrupt', '{', ?, ?)`, [now, now]);
			await expect(service.get('project-a', 'class-corrupt')).rejects.toMatchObject({ code: 'capacity_durable_json_invalid' });
		} finally { await database.close(); }
	});

	it('durably replays create and update and rejects conflicting key reuse', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			const input = { id: 'class-replay', slug: 'reviewer', allowedModes: ['planning'] };
			const [created, concurrentReplay] = await Promise.all([
				service.create('project-a', input, 'stable-class-create'),
				service.create('project-a', input, 'stable-class-create'),
			]);
			expect(concurrentReplay).toEqual(created);
			const restartedService = new ProjectAgentClassService(store);
			expect(await restartedService.create('project-a', input, 'stable-class-create')).toEqual(created);
			await expect(service.create('project-a', { ...input, id: 'class-other' }, 'stable-class-create'))
				.rejects.toMatchObject({ code: 'capacity_idempotency_key_conflict' });
			const updated = await service.update('project-a', 'class-replay', { status: 'paused' }, 'stable-class-update');
			expect(await restartedService.update('project-a', 'class-replay', { status: 'paused' }, 'stable-class-update')).toEqual(updated);
			expect(await store.all('SELECT id FROM project_agent_classes')).toHaveLength(1);
			expect(await store.all('SELECT id FROM capacity_operation_receipts')).toHaveLength(2);
		} finally { await database.close(); }
	});

	it('serves create, get, and update through the single project-agent route owner', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const app = new Hono();
			installProjectAgentOperatorRoutes(app, { store, async requireProjectAccess() { return {}; } });
			const missingKey = await app.request('/v1/projects/project-a/agent-classes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'missing-key', slug: 'missing-key' }) });
			expect(missingKey.status).toBe(400);
			expect(await missingKey.json()).toMatchObject({ code: 'capacity_idempotency_key_required' });
			const created = await app.request('/v1/projects/project-a/agent-classes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'route-create' }, body: JSON.stringify({ id: 'class-route', slug: 'reviewer', allowedModes: ['planning'] }) });
			expect(created.status).toBe(201);
			expect(await created.json()).toMatchObject({ payload: { id: 'class-route', status: 'active' } });
			const updated = await app.request('/v1/projects/project-a/agent-classes/class-route', { method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': 'route-update' }, body: JSON.stringify({ status: 'paused' }) });
			expect(updated.status).toBe(200);
			expect(await updated.json()).toMatchObject({ payload: { id: 'class-route', status: 'paused' } });
			const read = await app.request('/v1/projects/project-a/agent-classes/class-route');
			expect(read.status).toBe(200);
			expect(await read.json()).toMatchObject({ payload: { id: 'class-route', status: 'paused' } });
		} finally { await database.close(); }
	});
});
