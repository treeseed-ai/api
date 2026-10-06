import { resolveKnowledgeGatewayConnection } from '../../api/knowledge/gateway-treedx-connection.ts';
import { withLibraryStorage } from '../../security/library-storage.ts';
import { isR2ReplicationReceipt, mirrorTreeDxCommit, resolveCanonicalTreeDxRef, TREE_DX_MIRROR_SCHEMA, TREE_DX_MIRROR_SKIPPED_SCHEMA } from './r2-file-mirror.ts';
import { markManagedTeamLibraryMirrorKnownGood } from '../../api/teams/managed-team-library-service.ts';

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

async function replicateR2(options: any, row: any, connection: any, sourceRef: string) {
	const project: any = await options.controlPlaneStore.first('SELECT id,team_id,slug FROM projects WHERE id = ? LIMIT 1', [row.project_id]);
	if (!project || project.team_id !== row.team_id) throw new Error('R2 mirror project scope does not belong to the replication team.');
	return withLibraryStorage(options.controlPlaneStore, { ...process.env, ...options.config }, async ({ client, bucket, branch, privacy }) => {
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
	}, { fetchImpl: options.fetchImpl });
}

async function retainedR2MirrorExists(options: any, receipt: any, row: any) {
	if (receipt?.schemaVersion !== TREE_DX_MIRROR_SCHEMA || typeof receipt?.manifestKey !== 'string') return false;
	const key = `_treeseed/mirrors/teams/${encodeURIComponent(row.team_id)}/projects/${encodeURIComponent(row.project_id)}/manifest.json`;
	if (receipt.manifestKey !== key) return false;
	return withLibraryStorage(options.controlPlaneStore, { ...process.env, ...options.config }, async ({ client, bucket }) =>
		receipt.bucket === bucket && await client.exists(key), { fetchImpl: options.fetchImpl });
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
			const retainedR2Available = row.status === 'complete' && priorR2?.schemaVersion === TREE_DX_MIRROR_SCHEMA
				&& isR2ReplicationReceipt(priorR2, row.commit_sha) && await retainedR2MirrorExists(options, priorR2, row);
			if (retainedR2Available) {
				await store.run('UPDATE treedx_commit_replications SET updated_at=? WHERE id=?', [new Date().toISOString(), row.id]);
				return { replicationId: row.id, status: 'complete', replayed: true };
			}
			const now = new Date().toISOString();
			await store.run(`UPDATE treedx_commit_replications SET status='replicating', attempts=attempts+1,
				last_error=NULL, updated_at=? WHERE id=?`, [now, row.id]);
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: row.project_id,
				write: false, replicationRefs: [row.source_ref, `refs/treedx/commits/${row.commit_sha}`, row.commit_sha] });
			if (!connection) throw new Error('The project TreeDX repository is unavailable.');
			let sourceRef: string;
			try { sourceRef = await resolveExactSourceRef(connection, row); }
			catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// Publication can advance the external staging ref just before the
				// managed TreeDX ref listing observes it. This is transient drift, not
				// a reason to leave the canonical R2 mirror stale for a full day.
				const retryAt = new Date(Date.now() + 15_000).toISOString();
				await store.run("UPDATE treedx_commit_replications SET status='degraded',last_error=?,next_attempt_at=?,updated_at=? WHERE id=?",
					[message, retryAt, new Date().toISOString(), row.id]);
				throw error;
			}
			let r2Receipt = row.r2_receipt_json ?? {};
			const failures: string[] = [];
			if (!retainedR2Available || row.r2_status !== 'verified' || priorR2?.schemaVersion !== TREE_DX_MIRROR_SCHEMA
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
				const configurationBlocked = failures.some((failure) => failure.includes('Site library storage'));
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
			await markManagedTeamLibraryMirrorKnownGood(store,{teamId:row.team_id,projectId:row.project_id,
				commitSha:row.commit_sha,r2Receipt});
			await context.checkpoint({ phase: 'treedx.commit.replicated', replicationId: row.id, commitSha: row.commit_sha },
				{ kind: 'treedx.commit.replicated', data: { projectId: row.project_id, commitSha: row.commit_sha } });
			return { replicationId: row.id, status: 'complete', commitSha: row.commit_sha, r2: r2Receipt };
		},
	};
}
