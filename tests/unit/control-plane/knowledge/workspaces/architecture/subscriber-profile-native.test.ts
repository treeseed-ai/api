import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { serializeFrontmatterDocument } from '../../../../../../src/api/content/frontmatter.ts';
import { relationSchedulingDatabase } from './relation-scheduling-fixture.ts';
import { object } from './relation-authoring-fixture.ts';
import { snapshotAgentDefinitions } from '../../../../../../src/api/capacity/services/capacity/agents/agent-definition-snapshot.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { projectTreeDxCommitSignals } from '../../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts';
import { resolveWorkdayAgentProfileSnapshot, resolveDiscussionAgentProfileSnapshot } from '../../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { projectCommunicationInvocations } from '../../../../../../src/api/capacity/policy/execution/communication-execution-projector.ts';
import { effectiveProfile } from '../../../../../../src/api/capacity/services/build/execution-node-profile.ts';
import { ProjectAgentClassRepository } from '../../../../../../src/api/capacity/repositories/projects/agents/project-agent-class.ts';
import { recordTreeDxAuthoringState } from '../../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts';

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
		expect(object(JSON.parse(String(shared[0]!.handler_refs_json))).agents).toEqual(definitions);
		expect(object(JSON.parse(String(shared[0]!.metadata_json))).definitionPaths).toEqual(paths);
		const repository = new ProjectAgentClassRepository(f.store);
		const selected = await resolveWorkdayAgentProfileSnapshot({ listProjectAgentClassesPage: (id, page) =>
			repository.listPage(id, { ...page, cursor: null }) }, source.projectId, undefined, ['native-shared-team']);
		expect(selected.agents.map(entry => entry.definition.id)).toEqual(definitions.map(definition => definition.id));
		for (const definition of definitions) {
			const invocationId = `addressed-${definition.name}`, workdayId = `conversation-${definition.name}`;
			const discussion = { invocationId, discussionId: 'portfolio', messageId: 'request',
				messagePath: 'discussions/portfolio/messages/request.mdx', commitSha: commit };
			await f.query(`INSERT INTO agent_invocation_requests (id,team_id,project_id,project_agent_class_id,agent_id,agent_revision,
				execution_kind,status,execution_id,scope_hash,available_at,idempotency_key,request_digest,metadata_json,requested_at)
				VALUES (?,?,?,?,?,?,'conversation','admitted',?,'controlled-native-input',?,?,?,?,?)`,
				[invocationId, 'team', source.projectId, shared[0]!.id, definition.name, commit, workdayId,
					new Date().toISOString(), invocationId, invocationId, JSON.stringify({ discussionId: discussion.discussionId,
						sourceMessageId: discussion.messageId, sourceMessagePath: discussion.messagePath, sourceCommit: commit }), new Date().toISOString()]);
			const conversation = { id: workdayId, teamId: 'team', parameters: { agentSelection: { activityTypes: ['chat'] }, discussion } };
			const addressed = await resolveDiscussionAgentProfileSnapshot({ first: f.store.first.bind(f.store),
				listProjectAgentClassesPage: (id, page) => repository.listPage(id, { ...page, cursor: null }) }, conversation, source.projectId);
			expect(addressed.agents.map(entry => entry.definition.id)).toEqual([definition.id]);
			const profiles = Object.fromEntries(addressed.agents.map(entry => [`${source.projectId}:${entry.definition.id}`, entry.definition]));
			const projected = projectCommunicationInvocations({ teamId: 'team', revision: 1, profiles,
				sources: [{ id: invocationId, teamId: 'team', projectId: source.projectId,
					workdayId, agentId: definition.id, repository: source.repository,
					commit, path: 'discussions/portfolio/messages/request.mdx', durationSeconds: 120 }] });
			const bound = await effectiveProfile(f.store, projected.nodes[0]!);
			expect(bound.profile.profileRef).toMatchObject({ id: definition.id, commit, repository: source.repository });
			expect(bound.profile.prompt).toEqual(definition.activityProfiles.chat.prompt);
			for (const changed of [{ id: 'foreign-workday' }, { teamId: 'foreign-team' }, { parameters: {
				...conversation.parameters, discussion: { ...discussion, messageId: 'forged' } } }]) {
				await expect(resolveDiscussionAgentProfileSnapshot({ first: f.store.first.bind(f.store),
					listProjectAgentClassesPage: (id, page) => repository.listPage(id, { ...page, cursor: null }) },
					{ ...conversation, ...changed }, source.projectId)).rejects.toMatchObject({ code: 'capacity_workday_discussion_authority_invalid' });
			}
		}
		// Original exact history remains readable; repeated publication retains the
		// same complete class instead of replacing it with its last member.
		expect(await snapshotAgentDefinitions(connection, source.commit)).toEqual(baseline);
		await projectTreeDxCommitSignals(f.store, signal);
		const replayed = await f.store.all('SELECT * FROM project_agent_classes WHERE project_id=? AND slug=?', [source.projectId, 'maintenance']);
		expect(JSON.parse(String(replayed[0]!.handler_refs_json))).toEqual(JSON.parse(String(shared[0]!.handler_refs_json)));
		// A real private discussion branch starts before the newer published
		// subscriber profiles. Its integrated cursor must not roll those profiles
		// back when a human next authors and publishes only an objective.
		const historyPath = 'discussion-messages/cache-recovery/private.mdx';
		const history = object(await f.client.workspaces.create(source.repository, { baseRef: source.commit,
			branchName: `refs/heads/discussion-${randomUUID()}`, mode: 'writable', allowedPaths: [historyPath] }));
		let privateCommit: string;
		try {
			await f.client.files.write(String(history.workspaceId), { path: historyPath, content: 'Original private discussion context.\n' });
			privateCommit = String(object(await f.client.files.commit(String(history.workspaceId), {
				message: 'Earlier exact discussion source', author: { name: 'Fixture', email: 'fixture@example.invalid' } })).commitSha);
		} finally { await f.client.workspaces.close(String(history.workspaceId)); }
		await recordTreeDxAuthoringState(f.store, 'integrated', { projectId: source.projectId, repositoryId: source.repository,
			commitSha: privateCommit, ref: String(history.branchName), changedPaths: [historyPath], actorType: 'user', actorId: 'operator' });
		expect((await f.store.getProjectTreeDxLibrary(source.projectId))?.contentRepositoryRef).toBe(privateCommit);
		const ordinary = await f.service.create(f.principal, source.projectId, { requestId: randomUUID() });
		try {
			expect(ordinary.baseCommitSha).toBe(commit);
			for (const [index, definition] of definitions.entries())
				expect((await f.service.readContent(f.principal, ordinary.id, paths[index]!)).content)
					.toBe(serializeFrontmatterDocument(definition));
			const objective = serializeFrontmatterDocument({ schemaVersion: 'treeseed.objective/v1', id: 'cache-recovery',
				projectId: source.projectId, title: 'Diagnose retained source cleanup', outcome: 'Retain every current subscriber while adding the diagnostic objective.', status: 'active' });
			const written = await f.service.updateContent(f.principal, ordinary.id, { kind: 'operational-content', create: true,
				version: ordinary.version, sourcePath: 'objectives/cache-recovery.mdx', content: objective });
			expect((await f.service.diff(f.principal, ordinary.id)).changedPaths).toEqual(['objectives/cache-recovery.mdx']);
			const submitted = await f.service.submit(f.principal, ordinary.id, { version: written.workspace.version,
				message: 'Add objective without replacing published subscribers' });
			if (!submitted.integration) throw new Error('Ordinary objective publication operation required');
			expect(await f.run(submitted.integration.operation.id)).toMatchObject({ ok: true, operation: { status: 'succeeded' } });
			const observed = await resolveKnowledgeGatewayConnection(f.store, { projectId: source.projectId, write: false,
				readRefs: [submitted.commit.commitSha, privateCommit], workspacePaths: ['agents/**', historyPath, 'objectives/**'] });
			if (!observed) throw new Error('Native exact objective/profile readback required');
			for (const [index, definition] of definitions.entries()) {
				const file = await observed.client.readRepositoryFiles({ repoId: source.repository, ref: submitted.commit.commitSha,
					paths: [paths[index]!], encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
				expect(file.files[0]?.content).toBe(serializeFrontmatterDocument(definition));
			}
			const historyFile = await observed.client.readRepositoryFiles({ repoId: source.repository, ref: privateCommit,
				paths: [historyPath], encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
			expect(historyFile.files[0]?.content).toBe('Original private discussion context.\n');
			const retained = await resolveWorkdayAgentProfileSnapshot({ listProjectAgentClassesPage: (id, page) =>
				repository.listPage(id, { ...page, cursor: null }) }, source.projectId, undefined, ['native-shared-team']);
			expect(retained.agents.map(entry => entry.definition)).toEqual(definitions);
		} finally { await f.client.workspaces.close(ordinary.treeDxWorkspaceId); }
		// Actual native TreeDX, owning PostgreSQL, group discovery and exact profile
		// read-back. No agent/model execution, assignment or measured usage claimed.
	} finally { await f.close(); }
}, 60_000);
