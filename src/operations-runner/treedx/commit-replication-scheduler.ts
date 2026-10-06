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
			try {
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
			} catch {
				// One stale or unavailable binding must not prevent canonical mirrors
				// for every other team/project from being discovered and queued.
				continue;
			}
		}
		return discovered;
	}

	async runIfDue(time = Date.now()) {
		if (time - this.lastAttemptAt < this.intervalMs) return { scheduled: false };
		this.lastAttemptAt = time;
		const now = new Date(time).toISOString();
		const verificationBefore = new Date(time - 5 * 60_000).toISOString();
		// A moving branch name can appear on many historical outbox rows. Once a
		// newer row exists for the same project, an older queued branch operation
		// can no longer be the canonical mirror. Cancel those inherited queue rows
		// in one pass so reset recovery is not starved by obsolete exact commits.
		if (typeof this.store.run === 'function') {
			await this.store.run(`UPDATE platform_operations SET status='cancelled',lease_expires_at=NULL,
				error_json=?,finished_at=COALESCE(finished_at,?),updated_at=?
				WHERE namespace='treedx' AND operation='replicate_commit' AND status='queued'
				AND EXISTS (SELECT 1 FROM treedx_commit_replications stale
					WHERE stale.id=platform_operations.idempotency_key AND stale.source_ref IN (?,?)
					AND EXISTS (SELECT 1 FROM treedx_commit_replications newer
						WHERE newer.project_id=stale.project_id AND newer.source_ref IN (?,?)
						AND (newer.created_at>stale.created_at OR (newer.created_at=stale.created_at AND newer.id>stale.id))))`,
				[JSON.stringify({ code: 'superseded_canonical_replication', message: 'A newer canonical TreeDX commit superseded this queued mirror operation.' }),
					now, now, this.canonicalRef, this.canonicalRemoteRef, this.canonicalRef, this.canonicalRemoteRef]);
		}
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
					AND CAST(r.r2_receipt_json AS TEXT) NOT LIKE '%treeseed.treedx-r2-file-mirror-skipped/v1%')
				OR (r.status='complete' AND r.source_ref IN (?,?) AND r.updated_at <= ?
					AND NOT EXISTS (SELECT 1 FROM treedx_commit_replications newer
						WHERE newer.project_id=r.project_id AND newer.source_ref IN (?,?)
						AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.id>r.id)))
					AND CAST(r.r2_receipt_json AS TEXT) LIKE '%treeseed.treedx-r2-file-mirror/v2%'))
			AND NOT (r.source_ref IN (?,?) AND EXISTS (SELECT 1 FROM treedx_commit_replications newer
				WHERE newer.project_id=r.project_id AND newer.source_ref IN (?,?)
				AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.id>r.id))))
			ORDER BY CASE WHEN r.status IN ('pending','degraded','replicating') THEN 0 ELSE 1 END,
				CASE WHEN r.source_ref=? THEN 0 WHEN r.source_ref=? THEN 1 ELSE 2 END,r.created_at DESC LIMIT 10`,
			[now, this.canonicalRef, this.canonicalRemoteRef, verificationBefore, this.canonicalRef, this.canonicalRemoteRef,
				this.canonicalRef, this.canonicalRemoteRef, this.canonicalRef, this.canonicalRemoteRef,
				this.canonicalRef, this.canonicalRemoteRef]);
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
