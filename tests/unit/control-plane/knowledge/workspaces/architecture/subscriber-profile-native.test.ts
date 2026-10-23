import { expect, it } from 'vitest';
import { serializeFrontmatterDocument } from '../../../../../../src/api/content/frontmatter.ts';
import { relationSchedulingDatabase } from './relation-scheduling-fixture.ts';
import { object } from './relation-authoring-fixture.ts';
import { snapshotAgentDefinitions } from '../../../../../../src/api/capacity/services/capacity/agents/agent-definition-snapshot.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { projectTreeDxCommitSignals } from '../../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts';
import { resolveWorkdayAgentProfileSnapshot } from '../../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { projectCommunicationInvocations } from '../../../../../../src/api/capacity/policy/execution/communication-execution-projector.ts';
import { effectiveProfile } from '../../../../../../src/api/capacity/services/build/execution-node-profile.ts';
import { ProjectAgentClassRepository } from '../../../../../../src/api/capacity/repositories/projects/agents/project-agent-class.ts';

it('native governed shared-class subscribers retain both YAML profiles through publication group discovery and exact addressed execution binding', async () => {
	const f = await relationSchedulingDatabase();
	try {
		const source = f.sources.find(value => value.projectId === 'dependent');
		if (!source) throw new Error('Original managed project source required');
		const connection = await resolveKnowledgeGatewayConnection(f.store, { projectId: source.projectId,
			write: false, readRefs: [source.commit], workspacePaths: ['agents/**'] });
		if (!connection) throw new Error('Original managed project binding required');
		const baseline = await snapshotAgentDefinitions(connection, source.commit), original = baseline.files[0]!.definition;
		const profile = Object.values(original.activityProfiles)[0]!;
		const definitions = ['technical-writer', 'tester'].map(name => ({ ...original,
			id: `dependent/${name}`, name, agentClass: 'maintenance' as const, groupIds: ['native-shared-team'],
			activityProfiles: { chat: { ...profile, prompt: { system: `Answer the addressed request as ${name}.` } } },
		}));
		const paths = definitions.map(definition => `agents/${definition.name}.mdx`);
		const workspace = object(await f.client.workspaces.create(source.repository, { baseRef: source.commit,
			branchName: 'refs/heads/staging', mode: 'writable', allowedPaths: paths }));
		const workspaceId = String(workspace.workspaceId); let commit: string;
		try {
			for (const [index, definition] of definitions.entries()) await f.client.files.write(workspaceId,
				{ path: paths[index]!, content: serializeFrontmatterDocument(definition) });
			commit = String(object(await f.client.files.commit(workspaceId, { message: 'Controlled shared-class subscriber profiles',
				author: { name: 'Fixture', email: 'fixture@example.invalid' } })).commitSha);
		} finally { await f.client.workspaces.close(workspaceId); }
		expect(commit).toMatch(/^[a-f0-9]{40}$/u);
		const signal = { projectId: source.projectId, commitSha: commit, changedPaths: paths,
			changeSummary: 'Retain every configured subscriber.', actorType: 'user' as const };
		await projectTreeDxCommitSignals(f.store, signal);
		const classes = await f.store.all('SELECT * FROM project_agent_classes WHERE project_id=? ORDER BY id', [source.projectId]);
		const shared = classes.filter(row => row.slug === 'maintenance'); expect(shared).toHaveLength(1);
		expect(object(shared[0]!.handler_refs_json).agents).toEqual(definitions);
		expect(object(shared[0]!.metadata_json).definitionPaths).toEqual(paths);
		const repository = new ProjectAgentClassRepository(f.store);
		const selected = await resolveWorkdayAgentProfileSnapshot({ listProjectAgentClassesPage: (id, page) =>
			repository.listPage(id, { ...page, cursor: null }) }, source.projectId, undefined, ['native-shared-team']);
		expect(selected.agents.map(entry => entry.definition.id)).toEqual(definitions.map(definition => definition.id));
		const profiles = Object.fromEntries(selected.agents.map(entry => [`${source.projectId}:${entry.definition.id}`, entry.definition]));
		for (const definition of definitions) {
			const projected = projectCommunicationInvocations({ teamId: 'team', revision: 1, profiles,
				sources: [{ id: `addressed-${definition.name}`, teamId: 'team', projectId: source.projectId,
					workdayId: `conversation-${definition.name}`, agentId: definition.id, repository: source.repository,
					commit, path: 'discussions/portfolio/messages/request.mdx', durationSeconds: 120 }] });
			const bound = await effectiveProfile(f.store, projected.nodes[0]!);
			expect(bound.profile.profileRef).toMatchObject({ id: definition.id, commit, repository: source.repository });
			expect(bound.profile.prompt).toEqual(definition.activityProfiles.chat.prompt);
		}
		// Original exact history remains readable; repeated publication retains the
		// same complete class instead of replacing it with its last member.
		expect(await snapshotAgentDefinitions(connection, source.commit)).toEqual(baseline);
		await projectTreeDxCommitSignals(f.store, signal);
		const replayed = await f.store.all('SELECT * FROM project_agent_classes WHERE project_id=? AND slug=?', [source.projectId, 'maintenance']);
		expect(object(replayed[0]!.handler_refs_json)).toEqual(object(shared[0]!.handler_refs_json));
		// Actual native TreeDX, owning PostgreSQL, group discovery and exact profile
		// read-back. No agent/model execution, assignment or measured usage claimed.
	} finally { await f.close(); }
}, 60_000);
