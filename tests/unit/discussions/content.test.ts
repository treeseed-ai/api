import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';

const { applyChangeset, commit, createWorkspace, listRepositoryPaths, readRepositoryFiles, projectSignals } = vi.hoisted(() => ({
	applyChangeset: vi.fn(),
	commit: vi.fn(),
	createWorkspace: vi.fn(),
	listRepositoryPaths: vi.fn(),
	readRepositoryFiles: vi.fn(),
	projectSignals: vi.fn(),
}));

const { resolveConnection } = vi.hoisted(() => ({ resolveConnection: vi.fn(async () => ({
		contentPath: 'src/content',
		repositoryId: 'repository-1',
		baseRef: 'refs/heads/main',
		authoringBranch: 'main',
		allowedPaths: ['src/content/**'],
		client: {
			createWorkspace,
			listRepositoryPaths,
			readRepositoryFiles,
			applyChangeset,
			commit,
			closeWorkspace: vi.fn(),
		},
	})) }));

vi.mock('../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: resolveConnection,
}));

vi.mock('../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({
	projectTreeDxCommitSignals: projectSignals,
}));

import { appendDiscussionEvent, commitDiscussionMessage, discussionEventPathIdentity, loadDiscussions, mentionedAgentSlugs, validateDiscussionContextRefs } from '../../../src/api/discussions/content.ts';

