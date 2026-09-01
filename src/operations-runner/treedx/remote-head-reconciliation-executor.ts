import { enqueueTreeDxCommitReplication } from '../../api/capacity/services/treedx/repositories/treedx-commit-replication.ts';
import { resolveKnowledgeGatewayConnection } from '../../api/knowledge/gateway-treedx-connection.ts';
import { githubRepositoryHead } from '../../providers/github/repository-client.ts';
import { resolveGitHubCredentialAuthority } from '../../security/provider-credential-authority.ts';
import { createRemoteGitCredentialDelivery } from '../../security/remote-git-credential-delivery.ts';

function refs(value: unknown): any[] {
	const rows = value && typeof value === 'object' && !Array.isArray(value) ? (value as any).refs : value;
	return Array.isArray(rows) ? rows : [];
}

function head(rows: any[], name: string) {
	const row = rows.find((candidate) => String(candidate?.name ?? '') === name);
	return String(row?.target ?? row?.sha ?? '');
}

function result(value: unknown, key: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const record = value as Record<string, any>;
	return record[key] && typeof record[key] === 'object' ? record[key] : record;
}

async function completedGraphRefresh(client: any, input: any) {
	const started = result(await client.refreshGraph(input), 'graph');
	if (!started.jobId || started.status === 'completed') return started;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const current = result(await client.getGraphRefreshJob({ ...input, jobId: started.jobId }), 'job');
		if (current.status === 'completed') return current;
		if (current.status === 'failed') throw new Error(`TreeDX graph refresh failed: ${current.errorCode ?? 'unknown error'}.`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('TreeDX graph refresh did not complete before remote reconciliation timed out.');
}

export function createTreeDxRemoteHeadReconciliationExecutor(options: any) {
	return {
		namespace: 'treedx', operation: 'reconcile_remote_head',
		async run(input: any, context: any) {
			const store = options.controlPlaneStore;
			if (!store) throw new Error('TreeDX remote reconciliation requires a control-plane store.');
			const projectId = String(input?.projectId ?? '');
			const teamId = String(input?.teamId ?? '');
			const requestedHead = String(input?.remoteHead ?? '');
			const publicationRef = String(input?.publicationRef ?? '');
			if (!projectId || !teamId || !/^[a-f0-9]{40}$/u.test(requestedHead)
				|| !publicationRef.startsWith('refs/heads/')) throw new Error('Remote reconciliation input is invalid.');
			const binding: any = await store.first(`SELECT * FROM project_remote_repository_bindings
				WHERE project_id=? AND team_id=? LIMIT 1`, [projectId, teamId]);
			if (!binding || binding.provider_id !== 'github' || binding.grant_status !== 'ready'
				|| binding.publication_ref !== publicationRef) throw new Error('The GitHub library binding is not ready for reconciliation.');
			const credential = await resolveGitHubCredentialAuthority({ store, authorityId: binding.authority_id,
				repositoryBindingId: binding.id, capability: 'repository-hosting', fetchImpl: options.fetchImpl });
			const remoteHead = await githubRepositoryHead(options.fetchImpl ?? fetch, credential.token,
				binding.owner, binding.name, publicationRef);
			if (remoteHead !== requestedHead) throw new Error('The protected library branch advanced while reconciliation was queued.');
			const remoteRef = `refs/remotes/origin/${publicationRef.slice('refs/heads/'.length)}`;
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId, write: false,
				maintenanceRefs: [publicationRef, remoteRef, remoteHead] });
			if (!connection) throw new Error('The project TreeDX repository is unavailable.');
			const placement: any = await connection.client.getPlacement(connection.repositoryId);
			const nodeId = String(placement?.primaryNodeId ?? placement?.placement?.primaryNodeId ?? connection.nodeId ?? '');
			if (!nodeId) throw new Error('TreeDX did not resolve the repository primary node for credential delivery.');
			const delivery = await createRemoteGitCredentialDelivery({ store, operationId: context.operation.id,
				actorId: 'treedx-remote-head-reconciler', teamId, projectId, repositoryBindingId: binding.id,
				credentialAuthorityId: binding.authority_id, nodeId, sourceRef: publicationRef,
				destinationRef: remoteRef, reviewedCommit: remoteHead, expectedRemoteHead: remoteHead,
				purpose: 'fetch', refspec: `+${publicationRef}:${remoteRef}` });
			await connection.client.fetchRemote({ repoId: connection.repositoryId, remoteName: 'origin',
				remoteUrl: binding.clone_url, credentialId: delivery.deliveryId,
				refspecs: [`+${publicationRef}:${remoteRef}`] });
			const repositoryRefs = refs(await connection.client.upstream.repositories.refs(connection.repositoryId));
			if (head(repositoryRefs, remoteRef) !== remoteHead) throw new Error('TreeDX did not fetch the protected branch head exactly.');
			const graph = await completedGraphRefresh(connection.client, { repoId: connection.repositoryId,
				ref: remoteRef, paths: ['**'], forceFull: true });
			await connection.client.refreshSearchIndex({ repoId: connection.repositoryId,
				ref: remoteRef, paths: ['**'], incremental: false });
			const search = result(await connection.client.upstream.searchIndex.status(connection.repositoryId,
				{ ref: remoteRef }), 'index');
			if (String(graph.resolvedRef ?? remoteHead) !== remoteHead || String(search.resolvedRef ?? '') !== remoteHead
				|| search.ready !== true || search.stale === true || !(Number(search.segmentCount) > 0)) {
				throw new Error('TreeDX graph/search did not converge on the protected branch head.');
			}
			const library: any = await store.getProjectTreeDxLibrary(projectId);
			const now = new Date().toISOString();
			const metadata = { ...(library?.metadata ?? {}), resolvedRef: remoteHead,
				upstreamHeads: { ...(library?.metadata?.upstreamHeads ?? {}), [remoteRef]: remoteHead },
				searchIndex: { ready: true, segmentCount: search.segmentCount ?? null }, reconciledAt: now };
			const updated = await store.upsertProjectTreeDxLibrary(projectId, {
				repositoryId: connection.repositoryId, contentPath: library.contentPath,
				contentRepositoryUrl: library.contentRepositoryUrl,
				contentRepositoryDefaultBranch: library.contentRepositoryDefaultBranch,
				contentRepositoryRef: remoteRef, metadata,
			});
			if (!updated) throw new Error('TreeDX library binding could not be updated after reconciliation.');
			await store.run(`UPDATE project_remote_repository_bindings SET expected_head=?,observed_head=?,drift='none',
				version=version+1,updated_at=? WHERE id=?`, [remoteHead, remoteHead, now, binding.id]);
			const replication = await enqueueTreeDxCommitReplication(store, { teamId, projectId, commitSha: remoteHead,
				sourceRef: remoteRef, createdAt: now });
			await context.checkpoint({ phase: 'treedx.remote-head.reconciled', projectId, remoteHead },
				{ kind: 'treedx.remote-head.reconciled', data: { projectId, remoteHead, publicationRef } });
			return { projectId, publicationRef, currentLogicalRef: remoteRef, remoteHead, graph, search, replication };
		},
	};
}
