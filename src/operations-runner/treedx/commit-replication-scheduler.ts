import { enqueueTreeDxCommitReplication } from '../../api/capacity/services/treedx/repositories/treedx-commit-replication.ts';
import { resolveKnowledgeGatewayConnection } from '../../api/knowledge/gateway-treedx-connection.ts';

function refs(value: unknown) {
	const result = value && typeof value === 'object' && !Array.isArray(value) ? (value as any).refs : null;
	return Array.isArray(result) ? result : [];
}

export class TreeDxCommitReplicationScheduler {
	private lastAttemptAt = 0;
	private backfilled = false;
	private readonly canonicalRef: string;
	private readonly canonicalRemoteRef: string;

	constructor(private readonly store: any, private readonly intervalMs = 15_000,
		branch = process.env.TREESEED_LIBRARY_BRANCH
			|| (process.env.TREESEED_ENVIRONMENT === 'production' ? 'main' : 'staging')) {
		this.canonicalRef = `refs/heads/${branch}`;
		this.canonicalRemoteRef = `refs/remotes/origin/${branch}`;
	}

	private async backfillHeadsAndPreservedCommits(now: string) {
		const libraries: any[] = await this.store.all(`SELECT team_id,project_id,repository_id FROM treedx_project_libraries
			WHERE repository_id IS NOT NULL ORDER BY project_id`);
		let discovered = 0;
		for (const library of libraries) {
			const connection = await resolveKnowledgeGatewayConnection(this.store, { projectId: library.project_id, write: false });
			if (!connection) continue;
			const response = await connection.client.upstream.repositories.refs(connection.repositoryId);
			const candidates = refs(response).filter((ref: any) => String(ref.name ?? '').startsWith('refs/heads/')
				|| String(ref.name ?? '').startsWith('refs/treedx/commits/') || String(ref.name ?? '') === this.canonicalRemoteRef);
			const byCommit = new Map<string, string>();
			for (const ref of candidates) {
				const commitSha = String(ref.target ?? ref.sha ?? '');
				if (!/^[a-f0-9]{40}$/u.test(commitSha)) continue;
				const name = String(ref.name);
				const current = byCommit.get(commitSha);
				const rank = (value: string) => value === this.canonicalRef ? 0 : value === this.canonicalRemoteRef ? 1
					: value.startsWith('refs/heads/') ? 2 : 3;
				if (!current || rank(name) < rank(current)) byCommit.set(commitSha, name);
			}
			for (const [commitSha, sourceRef] of byCommit) {
				await enqueueTreeDxCommitReplication(this.store, { teamId: library.team_id, projectId: library.project_id,
					commitSha, sourceRef, createdAt: now });
				discovered += 1;
			}
		}
		return discovered;
	}

	async runIfDue(time = Date.now()) {
		if (time - this.lastAttemptAt < this.intervalMs) return { scheduled: false };
		this.lastAttemptAt = time;
		const now = new Date(time).toISOString();
		let discovered = 0;
		if (!this.backfilled) {
			discovered = await this.backfillHeadsAndPreservedCommits(now);
			this.backfilled = true;
		}
		const rows: any[] = await this.store.all(`SELECT r.id,r.commit_sha,r.r2_receipt_json,p.id AS operation_id,p.status AS operation_status
			FROM treedx_commit_replications r LEFT JOIN platform_operations p
			ON p.namespace='treedx' AND p.operation='replicate_commit' AND p.idempotency_key=r.id
			WHERE ((r.status IN ('pending','degraded') AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?))
				OR (r.status='replicating' AND p.status IN ('failed','cancelled'))
				OR (r.status='complete' AND CAST(r.r2_receipt_json AS TEXT) NOT LIKE '%treeseed.treedx-r2-file-mirror/v2%'
					AND CAST(r.r2_receipt_json AS TEXT) NOT LIKE '%treeseed.treedx-r2-file-mirror-skipped/v1%'))
			AND (r.status IN ('pending','complete') OR NOT EXISTS (SELECT 1 FROM treedx_commit_replications pending WHERE pending.status='pending'))
			ORDER BY CASE WHEN r.source_ref=? THEN 0 WHEN r.source_ref=? THEN 1 ELSE 2 END,r.created_at DESC LIMIT 10`,
			[now, this.canonicalRef, this.canonicalRemoteRef]);
		let queued = 0;
		for (const row of rows) {
			if (!row.operation_id) {
				await this.store.createPlatformOperation({ namespace: 'treedx', operation: 'replicate_commit',
					target: 'control_plane_operations_runner', idempotencyKey: row.id, input: { replicationId: row.id },
					requestedByType: 'service', requestedById: 'treedx-commit-replication-scheduler' });
				queued += 1;
			} else if (!['queued', 'leased', 'running'].includes(row.operation_status)) {
				await this.store.retryPlatformOperation(row.operation_id);
				queued += 1;
			}
		}
		return { scheduled: true, discovered, queued };
	}
}
