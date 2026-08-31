import { resolveKnowledgeGatewayConnection } from '../../api/knowledge/gateway-treedx-connection.ts';
import { R2S3PublicationClient } from '../../api/providers/cloudflare/r2-s3-publication-client.ts';
import { githubRepositoryHead } from '../../providers/github/repository-client.ts';
import { resolveGitHubCredentialAuthority } from '../../security/provider-credential-authority.ts';
import { createRemoteGitCredentialDelivery } from '../../security/remote-git-credential-delivery.ts';
import { isR2ReplicationReceipt, mirrorTreeDxCommit, resolveCanonicalTreeDxRef, TREE_DX_MIRROR_SCHEMA, TREE_DX_MIRROR_SKIPPED_SCHEMA } from './r2-file-mirror.ts';

function setting(options: any, name: string) {
	return String(options.config?.[name] ?? process.env[name] ?? '').trim();
}

async function verifyPrivateBucket(options: any, bucket: string) {
	const accountId = setting(options, 'TREESEED_CLOUDFLARE_ACCOUNT_ID');
	const apiToken = setting(options, 'TREESEED_CLOUDFLARE_API_TOKEN');
	if (!accountId || !apiToken) throw new Error('Cloudflare management authority is required to verify that the R2 library mirror bucket is private.');
	const root = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/domains`;
	const request = async (path: string) => {
		const response = await (options.fetchImpl ?? fetch)(`${root}/${path}`, { headers: { authorization: `Bearer ${apiToken}` } });
		if (!response.ok) throw new Error(`Cloudflare could not verify R2 bucket privacy (HTTP ${response.status}).`);
		const payload = await response.json() as any;
		if (payload.success === false) throw new Error('Cloudflare rejected the R2 bucket privacy check.');
		return payload.result;
	};
	const [managed, custom] = await Promise.all([request('managed'), request('custom')]);
	if (managed?.enabled || (custom?.domains ?? []).some((domain: any) => domain?.enabled)) {
		throw new Error('The configured R2 library mirror bucket has public domain access enabled.');
	}
	return { verifiedPrivate: true, managedDomainEnabled: false, enabledCustomDomainCount: 0 };
}

async function resolveExactSourceRef(connection: any, row: any) {
	const response: any = await connection.client.upstream.repositories.refs(connection.repositoryId);
	const refs = Array.isArray(response?.refs) ? response.refs : [];
	const preservationRef = `refs/treedx/commits/${row.commit_sha}`;
	for (const name of [preservationRef, row.source_ref]) {
		const ref = refs.find((candidate: any) => candidate?.name === name);
		if (String(ref?.target ?? ref?.sha ?? '') === row.commit_sha) return name;
	}
	throw new Error('TreeDX no longer has an authorized ref pointing to the exact commit.');
}

async function replicateGitHub(options: any, row: any, connection: any, operationId: string, sourceRef: string) {
	const store = options.controlPlaneStore;
	const binding: any = await store.first('SELECT * FROM project_remote_repository_bindings WHERE project_id = ?', [row.project_id]);
	if (!binding || binding.grant_status !== 'ready') throw new Error('A ready GitHub repository binding is required for commit replication.');
	const credential = await resolveGitHubCredentialAuthority({ store, authorityId: binding.authority_id,
		repositoryBindingId: binding.id, capability: 'repository-hosting', fetchImpl: options.fetchImpl });
	const provenNode: any = await store.first(`SELECT d.node_id FROM remote_credential_deliveries d
		JOIN remote_git_operation_grants g ON g.id=d.grant_id
		WHERE g.repository_binding_id=? AND d.status='consumed' ORDER BY d.consumed_at DESC LIMIT 1`, [binding.id]);
	const localNode = (options.config?.environment ?? process.env.TREESEED_ENVIRONMENT) === 'local' ? 'node_local' : '';
	const nodeId = String(provenNode?.node_id || setting(options, 'TREESEED_TREEDX_CREDENTIAL_BROKER_NODE_ID') || localNode).trim();
	if (!nodeId) throw new Error('No previously verified TreeDX credential-broker node identity is available.');
	const current = await githubRepositoryHead(options.fetchImpl ?? fetch, credential.token, binding.owner, binding.name, row.github_ref);
	if (current && current !== row.commit_sha) throw new Error(`Immutable GitHub backup ref ${row.github_ref} points to a different commit.`);
	let push: any = null;
	if (!current) {
		const delivery = await createRemoteGitCredentialDelivery({ store, operationId, actorId: 'treedx-commit-replicator',
			teamId: row.team_id, projectId: row.project_id, repositoryBindingId: binding.id,
			credentialAuthorityId: binding.authority_id, nodeId, sourceRef,
			destinationRef: row.github_ref, reviewedCommit: row.commit_sha, expectedRemoteHead: null, purpose: 'push' });
		push = await connection.client.push({ repoId: row.repository_id, remoteName: 'origin', remoteUrl: binding.clone_url,
			credentialId: delivery.deliveryId, refspecs: [`${sourceRef}:${row.github_ref}`], expectedRemoteHead: '' });
	}
	const observed = await githubRepositoryHead(options.fetchImpl ?? fetch, credential.token, binding.owner, binding.name, row.github_ref);
	if (observed !== row.commit_sha) throw new Error('GitHub did not retain the exact TreeDX commit after push.');
	return { provider: 'github', repository: `${binding.owner}/${binding.name}`, ref: row.github_ref,
		commitSha: observed, verifiedAt: new Date().toISOString(), push: push ? { updatedRefs: push.updatedRefs ?? [] } : null };
}

async function replicateR2(options: any, row: any, connection: any, sourceRef: string) {
	const accountId = setting(options, 'TREESEED_CLOUDFLARE_ACCOUNT_ID');
	const bucket = setting(options, 'TREESEED_CONTENT_BUCKET_NAME');
	const accessKeyId = setting(options, 'TREESEED_R2_ACCESS_KEY_ID');
	const secretAccessKey = setting(options, 'TREESEED_R2_SECRET_ACCESS_KEY');
	if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
		throw new Error('R2 library mirroring requires the Cloudflare account, private team bucket, and scoped S3 credentials.');
	}
	const privacy = await verifyPrivateBucket(options, bucket);
	const client = new R2S3PublicationClient({ accountId, bucket, accessKeyId, secretAccessKey }, options.fetchImpl ?? fetch);
	const project: any = await options.controlPlaneStore.first('SELECT id,team_id,slug FROM projects WHERE id = ? LIMIT 1', [row.project_id]);
	if (!project || project.team_id !== row.team_id) throw new Error('R2 mirror project scope does not belong to the replication team.');
	const branch = setting(options, 'TREESEED_LIBRARY_BRANCH') || (setting(options, 'TREESEED_ENVIRONMENT') === 'production' ? 'main' : 'staging');
	const library: any = await options.controlPlaneStore.first(`SELECT content_repository_ref,topology_json FROM treedx_project_libraries
		WHERE team_id=? AND project_id=?`, [row.team_id, row.project_id]);
	const refsResponse: any = await connection.client.upstream.repositories.refs(connection.repositoryId);
	const availableRefs = Array.isArray(refsResponse?.refs) ? refsResponse.refs : [];
	const canonical = resolveCanonicalTreeDxRef(availableRefs, branch, library?.content_repository_ref);
	const canonicalRef = canonical.name, canonicalCommit = canonical.commit;
	if (canonicalCommit !== row.commit_sha) return { schemaVersion: TREE_DX_MIRROR_SKIPPED_SCHEMA,
		commitSha: row.commit_sha, sourceRef, canonicalRef, canonicalCommit: canonicalCommit || null,
		reason: 'non-canonical-commit', verifiedAt: new Date().toISOString() };
	const mirror = await mirrorTreeDxCommit({ client, connection, teamId: row.team_id, projectId: row.project_id,
		projectSlug: String(project.slug), repositoryId: row.repository_id, commitSha: row.commit_sha, sourceRef: canonicalRef });
	const now = new Date().toISOString();
	const topology = typeof library?.topology_json === 'string' ? JSON.parse(library.topology_json) : structuredClone(library?.topology_json ?? {});
	topology.contentRepository ??= {}; topology.contentRepository.r2 = { bucketName: bucket, manifestKey: mirror.manifestKey };
	await options.controlPlaneStore.run(`UPDATE treedx_project_libraries SET r2_bucket_name=?,r2_manifest_key=?,topology_json=?,updated_at=?
		WHERE team_id=? AND project_id=?`, [bucket, mirror.manifestKey, JSON.stringify(topology), now, row.team_id, row.project_id]);
	await options.controlPlaneStore.run(`UPDATE hub_content_sources SET r2_bucket_name=?,r2_manifest_key=?,latest_content_version=?,updated_at=?
		WHERE team_id=? AND hub_id=?`, [bucket, mirror.manifestKey, row.commit_sha, now, row.team_id, row.project_id]);
	return { provider: 'cloudflare-r2', bucket, privacy, ...mirror };
}

export function createTreeDxCommitReplicationExecutor(options: any) {
	return {
		namespace: 'treedx', operation: 'replicate_commit',
		async run(input: any, context: any) {
			const store = options.controlPlaneStore;
			if (!store) throw new Error('TreeDX commit replication requires a control-plane store.');
			const row: any = await store.first('SELECT * FROM treedx_commit_replications WHERE id = ?', [String(input?.replicationId ?? '')]);
			if (!row) throw new Error('TreeDX commit replication record was not found.');
			const priorR2 = typeof row.r2_receipt_json === 'string' ? JSON.parse(row.r2_receipt_json) : row.r2_receipt_json;
			if (row.status === 'complete' && priorR2?.schemaVersion === TREE_DX_MIRROR_SCHEMA
				&& isR2ReplicationReceipt(priorR2, row.commit_sha)) {
				return { replicationId: row.id, status: 'complete', replayed: true };
			}
			const now = new Date().toISOString();
			await store.run(`UPDATE treedx_commit_replications SET status='replicating', attempts=attempts+1,
				last_error=NULL, updated_at=? WHERE id=?`, [now, row.id]);
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: row.project_id,
				write: false, replicationRefs: [row.source_ref, `refs/treedx/commits/${row.commit_sha}`, row.commit_sha, row.github_ref] });
			if (!connection) throw new Error('The project TreeDX repository is unavailable.');
			const sourceRef = await resolveExactSourceRef(connection, row);
			let githubReceipt = row.github_receipt_json ?? {};
			let r2Receipt = row.r2_receipt_json ?? {};
			const failures: string[] = [];
			if (row.github_status !== 'verified') {
				await store.run("UPDATE treedx_commit_replications SET github_status='replicating',updated_at=? WHERE id=?", [new Date().toISOString(), row.id]);
				try {
					githubReceipt = await replicateGitHub(options, row, connection, context.operation.id, sourceRef);
					await store.run("UPDATE treedx_commit_replications SET github_status='verified',github_receipt_json=?,updated_at=? WHERE id=?",
						[JSON.stringify(githubReceipt), new Date().toISOString(), row.id]);
				} catch (error) {
					failures.push(`GitHub: ${error instanceof Error ? error.message : String(error)}`);
					await store.run("UPDATE treedx_commit_replications SET github_status='failed',updated_at=? WHERE id=?", [new Date().toISOString(), row.id]);
				}
			}
			if (row.r2_status !== 'verified' || priorR2?.schemaVersion !== TREE_DX_MIRROR_SCHEMA
				|| !isR2ReplicationReceipt(priorR2, row.commit_sha)) {
				await store.run("UPDATE treedx_commit_replications SET r2_status='replicating',updated_at=? WHERE id=?", [new Date().toISOString(), row.id]);
				try {
					r2Receipt = await replicateR2(options, row, connection, sourceRef);
					await store.run("UPDATE treedx_commit_replications SET r2_status='verified',r2_receipt_json=?,updated_at=? WHERE id=?",
						[JSON.stringify(r2Receipt), new Date().toISOString(), row.id]);
				} catch (error) {
					failures.push(`R2: ${error instanceof Error ? error.message : String(error)}`);
					await store.run("UPDATE treedx_commit_replications SET r2_status='failed',updated_at=? WHERE id=?", [new Date().toISOString(), row.id]);
				}
			}
			if (failures.length) {
				const configurationBlocked = failures.some((failure) => failure.includes('requires the Cloudflare account')
					|| failure.includes('management authority is required'));
				const retryDelay = configurationBlocked ? 3_600_000
					: Math.min(3_600_000, 15_000 * 2 ** Math.min(Number(row.attempts ?? 0), 8));
				const retryAt = new Date(Date.now() + retryDelay).toISOString();
				await store.run("UPDATE treedx_commit_replications SET status='degraded',last_error=?,next_attempt_at=?,updated_at=? WHERE id=?",
					[failures.join(' | '), retryAt, new Date().toISOString(), row.id]);
				throw new Error(failures.join(' | '));
			}
			const completedAt = new Date().toISOString();
			await store.run("UPDATE treedx_commit_replications SET status='complete',next_attempt_at=NULL,completed_at=?,updated_at=? WHERE id=?",
				[completedAt, completedAt, row.id]);
			await context.checkpoint({ phase: 'treedx.commit.replicated', replicationId: row.id, commitSha: row.commit_sha },
				{ kind: 'treedx.commit.replicated', data: { projectId: row.project_id, commitSha: row.commit_sha } });
			return { replicationId: row.id, status: 'complete', commitSha: row.commit_sha, github: githubReceipt, r2: r2Receipt };
		},
	};
}
