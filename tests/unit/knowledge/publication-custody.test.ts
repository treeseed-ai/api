import { describe, expect, it, vi } from 'vitest';
import { loadKnowledgeSnapshotProjects } from '../../../src/api/knowledge/snapshot-projects.ts';
import { recordPublicationEntryAudits } from '../../../src/operations-runner/knowledge/publication-audit.ts';
import {
	createKnowledgePublicationExecutor,
	isManagedLocalPublication,
	knowledgeRunnerEnvironment,
	localPublicationRemote,
	requireIndexedSourceClosure,
} from '../../../src/operations-runner/knowledge/publication-executor.ts';

describe('knowledge publication custody boundary', () => {
	it('permits atomic promotion only for managed repositories in the local environment', () => {
		expect(isManagedLocalPublication({ storageKind: 'managed', remoteUrl: null }, 'local')).toBe(true);
		expect(isManagedLocalPublication({ storageKind: 'managed', remoteUrl: null }, 'staging')).toBe(false);
		expect(isManagedLocalPublication({ storageKind: 'managed', remoteUrl: 'https://github.com/example/repo' }, 'local')).toBe(false);
		expect(isManagedLocalPublication({ storageKind: 'remote', remoteUrl: null }, 'local')).toBe(false);
	});

	it('permits explicit file remotes without admitting hosted provider URLs', () => {
		expect(localPublicationRemote('file:///tmp/repository.git')).toBe(true);
		expect(localPublicationRemote('/tmp/repository.git')).toBe(true);
		expect(localPublicationRemote('https://github.com/example/repository.git')).toBe(false);
		expect(localPublicationRemote('git@github.com:example/repository.git')).toBe(false);
	});

	it('constructs publication execution from the canonical runner environment', () => {
		expect(knowledgeRunnerEnvironment({ config: { environment: 'local' } })).toBe('local');
		expect(createKnowledgePublicationExecutor({ config: { environment: 'local' } })).toMatchObject({
			namespace: 'knowledge', operation: 'publish_review',
		});
	});

	it('requires graph and search to resolve the exact publication commit', () => {
		const commitSha = 'a'.repeat(40);
		expect(() => requireIndexedSourceClosure({ projectId: 'project-a', commitSha,
			graph: { resolvedRef: commitSha }, search: { resolvedRef: commitSha, stale: false } })).not.toThrow();
		expect(() => requireIndexedSourceClosure({ projectId: 'project-a', commitSha,
			graph: { resolvedRef: 'b'.repeat(40) }, search: { resolvedRef: commitSha, stale: false } }))
			.toThrow(/graph\/search closure is stale/u);
		expect(() => requireIndexedSourceClosure({ projectId: 'project-a', commitSha,
			graph: { resolvedRef: commitSha }, search: { resolvedRef: commitSha, stale: true } }))
			.toThrow(/graph\/search closure is stale/u);
	});

	it('fails closed when any authoritative team project has no TreeDX binding', async () => {
		const store = {
			listTeamProjects: vi.fn().mockResolvedValue([{ id: 'project-without-treedx', teamId: 'team-a' }]),
			getProjectTreeDxLibrary: vi.fn().mockResolvedValue(null), config: {},
		};
		await expect(loadKnowledgeSnapshotProjects(store, { teamId: 'team-a' }))
			.rejects.toThrow(/team project project-without-treedx/u);
		expect(store.listTeamProjects).toHaveBeenCalledWith('team-a');
	});

	it('resumes after Git and the immutable manifest were promoted before database completion', async () => {
		const commit = 'a'.repeat(40);
		const publication = { id: 'publication-a', workspace_id: 'workspace-a', review_id: 'review-a', project_id: 'project-a',
			commit_sha: commit, published_ref: 'refs/heads/main', status: 'queued', created_at: '2026-08-01T00:00:00.000Z' };
		const workspace = { id: 'workspace-a', teamId: 'team-a', projectId: 'project-a', repositoryId: 'repo-a',
			treeDxWorkspaceId: 'remote-workspace-a', actorUserId: 'author-a', branchName: 'refs/heads/authoring/a',
			baseCommitSha: 'b'.repeat(40), allowedPaths: ['docs/src/content/**'], status: 'approved', version: 7 };
		const review = { id: 'review-a', status: 'approved', commitSha: commit };
		const manifest = { teamId: 'team-a', revision: 'revision-a', sourceClosure: 'closure-a', digest: 'digest-a',
			previousRevision: 'revision-prior', entries: [], projects: [{ projectId: 'project-a', repositoryId: 'repo-a',
				ref: 'refs/heads/main', commitSha: commit }] };
		const client = { getRepository: vi.fn().mockResolvedValue({ storageKind: 'managed', remoteUrl: null }),
			promoteRef: vi.fn().mockResolvedValue({ status: 'already_current', destinationRef: 'refs/heads/main' }),
			retireRef: vi.fn().mockResolvedValue({ status: 'already_retired' }),
			refreshGraph: vi.fn().mockResolvedValue({ graphVersion: 'graph-a' }),
			refreshSearchIndex: vi.fn().mockResolvedValue({ resolvedRef: commit, stale: false, indexVersion: 'index-a' }),
			closeWorkspace: vi.fn().mockResolvedValue(undefined) };
		const store = { first: vi.fn().mockResolvedValue(publication), getKnowledgeWorkspace: vi.fn().mockResolvedValue(workspace),
			getKnowledgeReview: vi.fn().mockResolvedValue(review), completeKnowledgePublication: vi.fn().mockResolvedValue({ ok: true }),
			recordAuditEvent: vi.fn().mockResolvedValue({}) };
		const storage = { readCurrent: vi.fn().mockResolvedValue(manifest), readRevision: vi.fn().mockResolvedValue(null),
			readObject: vi.fn(), publish: vi.fn(), rollback: vi.fn() };
		const loadSnapshots = vi.fn();
		const checkpoint = vi.fn().mockResolvedValue(undefined);
		const executor = createKnowledgePublicationExecutor({ environment: 'local', controlPlaneStore: store,
			knowledgePublicationStorage: storage, loadKnowledgeSnapshotProjects: loadSnapshots,
			resolveKnowledgeGatewayConnection: vi.fn().mockResolvedValue({ client, repositoryId: 'repo-a', baseRef: 'refs/heads/main' }) });
		const result = await executor.run({ publicationId: publication.id }, { operation: { id: 'operation-a' }, checkpoint });
		expect(result).toMatchObject({ ok: true, publishedRevision: 'revision-a' });
		expect(client.promoteRef).not.toHaveBeenCalled();
		expect(client.retireRef).toHaveBeenCalledWith(expect.objectContaining({
			ref: workspace.branchName, expectedHead: commit, expectedMergedIntoHead: commit,
		}));
		expect(loadSnapshots).not.toHaveBeenCalled();
		expect(storage.publish).not.toHaveBeenCalled();
		expect(client.closeWorkspace).toHaveBeenCalledWith(workspace.treeDxWorkspaceId);
		expect(store.completeKnowledgePublication).toHaveBeenCalledWith(publication.id, expect.objectContaining({ workspaceVersion: 7 }));
	});

	it('keeps the approved workspace recoverable when remote Git succeeds but TreeDX graph parity fails', async () => {
		const commit = 'c'.repeat(40);
		const publication = { id: 'publication-remote', workspace_id: 'workspace-remote', review_id: 'review-remote',
			commit_sha: commit, published_ref: 'refs/heads/main', status: 'queued', created_at: '2026-08-01T00:00:00.000Z' };
		const workspace = { id: 'workspace-remote', teamId: 'team-a', projectId: 'project-a', repositoryId: 'repo-a',
			treeDxWorkspaceId: 'workspace-on-treedx', actorUserId: 'author-a', branchName: 'refs/heads/authoring/remote',
			baseCommitSha: 'b'.repeat(40), allowedPaths: ['docs/src/content/**'], status: 'approved', version: 3 };
		const client = {
			getRepository: vi.fn().mockResolvedValue({ storageKind: 'remote', remoteUrl: 'https://github.com/example/knowledge.git' }),
			getPlacement: vi.fn().mockResolvedValue({ primaryNodeId: 'node-a' }),
			refreshGraph: vi.fn().mockResolvedValue({ resolvedRef: workspace.baseCommitSha, graphVersion: 'stale-graph' }),
			refreshSearchIndex: vi.fn().mockResolvedValue({ resolvedRef: commit, stale: false, indexVersion: 'index-a' }),
			retireRef: vi.fn(), closeWorkspace: vi.fn(),
		};
		const store = { first: vi.fn().mockResolvedValue(publication), getKnowledgeWorkspace: vi.fn().mockResolvedValue(workspace),
			getKnowledgeReview: vi.fn().mockResolvedValue({ id: 'review-remote', status: 'approved', commitSha: commit }),
			completeKnowledgePublication: vi.fn(), recordAuditEvent: vi.fn() };
		const publishRemote = vi.fn().mockResolvedValue({ push: { status: 'pushed', afterHead: commit },
			promotion: { status: 'promoted', afterHead: commit } });
		const executor = createKnowledgePublicationExecutor({ environment: 'local', controlPlaneStore: store,
			knowledgePublicationStorage: { readCurrent: vi.fn().mockResolvedValue(null) },
			publishRemoteRepository: publishRemote,
			resolveKnowledgeGatewayConnection: vi.fn().mockResolvedValue({ client, repositoryId: 'repo-a', baseRef: 'refs/heads/main' }) });
		await expect(executor.run({ publicationId: publication.id }, { operation: { id: 'operation-remote' }, checkpoint: vi.fn() }))
			.rejects.toThrow(/graph\/search closure is stale/u);
		expect(publishRemote).toHaveBeenCalledWith(expect.objectContaining({ reviewedCommit: commit,
			publicationRef: publication.published_ref, authoringRef: workspace.branchName }));
		expect(client.retireRef).not.toHaveBeenCalled();
		expect(client.closeWorkspace).not.toHaveBeenCalled();
		expect(store.completeKnowledgePublication).not.toHaveBeenCalled();
	});

	it('does not report every document as updated when only repository provenance changes', async () => {
		const earlier = { kind: 'page', id: 'knowledge-a', status: 'published', projectId: 'project-a',
			content: { sha256: 'old-object', objectKey: 'old.json' } };
		const current = { ...earlier, content: { sha256: 'new-object', objectKey: 'new.json' } };
		const payload = (commitSha: string) => JSON.stringify({ definition: { id: 'knowledge-a', title: 'Stable' },
			source: { projectId: 'project-a', commitSha } });
		const store = { recordAuditEvent: vi.fn() };
		await recordPublicationEntryAudits({ store, storage: { readObject: vi.fn((key: string) => key === 'old.json'
			? payload('a'.repeat(40)) : payload('b'.repeat(40))) }, publication: { id: 'publication-a' },
			workspace: { id: 'workspace-a', teamId: 'team-a', actorUserId: 'author-a' },
			previous: { entries: [earlier] }, manifest: { revision: 'revision-a', entries: [current] } });
		expect(store.recordAuditEvent).not.toHaveBeenCalled();
	});
});
