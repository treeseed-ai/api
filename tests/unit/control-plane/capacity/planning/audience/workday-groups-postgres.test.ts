import { describe, expect, it } from 'vitest';
import { ProjectAgentClassRepository } from '../../../../../../src/api/capacity/repositories/projects/agents/project-agent-class.ts';
import { resolveWorkdayAgentProfileSnapshot } from '../../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { postgresGraph } from '../../execution/graph/architecture/living/living-postgres-fixture.ts';
import { normalizeWorkdayAgentSelection } from '../../../../../../src/api/capacity/policy/workdays/workday.ts';

describe('group workday audience through native PostgreSQL class inventory', () => {
	it('retains all subscribed identities and excludes outside reporting while refusing identity targeting', async () => {
		const f = await postgresGraph();
		try {
			const at = '2026-10-23T12:00:00Z';
			await f.left.pool.query("INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('agent','team','agent','Agent',$1,$1)", [at]);
			const repository = new ProjectAgentClassRepository({ ...f.stores[0]!, ensureInitialized: () => f.left.migrate() });
			const definitions = [
				{ name: 'technical-writer', agentClass: 'maintenance', group: 'provider-runtime', activity: 'planning', handler: 'writer' },
				{ name: 'tester', agentClass: 'maintenance', group: 'provider-runtime', activity: 'planning', handler: 'writer' },
				{ name: 'reporter', agentClass: 'reporting', group: 'another-project', activity: 'reporting', handler: 'reporter' },
			];
			for (const [index, allocation] of [...new Set(definitions.map(input => input.agentClass))].entries()) await repository.create({
				id: `class-${index}`, teamId: 'team', projectId: 'agent', slug: allocation, name: allocation, status: 'active',
				handlerRefs: { agents: definitions.filter(input => input.agentClass === allocation).map(input => ({ schemaVersion: 'treeseed.agent/v1', id: `agent/${input.name}`, name: input.name,
					agentClass: input.agentClass, groupIds: [input.group], purpose: 'Contribute to the accepted provider runtime repair.',
					responsibilities: ['Preserve the exact assigned source and scope.'], capabilities: ['source-repair'],
					context: { include: ['assignment-subject'] }, activityProfiles: { [input.activity]: { handler: input.handler,
						permissions: { content: { read: ['proposal'], write: ['note'] }, tools: [] },
						prompt: { system: 'Plan the meaningful accepted provider runtime repair.' } } } })) },
				metadata: {}, createdAt: at, updatedAt: at,
			});
			const allocation = await repository.get('agent', 'class-0');
			if (!allocation) throw new Error('Original allocation class missing');
			await repository.update({ ...allocation, status: 'paused' });
			const before = (await f.left.pool.query('SELECT * FROM project_agent_classes ORDER BY id')).rows;
			const store = { listProjectAgentClassesPage: (id: string, page: { limit: number }) => repository.listPage(id, { ...page, cursor: null }) };
			const selected = await resolveWorkdayAgentProfileSnapshot(store, 'agent', { activityTypes: ['planning'] }, ['provider-runtime']);
			expect(selected.agents.map(entry => [entry.definition.id, entry.definition.agentClass, entry.activities])).toEqual([
				['agent/technical-writer', 'maintenance', ['planning']], ['agent/tester', 'maintenance', ['planning']],
			]);
			expect(await resolveWorkdayAgentProfileSnapshot(store, 'agent', normalizeWorkdayAgentSelection(undefined), ['provider-runtime']))
				.toEqual(selected);
			for (const field of ['agentSlugs', 'classIds', 'classSlugs']) await expect(resolveWorkdayAgentProfileSnapshot(store, 'agent',
				{ activityTypes: ['planning'], [field]: ['tester'] }, ['provider-runtime']))
				.rejects.toMatchObject({ code: 'capacity_workday_agent_selection_invalid' });
			expect((await f.left.pool.query('SELECT * FROM project_agent_classes ORDER BY id')).rows).toEqual(before);
			await expect(resolveWorkdayAgentProfileSnapshot(store, 'agent', { activityTypes: ['planning'] }, ['missing-group']))
				.rejects.toMatchObject({ code: 'capacity_workday_agent_selection_unknown' });
		} finally { await f.close(); }
	});
});
