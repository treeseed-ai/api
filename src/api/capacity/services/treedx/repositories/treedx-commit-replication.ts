import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../../database.ts';

const replicationId = (projectId: string, commitSha: string) =>
	`treedx-replication:${createHash('sha256').update(`${projectId}:${commitSha}`).digest('hex')}`;

export async function enqueueTreeDxCommitReplication(database: CapacityGovernanceDatabase, input: {
	teamId: string;
	projectId: string;
	commitSha: string;
	createdAt: string;
	sourceRef?: string;
}) {
	const library = await database.first<{ repository_id?: string | null }>(
		'SELECT repository_id FROM treedx_project_libraries WHERE project_id = ? LIMIT 1', [input.projectId],
	);
	const repositoryId = String(library?.repository_id ?? '').trim();
	if (!repositoryId) throw new Error(`Project ${input.projectId} has no TreeDX repository to replicate.`);
	const id = replicationId(input.projectId, input.commitSha);
	const sourceRef = input.sourceRef ?? `refs/treedx/commits/${input.commitSha}`;
	const githubRef = `refs/heads/treedx-backups/${input.commitSha}`;
	const r2ObjectKey = `_treeseed/mirrors/teams/${input.teamId}/projects/${input.projectId}/manifest.json`;
	await database.run(`INSERT INTO treedx_commit_replications
		(id,team_id,project_id,repository_id,commit_sha,source_ref,github_ref,r2_object_key,status,github_status,r2_status,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?, 'pending','pending','pending',?,?) ON CONFLICT(project_id,commit_sha) DO UPDATE SET
			source_ref=CASE WHEN excluded.source_ref LIKE 'refs/heads/%' OR excluded.source_ref LIKE 'refs/remotes/origin/%'
				THEN excluded.source_ref ELSE treedx_commit_replications.source_ref END,
			status=CASE WHEN CAST(treedx_commit_replications.r2_receipt_json AS TEXT) LIKE '%treeseed.treedx-r2-file-mirror-skipped/v1%'
				AND (excluded.source_ref LIKE 'refs/heads/%' OR excluded.source_ref LIKE 'refs/remotes/origin/%')
				THEN 'pending' ELSE treedx_commit_replications.status END,
			r2_status=CASE WHEN CAST(treedx_commit_replications.r2_receipt_json AS TEXT) LIKE '%treeseed.treedx-r2-file-mirror-skipped/v1%'
				AND (excluded.source_ref LIKE 'refs/heads/%' OR excluded.source_ref LIKE 'refs/remotes/origin/%')
				THEN 'pending' ELSE treedx_commit_replications.r2_status END,
			updated_at=excluded.updated_at`, [
		id, input.teamId, input.projectId, repositoryId, input.commitSha, sourceRef, githubRef, r2ObjectKey,
		input.createdAt, input.createdAt,
	]);
	const operationStore = database as CapacityGovernanceDatabase & { createPlatformOperation?: (value: unknown) => Promise<unknown> };
	if (operationStore.createPlatformOperation) {
		await operationStore.createPlatformOperation({
			namespace: 'treedx', operation: 'replicate_commit', target: 'control_plane_operations_runner',
			idempotencyKey: id, input: { replicationId: id }, requestedByType: 'service',
			requestedById: 'treedx-commit-projector',
		});
	}
	return { id, sourceRef, githubRef, r2ObjectKey };
}