describe('TreeDX Discussion content', () => {
	beforeEach(() => {
		resolveConnection.mockClear();
		createWorkspace.mockReset().mockResolvedValue({ workspaceId: 'workspace-1', baseCommitSha: 'base123', baseRef: 'refs/heads/main' });
		listRepositoryPaths.mockReset().mockResolvedValue({ entries: [], resolvedRef: 'refs/heads/main' });
		readRepositoryFiles.mockReset().mockResolvedValue({ files: [], resolvedRef: 'refs/heads/main' });
		applyChangeset.mockReset().mockResolvedValue({ changedPaths: [] });
		commit.mockReset().mockResolvedValue({ commitSha: 'a'.repeat(40), branchName: 'refs/heads/main', changedPaths: [] });
		projectSignals.mockReset().mockResolvedValue({});
	});

	it('deduplicates agent mentions without interpreting email addresses', () => {
		expect(mentionedAgentSlugs('Ask @architect and @architect, then @reviewer.')).toEqual(['architect', 'reviewer']);
		expect(mentionedAgentSlugs('Mail person@example.com')).toEqual([]);
	});

	it('retains a collision-resistant suffix when long telemetry identities share a prefix', () => {
		const prefix = `activity:${'assignment-a'.repeat(8)}:`;
		const started = discussionEventPathIdentity(`${prefix}started`);
		const completed = discussionEventPathIdentity(`${prefix}completed`);
		expect(started).not.toBe(completed);
		expect(started).toHaveLength(65);
		expect(completed).toHaveLength(65);
	});

	it('commits the session, user message, and append-only event through TreeDX before dispatch', async () => {
		const commitSha = 'a'.repeat(40);
		const changedPaths = ['src/content/discussions/thread.mdx'];
		const store = {
			getProject:vi.fn().mockResolvedValue({ teamId:'team-1' }),
			upsertProjectTreeDxLibrary:vi.fn().mockResolvedValue({ repositoryId:'repository-1',contentRepositoryRef:commitSha }),
			run:vi.fn().mockResolvedValue({}),all:vi.fn().mockResolvedValue([]),
		};
		commit.mockResolvedValue({ commitSha, branchName: 'refs/heads/main', changedPaths });
		readRepositoryFiles.mockResolvedValue({ files: changedPaths.map((path) => ({ path })), resolvedRef: commitSha });
		const authored = await commitDiscussionMessage({
			store, projectId: 'project-1', teamId: 'team-1',
			principal: { id: 'user-1', displayName: 'Adrian', email: 'adrian@example.com' },
			body: 'Please review src/example.ts with @reviewer.', intent: 'discuss',
			fileRefs: [{ path: 'src/example.ts' }],
			contextRefs: [{ kind: 'event', id: 'event-1', projectId: 'project-1', workdayId: 'run-1', eventSequence: 2 }],
		});

		expect(authored.mentions).toEqual(['reviewer']);
		expect(applyChangeset).toHaveBeenCalledOnce();
		const request = applyChangeset.mock.calls[0]![0];
		expect(request.contract).toBe('treedx.changeset/v1');
		expect(request.patch).toContain('/discussions/');
		expect(request.patch).toContain('/discussion-messages/');
		expect(request.patch).toContain('/discussion-events/');
		expect(request.patch).toContain('contextRefs');
		expect(commit).toHaveBeenCalledOnce();
		expect(projectSignals).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ projectId: 'project-1', commitSha }));
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (id) DO NOTHING'), expect.arrayContaining([
			'team-1', 'project-1', 'user', 'user-1', 'refs/heads/main', 'authoring_integrated',
		]));
		const journalParams = store.run.mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('authoring_integrated'))?.[1];
		expect(store.upsertProjectTreeDxLibrary).toHaveBeenCalledWith('project-1', {
			repositoryId:'repository-1',contentRepositoryRef:commitSha,
		});
		expect(JSON.parse(String(journalParams?.[8]))).toMatchObject({ advanceProjectContentRef: true });
	});

	it('read-backs control-plane Discussion events and journals them as canonical evidence', async () => {
		const commitSha = 'c'.repeat(40);
		const eventId = 'event-1';
		const occurredAt = '2026-08-15T03:00:00.000Z';
		const eventPath = `src/content/discussion-events/thread/${occurredAt.replace(/[^0-9]/gu, '')}-${discussionEventPathIdentity(eventId)}.mdx`;
		const eventSource = serializeFrontmatterDocument({ title: 'assignment.failed', discussionId: 'thread', phase: 'assignment.failed',
			sequence: 1, assignmentId: 'assignment-a', occurredAt, metrics: {}, refs: [] }, 'assignment.failed recorded.\n');
		const store = {
			getProject: vi.fn().mockResolvedValue({ teamId: 'team-1' }),
			upsertProjectTreeDxLibrary: vi.fn().mockResolvedValue({ repositoryId: 'repository-1', contentRepositoryRef: commitSha }),
			run: vi.fn().mockResolvedValue({}), all: vi.fn().mockResolvedValue([]),
		};
		commit.mockResolvedValue({ commitSha, branchName: 'refs/heads/main', changedPaths: [eventPath] });
		readRepositoryFiles.mockImplementation(async (request: { ref: string; paths: string[] }) => {
			if (request.ref !== commitSha) return { files: [], resolvedRef: 'refs/heads/main' };
			return { files: [{ path: request.paths[0], content: eventSource.trimEnd() }], resolvedRef: commitSha };
		});

		const result = await appendDiscussionEvent({
			store, projectId: 'project-1', teamId: 'team-1', discussionId: 'thread',
			event: { id: eventId, eventType: 'assignment.failed', assignmentId: 'assignment-a', createdAt: occurredAt, eventIndex: 1 },
		});

		expect(result.commitSha).toBe(commitSha);
		expect(store.upsertProjectTreeDxLibrary).toHaveBeenCalledWith('project-1', {
			repositoryId:'repository-1',contentRepositoryRef:commitSha,
		});
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (id) DO NOTHING'), expect.arrayContaining([
			'team-1', 'project-1', 'assignment-a', 'service', 'discussion-projector', 'refs/heads/main', 'authoring_integrated',
		]));
		const journalParams = store.run.mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('authoring_integrated'))?.[1];
		expect(JSON.parse(String(journalParams?.[8]))).toMatchObject({ advanceProjectContentRef: true });
	});

	it('does not recreate an existing Discussion when an agent appends its response',async()=>{
		await commitDiscussionMessage({
			store:{getProject:vi.fn().mockResolvedValue({teamId:'team-1'}),run:vi.fn().mockResolvedValue({}),all:vi.fn().mockResolvedValue([])},
			projectId:'project-1',teamId:'team-1',principal:{id:'guide-steward'},authorType:'agent',authorAgentId:'guide-steward',
			assignmentId:'assignment_a',authoringRef:'refs/heads/assignment_a',discussionId:'discussion-1',messageId:'response-1',createDiscussion:false,body:'Evidence-backed response.',intent:'discuss',
			replyTo:'message-1',sourceMessageRefs:['message-1'],recipients:['team-key:local-capacity-acceptance'],
		});
		const request=applyChangeset.mock.calls[0]![0];
		expect(request.patch).toContain('/discussion-messages/discussion-1/response-1.mdx');
		expect(request.patch).toContain('recipientIds');
		expect(request.patch).toContain('team-key:local-capacity-acceptance');
		expect(request.patch).not.toContain('mentionedAgents:\n  - team-key');
		expect(request.patch).not.toContain('/discussions/discussion-1.mdx');
		expect(resolveConnection).toHaveBeenCalledWith(expect.any(Object),expect.objectContaining({workspaceRefs:['refs/heads/assignment_a']}));
		expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({baseRef:'refs/heads/assignment_a'}));
	});

	it('returns field-addressable Zod feedback before opening a TreeDX workspace', async () => {
		await expect(commitDiscussionMessage({
			store: {}, projectId: 'project-1', teamId: 'team-1', principal: { id: 'user-1' }, body: '', intent: 'discuss',
		})).rejects.toMatchObject({
			code: 'discussion_content_invalid', details: expect.arrayContaining([expect.objectContaining({ field: 'title' })]),
		});
		expect(createWorkspace).not.toHaveBeenCalled();
	});

	it('rejects invalid TreeDX discussion ingestion with the same field diagnostics', async () => {
		listRepositoryPaths.mockResolvedValue({
			entries: [{ path: 'src/content/discussion-messages/thread/message.mdx' }], resolvedRef: 'a'.repeat(40),
		});
		readRepositoryFiles.mockResolvedValue({
			files: [{ path: 'src/content/discussion-messages/thread/message.mdx', content: '---\nauthorType: robot\n---\nMessage' }],
			resolvedRef: 'refs/heads/main',
		});
		await expect(loadDiscussions({ store: { all:vi.fn().mockResolvedValue([]) }, projectId: 'project-1', discussionId: 'thread' })).rejects.toMatchObject({
			code: 'discussion_content_invalid', details: expect.arrayContaining([
				expect.objectContaining({ field: 'title' }), expect.objectContaining({ field: 'author_type' }),
			]),
		});
		expect(readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: 'refs/heads/main' }));
	});

	it('overlays journaled unpublished messages for authoritative simulation read-back', async () => {
		const commitSha='b'.repeat(40); const path='src/content/discussion-messages/thread/agent-response.mdx';
		const source='---\ntitle: Agent response\ndiscussionId: thread\nauthorId: guide-steward\nauthorType: agent\nintent: discuss\nmentionedAgents: []\nfileRefs: []\ncontextRefs: []\nreplyTo: message-a\nsourceMessageRefs:\n  - message-a\nauthorAgentId: guide-steward\ncreatedAt: 2026-08-15T03:00:00.000Z\n---\nEvidence-backed response.\n';
		readRepositoryFiles.mockImplementation(async(input:{ref:string})=>input.ref===commitSha?{files:[{path,content:source}],resolvedRef:commitSha}:{files:[],resolvedRef:'refs/heads/main'});
		const store={all:vi.fn().mockResolvedValue([{assignment_id:'assignment-a',result_status:'authoring_unpublished',metadata_json:JSON.stringify({commitSha,changedPaths:[path]}),created_at:'2026-08-15T03:00:00.000Z'}])};
		const result=await loadDiscussions({store,projectId:'project-1',discussionId:'thread'});
		expect(result.messages).toEqual([expect.objectContaining({id:'agent-response',body:'Evidence-backed response.'})]);
		expect(resolveConnection).toHaveBeenCalledWith(store,expect.objectContaining({readRefs:[commitSha]}));
		expect(readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ref:commitSha,paths:[path]}));
	});

	it('retains integrated messages in authoritative Discussion read-back while the branch index converges', async () => {
		const commitSha='d'.repeat(40); const path='src/content/discussion-messages/thread/simulation-response.mdx';
		const source='---\ntitle: Simulation response\ndiscussionId: thread\nauthorId: guide-steward\nauthorType: agent\nintent: discuss\nmentionedAgents: []\nfileRefs: []\ncontextRefs: []\nreplyTo: message-a\nsourceMessageRefs:\n  - message-a\nauthorAgentId: guide-steward\ncreatedAt: 2026-08-15T03:00:00.000Z\n---\nDurable simulation response.\n';
		readRepositoryFiles.mockImplementation(async(input:{ref:string})=>input.ref===commitSha?{files:[{path,content:source}],resolvedRef:commitSha}:{files:[],resolvedRef:'refs/heads/main'});
		const unrelated=Array.from({length:60},(_,index)=>({assignment_id:`assignment-${index}`,result_status:'authoring_integrated',metadata_json:JSON.stringify({commitSha:`${index}`.padStart(40,'e').slice(-40),changedPaths:[`src/content/discussion-messages/unrelated/message-${index}.mdx`],advanceProjectContentRef:true}),created_at:`2026-08-15T04:${String(index).padStart(2,'0')}:00.000Z`}));
		const store={all:vi.fn().mockResolvedValue([{assignment_id:'assignment-a',result_status:'authoring_integrated',metadata_json:JSON.stringify({commitSha,changedPaths:[path],advanceProjectContentRef:true}),created_at:'2026-08-15T03:00:00.000Z'},...unrelated])};
		const result=await loadDiscussions({store,projectId:'project-1',discussionId:'thread'});
		expect(result.messages).toEqual([expect.objectContaining({id:'simulation-response',body:'Durable simulation response.'})]);
		expect(readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ref:commitSha,paths:[path]}));
	});

	it('validates historical topology and exact event positions before Discussion attachment', async () => {
		const topology = { projectId: 'project-1', immutableRef: 'commit-1', nodes: [{ id: 'agent:project-1:reviewer', kind: 'agent' }], edges: [] };
		const store = { first: vi.fn(async (query: string) => query.includes('capacity_workday_runs')
			? { id: 'run-1', parameters_json: JSON.stringify({ atlasTopologyByProjectId: { 'project-1': topology } }) }
			: query.includes('capacity_workday_events') ? { id: 'event-1' } : null) };
		const refs = await validateDiscussionContextRefs({ store, teamId: 'team-1', projectId: 'project-1', values: [
			{ kind: 'agent', id: 'agent:project-1:reviewer', projectId: 'project-1', workdayId: 'run-1', immutableRef: 'commit-1' },
			{ kind: 'event', id: 'event-1', projectId: 'project-1', workdayId: 'run-1', eventSequence: 2 },
		] });
		expect(refs).toHaveLength(2);
		await expect(validateDiscussionContextRefs({ store, teamId: 'team-1', projectId: 'project-1', values: [{ kind: 'agent', id: 'agent:other', projectId: 'project-2' }] })).rejects.toMatchObject({ code: 'discussion_context_project_forbidden' });
	});
});
