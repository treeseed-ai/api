import { resolveKnowledgeGatewayConnection } from '../../api/knowledge/gateway-treedx-connection.ts';
import { buildKnowledgePublication } from '../../api/knowledge/build-publication.ts';
import { loadKnowledgeSnapshotProjects } from '../../api/knowledge/snapshot-projects.ts';
import { createKnowledgePublicationStorage } from '../../api/knowledge/publication-storage.ts';
import { recordPublicationCompletedAudit, recordPublicationEntryAudits } from './publication-audit.ts';
import { publishRemoteRepository } from './remote-publication.ts';
import { editorialReviewGate, verifiedEditorialContextTrace } from '../../api/knowledge/editorial-review.ts';
import { recordTreeDxAuthoringState } from '../../api/capacity/services/treedx/repositories/treedx-authoring-journal.ts';

export function localPublicationRemote(value: unknown) {
	if (typeof value !== 'string' || !value.trim()) return false;
	const remote = value.trim();
	if (remote.startsWith('file://') || remote.startsWith('/') || remote.startsWith('./') || remote.startsWith('../')) return true;
	try { return new URL(remote).protocol === 'file:'; } catch { return false; }
}

export function isManagedLocalPublication(repository: { storageKind?: unknown; remoteUrl?: unknown }, environment: unknown) {
	return environment === 'local' && repository.storageKind === 'managed'
		&& (repository.remoteUrl === null || repository.remoteUrl === undefined || repository.remoteUrl === '');
}

export function knowledgePublicationTransport(repository: { storageKind?: unknown; remoteUrl?: unknown },
	environment: unknown, binding?: { clone_url?: unknown; grant_status?: unknown } | null) {
	if (binding?.grant_status === 'ready' && !localPublicationRemote(binding.clone_url)) return 'external';
	if (isManagedLocalPublication(repository, environment)) return 'managed-local';
	return localPublicationRemote(repository.remoteUrl) ? 'local-remote' : 'external';
}

export function treeDxPrimaryNodeId(value: unknown) {
	if (!value || typeof value !== 'object') return '';
	const result = value as Record<string, any>;
	return String(result.primaryNodeId ?? result.placement?.primaryNodeId ?? '');
}

export function knowledgeRunnerEnvironment(options: any) {
	return options.environment ?? options.config?.environment
		?? process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT;
}

export function treeDxResult(value: unknown, key: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as any;
	const record = value as Record<string, any>;
	return record[key] && typeof record[key] === 'object' ? record[key] : record;
}

