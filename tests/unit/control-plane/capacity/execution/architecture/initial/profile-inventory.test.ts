import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { initialAdmission } from './initial-admission-fixture.ts';
import { ProjectAgentClassRepository } from '../../../../../../../src/api/capacity/repositories/projects/agents/project-agent-class.ts';
import { createAgentQueryService } from '../../../../../../../src/api/control-plane/repositories/capacity/agent-query-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';

function definition(index = 0) {
	return { schemaVersion: 'treeseed.agent/v1', id: `configured/portable-${index}`, name: `Portable ${index}`, agentClass: `portable-${index}`,
		purpose: 'Execute governed task code without a named runtime role.', responsibilities: ['Retain exact immutable assignment scope.'],
		capabilities: ['code-change'], context: { include: ['assignment-subject'] }, activityProfiles: { acting: {
			handler: 'configured/native-project-handler', prompt: { system: 'Complete only the authorized task using the governed configured prompt.' },
			parameters: { temperature: 0.25 }, permissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] } } } };
}
async function inventory() {
	const f = await initialAdmission(); try {
		const initial = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['projects', 'project_agent_classes']) {
			const ddl = initial.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`)); if (ddl.length !== 1) throw new Error(`Missing original ${table}`);
			await f.db.exec(ddl[0]!);
		}
		const now = f.attempt.createdAt; await f.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at)
			VALUES ('project','team','project','Project',?,?)`, [now, now]);
		const repository = new ProjectAgentClassRepository(f.owner);
		const store = { ...f.owner,
			getProjectDetails: async (id: string) => ({ project: (await f.query('SELECT id,team_id AS "teamId" FROM projects WHERE id=?', [id])).rows[0] ?? null }),
			listProjectAgentClassesPage: (projectId: string, page: Parameters<typeof repository.listPage>[1]) => repository.listPage(projectId, page),
			getProjectAgentsSummary: async (projectId: string) => ({ projectId, agents: [] }),
		};
		const seed = async (index = 0, value: unknown = definition(index)) => {
			await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
				VALUES (?,'team','project',?,?,?,?,?,?)`, [`class-${String(index).padStart(3, '0')}`, `portable-${index}`, `Portable ${index}`,
				JSON.stringify({ agents: [value] }), JSON.stringify({ immutableRef: 'a'.repeat(40) }), now, now]);
		};
		return { ...f, repository, seed, service: createAgentQueryService(store), principal: { id: 'operator', roles: ['admin'] },
			inventorySnapshot: async () => (await f.query('SELECT * FROM project_agent_classes ORDER BY id')).rows };
	} catch (error) { await f.db.close(); throw error; }
}
describe('actual owning profile inventory and public query', () => {
	it('reads arbitrary complete stored profiles and compiled-handler selections through owning SQL without runtime role configuration', async () => {
		const f = await inventory(); try {
			await f.seed(); const before = await f.inventorySnapshot(), response = await f.service.show(f.principal, 'project', 'portable-0');
			expect(response.agent.definition).toEqual(definition()); expect(validateAgentDefinitionModel(response.agent.definition).ok).toBe(true);
			expect(response.agent.effectiveActivities.acting).toMatchObject({ handler: 'configured/native-project-handler', origin: 'project-runtime' });
			expect(response.agent.definition.activityProfiles.acting.parameters).toEqual({ temperature: 0.25 });
			expect(await f.service.handler(f.principal, 'project', 'configured/native-project-handler')).toMatchObject({ projectId: 'project', handler: { id: 'configured/native-project-handler', origin: 'project-runtime' } });
			await f.service.list(f.principal, 'project'); expect(await f.inventorySnapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('public profile inventory includes the last class after the original two hundred row page rather than silently hiding governed agents', async () => {
		const f = await inventory(); try {
			for (let index = 0; index < 201; index++) await f.seed(index);
			const before = await f.inventorySnapshot(), result = await f.service.list(f.principal, 'project');
			expect(result.agents).toHaveLength(201); expect(new Set(result.agents.map(agent => agent.definition.id)).size).toBe(201);
			expect((await f.service.show(f.principal, 'project', 'portable-200')).agent.definition).toEqual(definition(200));
			expect(await f.inventorySnapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('denies malformed duplicate and forbidden stored profile authority instead of returning a partial successful inventory', async () => {
		const outcomes = [];
		for (const mutation of ['malformed', 'forbidden', 'duplicate']) {
			const f = await inventory(); try {
				await f.seed(0); await f.seed(1, mutation === 'malformed' ? {} : mutation === 'forbidden' ? { ...definition(1), credentials: {} } : definition(0));
				const before = await f.inventorySnapshot(); outcomes.push(await f.service.list(f.principal, 'project').then(() => 'admitted', () => 'denied'));
				expect(await f.inventorySnapshot()).toEqual(before);
			} finally { await f.db.close(); }
		}
		expect(outcomes).toEqual(['denied', 'denied', 'denied']);
	});
	it('public profile query denies missing principal missing project and unknown compiled handler without SQL mutation', async () => {
		const f = await inventory(); try {
			await f.seed(); const before = await f.inventorySnapshot();
			await expect(f.service.show(undefined, 'project', 'portable-0')).rejects.toMatchObject({ status: 401 });
			await expect(f.service.show(f.principal, 'foreign-project', 'portable-0')).rejects.toMatchObject({ status: 404 });
			await expect(f.service.handler(f.principal, 'project', 'configured/uncompiled')).rejects.toMatchObject({ status: 404 });
			expect(await f.inventorySnapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
});
