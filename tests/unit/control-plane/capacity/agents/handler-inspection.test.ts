import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { encodeCapacityPageCursor, type CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { createAgentQueryService } from '../../../../../src/api/control-plane/repositories/capacity/agent-query-service.ts';
import { createAgentOperations } from '../../../../../src/api/control-plane/catalog/capacity/agents.ts';
import { OperationRegistry } from '../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { workdayStartDatabase } from '../workdays/scheduling/architecture/workday-start-fixture.ts';

function definition(handler: string, id = 'configured/renamed-reader') {
	const checked = validateAgentDefinitionModel(parse(`
schemaVersion: treeseed.agent/v1
id: ${id}
name: Renamed configured reader
agentClass: boundary-reader
purpose: Inspect only the granted subject.
responsibilities: [Preserve exact read authority.]
capabilities: [reading]
context: { include: [assignment-subject] }
activityProfiles:
  planning:
    handler: ${handler}
    prompt: { system: Read the exact governed subject without executing it. }
    additionalContext: [predecessor-results]
    permissions: { content: { read: [knowledge], write: [] }, tools: [] }
`));
	if (!checked.ok || !checked.data) throw new Error(JSON.stringify(checked.diagnostics));
	return checked.data;
}
function fixture() {
	const definitions = [definition('writer'), definition('configured/reader', 'configured/another-reader')];
	const classes = definitions.map((agent, index) => ({ id: `class-${index}`, slug: agent.agentClass, status: 'active',
		handlerRefs: { agents: [agent] }, metadata: { immutableRef: `source-${index}` } }));
	const reads: unknown[] = []; let access = true, permissions = ['projects:read:team'];
	const store = {
		getProjectDetails: async (projectId: string) => { reads.push(['project', projectId]); return projectId === 'project' ? { project: { teamId: 'team' } } : null; },
		principalCanAccessTeam: async () => access,
		getTeamAccessSummary: async () => ({ permissions }),
		listProjectAgentClassesPage: async (projectId: string, page: unknown) => { reads.push(['classes', projectId, page]); return { items: classes, page: { hasMore: false, nextCursor: null } }; },
	};
	return { definitions, classes, reads, store, service: createAgentQueryService(store),
		denyTeam() { access = false; }, denyPermission() { permissions = []; } };
}
describe('public configured handler inspection', () => {
	it('inspects exact renamed YAML handler origins prompts context and permissions without deriving execution authority', async () => {
		const f = fixture(), before = structuredClone({ definitions: f.definitions, classes: f.classes });
		const principal = { id: 'reader' };
		expect(await f.service.handlers(principal, 'project')).toEqual({ projectId: 'project', handlers: [
			{ id: 'writer', origin: 'agent-package' }, { id: 'configured/reader', origin: 'project-runtime' },
		] });
		for (const [index, handler] of ['writer', 'configured/reader'].entries()) {
			expect(await f.service.handler(principal, 'project', handler)).toEqual({ projectId: 'project', handler: {
				id: handler, origin: index === 0 ? 'agent-package' : 'project-runtime' } });
			const agent = (await f.service.show(principal, 'project', f.definitions[index]!.id.split('/').at(-1)!)).agent;
			expect(agent.definition).toEqual(f.definitions[index]);
			expect(agent.effectiveActivities.planning).toEqual({ handler, origin: index === 0 ? 'agent-package' : 'project-runtime',
				prompt: f.definitions[index]!.activityProfiles.planning!.prompt, context: ['assignment-subject', 'predecessor-results'],
				permissions: f.definitions[index]!.activityProfiles.planning!.permissions, dependsOn: null });
		}
		expect({ definitions: f.definitions, classes: f.classes }).toEqual(before);
	});
	it('denies missing project principal team permission and unknown handler inspection without reading or rewriting configured authority', async () => {
		for (const failure of ['project', 'principal', 'team', 'permission', 'handler'] as const) {
			const f = fixture(), before = structuredClone(f.classes);
			if (failure === 'team') f.denyTeam(); if (failure === 'permission') f.denyPermission();
			await expect(f.service.handler(failure === 'principal' ? undefined : { id: 'reader' }, failure === 'project' ? 'foreign' : 'project',
				failure === 'handler' ? 'unregistered/handler' : 'writer')).rejects.toMatchObject({
				status: failure === 'project' || failure === 'handler' ? 404 : failure === 'principal' ? 401 : 403,
				code: ({ project: 'project_not_found', principal: 'authentication_required', team: 'team_access_denied',
					permission: 'capacity_permission_denied', handler: 'agent_handler_not_found' })[failure],
			});
			expect(f.reads.filter(value => Array.isArray(value) && value[0] === 'classes')).toHaveLength(failure === 'handler' ? 1 : 0);
			expect(f.classes).toEqual(before);
		}
	});
	it('includes handlers from every original class page and refuses a missing tail instead of presenting partial inspection as complete', async () => {
		const f = fixture(), first = f.classes[0]!, tail = f.classes[1]!, reads: unknown[] = [];
		const cursor = { createdAt: '2026-10-04T00:00:00.000Z', id: first.id };
		const pages = [{ items: [first], page: { hasMore: true, nextCursor: encodeCapacityPageCursor(cursor) } },
			{ items: [tail], page: { hasMore: false, nextCursor: null } }];
		const service = createAgentQueryService({ ...f.store, listProjectAgentClassesPage: async (_project: string, query: { cursor?: CapacityPageCursor | null }) => {
			reads.push(structuredClone(query)); return query.cursor?.id === cursor.id ? pages[1] : pages[0];
		} });
		const before = structuredClone(pages);
		expect(await service.handlers({ id: 'reader' }, 'project')).toEqual({ projectId: 'project', handlers: [
			{ id: 'writer', origin: 'agent-package' }, { id: 'configured/reader', origin: 'project-runtime' },
		] });
		expect(reads).toEqual([{ limit: 200, cursor: null }, { limit: 200, cursor }]);
		const cause = new Error('Original class tail is unavailable');
		const denied = createAgentQueryService({ ...f.store, listProjectAgentClassesPage: async (_project: string, query: { cursor?: CapacityPageCursor | null }) => {
			if (query.cursor) throw cause; return pages[0];
		} });
		await expect(denied.handlers({ id: 'reader' }, 'project')).rejects.toBe(cause);
		for (const invalid of [undefined, {}, { items: [], page: { hasMore: 'true', nextCursor: null } },
			{ items: {}, page: { hasMore: false, nextCursor: null } },
			{ items: [tail], page: { hasMore: true, nextCursor: null } },
			{ items: [tail], page: { hasMore: true, nextCursor: 'not-a-cursor' } },
			{ items: [tail], page: { hasMore: true, nextCursor: pages[0]!.page.nextCursor } },
			{ items: [tail], page: { hasMore: false, nextCursor: pages[0]!.page.nextCursor } }]) {
			const beforeInvalid = structuredClone(invalid);
			const incomplete = createAgentQueryService({ ...f.store, listProjectAgentClassesPage: async (_project: string, query: { cursor?: CapacityPageCursor | null }) =>
				query.cursor ? invalid : pages[0] });
			await expect(incomplete.handlers({ id: 'reader' }, 'project')).rejects.toMatchObject({ status: 409, code: 'agent_class_inventory_invalid' });
			expect(invalid).toEqual(beforeInvalid);
		}
		expect(await service.handlers({ id: 'reader' }, 'project')).toEqual({ projectId: 'project', handlers: [
			{ id: 'writer', origin: 'agent-package' }, { id: 'configured/reader', origin: 'project-runtime' },
		] });
		expect(pages).toEqual(before);
	});
	it('native public operation inspection reads persisted renamed handlers and preserves every represented execution and profile row through denial and retry', async () => {
		const f = await workdayStartDatabase();
		try {
			const custom = structuredClone(f.definition); custom.id = 'configured/renamed-reader'; custom.activityProfiles.planning!.handler = 'configured/reader';
			const agents = [f.definition, custom];
			await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?', [JSON.stringify({ agents }), 'class']);
			const registry = new OperationRegistry(createAgentOperations({ agents: createAgentQueryService(f.store) }));
			const context = { interface: 'rest' as const, requestId: 'native-inspection', principal: f.principal };
			const state = async () => ({ execution: await f.snapshot(), classes: await f.all('SELECT * FROM project_agent_classes ORDER BY id'),
				projects: await f.all('SELECT * FROM projects ORDER BY id') });
			const before = await state(), input = { path: { projectId: 'project' }, query: {}, body: undefined }, frozen = structuredClone(input);
			const expected = { projectId: 'project', handlers: [{ id: 'writer', origin: 'agent-package' }, { id: 'configured/reader', origin: 'project-runtime' }] };
			const list = registry.require('agents.handlers.list'), show = registry.require('agents.handlers.show');
			expect(await list.handler(input, context)).toEqual(expected);
			for (const handler of expected.handlers) expect(await show.handler({ ...input, path: { projectId: 'project', handlerId: handler.id } }, context))
				.toEqual({ projectId: 'project', handler });
			await expect(show.handler({ ...input, path: { projectId: 'project', handlerId: 'unregistered/handler' } }, context))
				.rejects.toMatchObject({ status: 404, code: 'agent_handler_not_found' });
			await expect(list.handler(input, { ...context, principal: undefined })).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
			await expect(list.handler({ ...input, path: { projectId: 'foreign' } }, context)).rejects.toMatchObject({ status: 404, code: 'project_not_found' });
			expect(await Promise.all([list.handler(input, context), list.handler(input, context)])).toEqual([expected, expected]);
			expect(await state()).toEqual(before); expect(f.calls).toEqual([]); expect(input).toEqual(frozen); expect(agents).toEqual([f.definition, custom]);
		} finally { await f.close(); }
	});
	it('native original SQL pagination exposes the handler beyond two hundred classes without creating execution or replacing persisted profiles', async () => {
		const f = await workdayStartDatabase();
		try {
			await f.query('DELETE FROM project_agent_classes WHERE id=?', ['class']);
			const now = f.intent.startsAt, tail = structuredClone(f.definition); tail.id = 'configured/tail-reader'; tail.activityProfiles.planning!.handler = 'configured/tail-reader';
			for (let index = 0; index < 201; index++) {
				const agent = structuredClone(index === 200 ? tail : f.definition);
				if (index !== 200) agent.id = `configured/native-reader-${index}`;
				await f.query(`INSERT INTO project_agent_classes
				(id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
				[`class-${String(index).padStart(3, '0')}`, 'team', 'project', `class-${index}`, `Class ${index}`,
					JSON.stringify({ agents: [agent] }), now, now]);
			}
			const before = { execution: await f.snapshot(), classes: await f.all('SELECT * FROM project_agent_classes ORDER BY id') };
			const service = createAgentQueryService(f.store), expected = { projectId: 'project', handlers: [
				{ id: 'writer', origin: 'agent-package' }, { id: 'configured/tail-reader', origin: 'project-runtime' }] };
			expect(await service.handlers(f.principal, 'project')).toEqual(expected);
			expect(await service.handler(f.principal, 'project', 'configured/tail-reader')).toEqual({ projectId: 'project', handler: expected.handlers[1] });
			expect({ execution: await f.snapshot(), classes: await f.all('SELECT * FROM project_agent_classes ORDER BY id') }).toEqual(before);
			expect(f.calls).toEqual([]);
		} finally { await f.close(); }
	});
});