export async function completedGraphRefresh(client: any, input: any) {
	const refresh = treeDxResult(await client.refreshGraph(input), 'graph');
	if (!refresh.jobId) return refresh;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const job = treeDxResult(await client.getGraphRefreshJob({ repoId: input.repoId, ref: input.ref, jobId: refresh.jobId }), 'job');
		if (job.status === 'completed') return { ...refresh, graphVersion: job.graphVersion ?? refresh.graphVersion };
		if (job.status === 'failed') throw new Error(`TreeDX graph refresh failed: ${job.errorCode ?? 'unknown error'}.`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('TreeDX graph refresh did not complete before the publication deadline.');
}

export function requireIndexedSourceClosure(input: {
	projectId: string; commitSha: string; graph?: any; search?: any;
}) {
	const graphRef = String(input.graph?.resolvedRef ?? '');
	const searchRef = String(input.search?.resolvedRef ?? '');
	if (graphRef !== input.commitSha || searchRef !== input.commitSha || input.search?.stale) {
		throw Object.assign(new Error(`TreeDX graph/search closure is stale for project ${input.projectId}.`), {
			code: 'treedx_source_closure_stale',
			details: [{ projectId: input.projectId, expectedRef: input.commitSha, graphRef, searchRef,
				searchStale: Boolean(input.search?.stale) }],
		});
	}
}

function containsPublicationCommit(manifest: any, publication: any, workspace: any) {
	return manifest?.projects?.some((project: any) => project.projectId === workspace.projectId
		&& project.repositoryId === workspace.repositoryId && project.ref === publication.published_ref
		&& project.commitSha === publication.commit_sha);
}

function resultFor(publication: any, manifest: any, graphRevision?: string, push?: any, search?: any) {
	return { ok: true, publicationId: publication.id, commitSha: publication.commit_sha,
		publishedRef: publication.published_ref, publishedRevision: manifest.revision,
		sourceClosure: manifest.sourceClosure, manifestDigest: manifest.digest, graphRevision,
		push: push ? { status: push.status, updatedRefs: push.updatedRefs ?? [push.destinationRef].filter(Boolean) } : undefined,
		searchIndexVersion: search?.indexVersion };
}

export function createKnowledgePublicationExecutor(options: any) {
	const environment = knowledgeRunnerEnvironment(options);
	const resolveConnection = options.resolveKnowledgeGatewayConnection ?? resolveKnowledgeGatewayConnection;
	const loadSnapshots = options.loadKnowledgeSnapshotProjects ?? loadKnowledgeSnapshotProjects;
	const publishRemote = options.publishRemoteRepository ?? publishRemoteRepository;
	return {
		namespace: 'knowledge', operation: 'publish_review',
		async run(input: any, context: any) {
			const store = options.controlPlaneStore;
			if (!store) throw new Error('Knowledge publication requires a control-plane store.');
			let publication = await store.first('SELECT * FROM knowledge_publications WHERE id = ?', [String(input?.publicationId ?? '')]);
			if (!publication || !['queued', 'completed'].includes(publication.status)) {
				throw new Error('Recoverable knowledge publication was not found.');
			}
			const [workspace, review] = await Promise.all([
				store.getKnowledgeWorkspace(publication.workspace_id), store.getKnowledgeReview(publication.review_id),
			]);
			const publicationStorage = createKnowledgePublicationStorage({ adapter: options.knowledgePublicationStorage,
				environment });
			if (publication.status === 'completed') {
				if (!workspace || !review) throw new Error('Completed publication workflow records are missing.');
				const current = await publicationStorage.readCurrent(workspace.teamId);
				if (workspace.status !== 'published' || review.status !== 'approved'
					|| publication.published_revision !== current?.revision || !containsPublicationCommit(current, publication, workspace)) {
					throw new Error('Completed publication state does not match the current immutable manifest.');
				}
				const prior = current.previousRevision
					? await publicationStorage.readRevision(workspace.teamId, current.previousRevision) : null;
				await recordPublicationEntryAudits({ store, storage: publicationStorage, publication, workspace, previous: prior, manifest: current });
				await recordPublicationCompletedAudit({ store, publication, workspace, review, manifest: current,
					operationId: context.operation.id });
				await context.checkpoint({ phase: 'knowledge.publication.completed', publicationId: publication.id,
					publishedRevision: current.revision, sourceClosure: current.sourceClosure },
					{ kind: 'knowledge.publication.completed', data: { publicationId: publication.id,
						publishedRevision: current.revision, sourceClosure: current.sourceClosure } });
				return resultFor(publication, current);
			}
			if (!workspace || workspace.status !== 'approved' || !review || review.status !== 'approved'
				|| review.commitSha !== publication.commit_sha) throw new Error('Knowledge publication approval state is invalid.');
			if (!editorialReviewGate(review).ok) throw new Error('Knowledge publication editorial review state is invalid.');
			if (review.requiresEditorialReview
				&& !(await verifiedEditorialContextTrace(store, workspace.projectId, review.contextDigest))) {
				throw new Error('Knowledge publication editorial context trace is missing or stale.');
			}
			const connection = await resolveConnection(store, { projectId: workspace.projectId,
				write: false, publishRefs: [workspace.branchName, publication.published_ref,
					`refs/treedx/commits/${publication.commit_sha}`] });
			if (!connection) throw new Error('The project TreeDX repository is unavailable.');
			if (publication.published_ref !== connection.publicationRef) {
				await store.run('UPDATE knowledge_publications SET published_ref = ? WHERE id = ? AND status = ?',
					[connection.publicationRef, publication.id, 'queued']);
				publication = { ...publication, published_ref: connection.publicationRef };
			}
			const repository = await connection.client.getRepository(connection.repositoryId);
			const remoteBinding = await store.first(
				`SELECT clone_url, grant_status FROM project_remote_repository_bindings WHERE project_id = ? LIMIT 1`,
				[workspace.projectId],
			);
			const transport = knowledgePublicationTransport(repository, environment, remoteBinding);
			const external = transport === 'external';
			const managedLocal = transport === 'managed-local';
			const publicationConnection = external ? { ...connection,
				nodeId: treeDxPrimaryNodeId(await connection.client.getPlacement(connection.repositoryId)) } : connection;
			if (external && !publicationConnection.nodeId) throw new Error('TreeDX did not resolve the repository primary node for credential delivery.');
			const recoveredManifest = await publicationStorage.readCurrent(workspace.teamId);
			const publicationAlreadyApplied = containsPublicationCommit(recoveredManifest, publication, workspace);
			await context.checkpoint({ phase: 'knowledge.publication.pushing', publicationId: publication.id },
				{ kind: 'knowledge.publication.pushing', data: { publicationId: publication.id, projectId: workspace.projectId } });
			const remote = publicationAlreadyApplied || !external ? undefined : await publishRemote({
				store, operationId: context.operation.id, actorId: workspace.actorUserId,
				projectId: workspace.projectId, teamId: workspace.teamId, connection: publicationConnection,
				reviewedCommit: publication.commit_sha, baseCommit: workspace.baseCommitSha,
				publicationRef: publication.published_ref, authoringRef: workspace.branchName,
				fetchImpl: options.fetchImpl,
			});
			let push = publicationAlreadyApplied ? undefined : remote?.push ?? remote?.promotion;
			if (!publicationAlreadyApplied && managedLocal) {
				const promote = (sourceRef: string) => connection.client.promoteRef({ repoId: connection.repositoryId, sourceRef,
					destinationRef: publication.published_ref, expectedDestinationHead: workspace.baseCommitSha });
				try { push = await promote(workspace.branchName); }
				catch (error) {
					if (!(error instanceof Error) || !/ref or object not found/iu.test(error.message)) throw error;
					push = await promote(`refs/treedx/commits/${publication.commit_sha}`);
				}
			}
			if (push?.rejectedRefs?.length) throw new Error('The publication ref changed after review. Rebase and review the knowledge again.');
			const graph = publicationAlreadyApplied ? undefined : await completedGraphRefresh(connection.client,
				{ repoId: connection.repositoryId, ref: publication.published_ref, paths: workspace.allowedPaths,
					changedPaths: Array.isArray(review.changedPaths) ? review.changedPaths : [] });
			const search = publicationAlreadyApplied ? undefined : treeDxResult(await connection.client.refreshSearchIndex({ repoId: connection.repositoryId,
				ref: publication.published_ref, paths: workspace.allowedPaths }), 'index');
			if (!publicationAlreadyApplied) requireIndexedSourceClosure({ projectId: workspace.projectId,
				commitSha: publication.commit_sha, graph, search });
			const previous = recoveredManifest;
			let auditPrevious = previous;
			let manifest = previous;
			if (containsPublicationCommit(previous, publication, workspace)) {
				auditPrevious = previous?.previousRevision
					? await publicationStorage.readRevision(workspace.teamId, previous.previousRevision) : null;
			} else {
				const teamProjects = await store.listTeamProjects(workspace.teamId);
				const snapshots = await loadSnapshots(store, { teamId: workspace.teamId,
					...(previous ? { projectIds: new Set([workspace.projectId]) } : {}),
					projectRefs: new Map([[workspace.projectId, publication.commit_sha]]) });
				const graphRevisions: Record<string, string> = {};
				const refs: Record<string, string> = {};
				for (const snapshot of snapshots) {
					if (snapshot.projectId === workspace.projectId && graph && search) {
						requireIndexedSourceClosure({ projectId: snapshot.projectId, commitSha: snapshot.commitSha,
							graph, search });
						graphRevisions[snapshot.projectId] = String(graph.graphVersion ?? search.graphVersion ?? search.indexVersion);
						refs[snapshot.projectId] = publication.published_ref;
						continue;
					}
					const observed = await resolveConnection(store, { projectId: snapshot.projectId, write: false });
					if (!observed) throw new Error(`TreeDX repository is unavailable for project ${snapshot.projectId}.`);
					const snapshotConnection = await resolveConnection(store, { projectId: snapshot.projectId,
						write: false, publishRefs: [observed.baseRef] });
					if (!snapshotConnection) throw new Error(`TreeDX repository is unavailable for project ${snapshot.projectId}.`);
					const refreshedGraph = await completedGraphRefresh(snapshotConnection.client, {
						repoId: snapshot.repositoryId, ref: snapshotConnection.baseRef,
						paths: snapshotConnection.allowedPaths,
					});
					const status = treeDxResult(await snapshotConnection.client.refreshSearchIndex({ repoId: snapshot.repositoryId,
						ref: snapshotConnection.baseRef, paths: snapshotConnection.allowedPaths }), 'index');
					requireIndexedSourceClosure({ projectId: snapshot.projectId, commitSha: snapshot.commitSha,
						graph: refreshedGraph, search: status });
					graphRevisions[snapshot.projectId] = String(refreshedGraph.graphVersion ?? status.graphVersion ?? status.indexVersion);
					refs[snapshot.projectId] = snapshotConnection.baseRef;
				}
				const built = buildKnowledgePublication({ teamId: workspace.teamId, generatedAt: publication.created_at,
					previousRevision: previous?.revision, previousManifest: previous, projects: snapshots, graphRevisions, refs,
					retainedProjectIds: new Set(teamProjects.map((project: any) => project.id)) });
				await publicationStorage.publish({ manifest: built.manifest, objects: built.objects,
					expectedRevision: previous?.revision });
				manifest = built.manifest;
			}
			if (!manifest || !containsPublicationCommit(manifest, publication, workspace)) {
				throw new Error('The immutable publication manifest does not contain the reviewed commit.');
			}
			if (managedLocal || external) {
				await connection.client.retireRef({ repoId: connection.repositoryId, ref: workspace.branchName,
					mergedIntoRef: publication.published_ref, expectedHead: publication.commit_sha,
					expectedMergedIntoHead: publication.commit_sha });
			}
			await connection.client.closeWorkspace(workspace.treeDxWorkspaceId);
			const now = new Date().toISOString();
			const updated = await store.completeKnowledgePublication(publication.id, { workspaceId: workspace.id,
				workspaceVersion: workspace.version, publishedRevision: manifest.revision, completedAt: now });
			if (!updated.ok) throw new Error('Knowledge publication state changed while the runner was working.');
			await recordTreeDxAuthoringState(store,'integrated',{ projectId:workspace.projectId,repositoryId:workspace.repositoryId,
				commitSha:publication.commit_sha,ref:publication.published_ref,changedPaths:Array.isArray(review.changedPaths) ? review.changedPaths : [],
				actorType:'service',actorId:'knowledge-publication-runner' });
			await recordPublicationEntryAudits({ store, storage: publicationStorage, publication, workspace, previous: auditPrevious, manifest });
			await recordPublicationCompletedAudit({ store, publication, workspace, review, manifest,
				operationId: context.operation.id, graphRevision: graph?.graphVersion });
			await context.checkpoint({ phase: 'knowledge.publication.completed', publicationId: publication.id,
				publishedRevision: manifest.revision, sourceClosure: manifest.sourceClosure },
				{ kind: 'knowledge.publication.completed', data: { publicationId: publication.id,
					publishedRevision: manifest.revision, sourceClosure: manifest.sourceClosure } });
			return resultFor(publication, manifest, graph?.graphVersion, push, search);
		},
	};
}
