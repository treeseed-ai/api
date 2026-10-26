import { describe, expect, it } from 'vitest';
import { resolveTeamCommunicationTargets } from '../../../../../../src/api/capacity/services/capacity/invocations/communication-target-resolution.ts';
import { admitDiscussionInvocations } from '../../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';
import { postgresGraph } from '../../execution/graph/architecture/living/living-postgres-fixture.ts';

describe('group and shared-name audience from persisted project agents', () => {
	it('resolves exact group members and shared names from real PostgreSQL without changing inventory', async () => {
		const f = await postgresGraph();
		try {
			const at = '2026-10-23T00:00:00Z';
			for (const project of ['api', 'agent']) {
				await f.left.pool.query('INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ($1,\'team\',$1,$1,$2,$2)', [project, at]);
				for (const [name, allocation] of [['tester', 'quality'], ['technical-writer', 'documentation']]) {
					const definition = { schemaVersion: 'treeseed.agent/v1', id: `${project}/${name}`, name, agentClass: allocation,
						groupIds: ['source-recovery'], purpose: 'Contribute to the accepted runtime repair.', responsibilities: ['Preserve exact evidence.'],
						capabilities: ['discussion'], context: { include: ['assignment-subject'] }, activityProfiles: { chat: { handler: 'writer',
							permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'] },
							prompt: { system: 'Discuss the exact accepted runtime boundary.' } } } };
					await f.left.pool.query('INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at) VALUES ($1,\'team\',$2,$3,$3,$4,$5,$5)',
						[`${project}-${name}`, project, allocation, JSON.stringify({ agents: [definition] }), at]);
				}
			}
			const before = (await f.left.pool.query('SELECT * FROM project_agent_classes ORDER BY id')).rows;
			const store = { ...f.stores[0], listTeamProjects: (teamId: string) => f.stores[0]!.all('SELECT * FROM projects WHERE team_id=? ORDER BY id', [teamId]) };
			const targets = await resolveTeamCommunicationTargets(store, 'team', [
				{ projectSlug: null, agentSlug: 'source-recovery', requirement: 'optional', address: '@source-recovery' },
				{ projectSlug: 'api', agentSlug: 'tester', requirement: 'required', address: '@api/tester' },
			]);
			expect(targets).toEqual(['agent', 'api'].flatMap(project => ['technical-writer', 'tester'].map(agentSlug => ({
				projectId: project, projectSlug: project, agentSlug, requirement: project === 'api' && agentSlug === 'tester' ? 'required' : 'optional',
			}))));
			expect(await resolveTeamCommunicationTargets(store, 'team', [{ projectSlug: null, agentSlug: 'tester', requirement: 'required', address: '@tester' }]))
				.toEqual(['agent', 'api'].map(project => ({ projectId: project, projectSlug: project, agentSlug: 'tester', requirement: 'required' })));
			expect((await f.left.pool.query('SELECT * FROM project_agent_classes ORDER BY id')).rows).toEqual(before);
			await expect(resolveTeamCommunicationTargets(store, 'team', [{ projectSlug: null, agentSlug: 'absent-group', requirement: 'required', address: '@absent-group' }]))
				.rejects.toMatchObject({ status: 404, code: 'communication_agent_not_found' });
			const snapshots = async () => Promise.all(['agent_invocation_requests', 'capacity_provider_assignments', 'capacity_ledger_entries']
				.map(table => f.stores[0]!.all(`SELECT * FROM ${table} ORDER BY id`)));
			const original = await snapshots();
			await expect(admitDiscussionInvocations(store as never, { teamId: 'team', projectId: 'api', projectSlug: 'api',
				discussionId: 'context-recovery', messageId: 'message', messagePath: 'discussion-messages/context-recovery/message.mdx',
				messageCommit: 'c'.repeat(40), contextRefs: [], agentSlugs: ['technical-writer', 'unsupported'],
				idempotencyKey: 'partial-group-regression', durationSeconds: 180 }))
				.rejects.toMatchObject({ code: 'discussion_agent_chat_profile_missing', details: { agentSlug: 'unsupported' } });
			expect(await snapshots()).toEqual(original);
			expect((await f.left.pool.query('SELECT * FROM project_agent_classes ORDER BY id')).rows).toEqual(before);
		} finally { await f.close(); }
	}, 30_000);
});
