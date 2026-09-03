import { describe, expect, it } from 'vitest';
import { enqueueTreeDxCommitReplication } from '../../../../src/api/capacity/services/treedx/repositories/treedx-commit-replication.ts';
import { TreeDxCommitReplicationScheduler } from '../../../../src/operations-runner/treedx/commit-replication-scheduler.ts';

describe('TreeDX commit replication outbox', () => {
	it('records deterministic immutable destinations before queueing work', async () => {
		const runs: Array<{ query: string; params?: unknown[] }> = [];
		const operations: any[] = [];
		const store: any = {
			async first(query: string) {
				if (query.includes('treedx_project_libraries')) return { repository_id: 'repo_sdk' };
				return null;
			},
			async run(query: string, params?: unknown[]) { runs.push({ query, params }); },
			async createPlatformOperation(input: any) { operations.push(input); return { id: 'operation' }; },
		};
		const commitSha = 'a'.repeat(40);
		const result = await enqueueTreeDxCommitReplication(store, {
			teamId: 'team', projectId: 'sdk', commitSha, createdAt: '2026-08-29T00:00:00.000Z',
		});
		expect(result.sourceRef).toBe(`refs/treedx/commits/${commitSha}`);
		expect(result.githubRef).toBe(`refs/heads/treedx-backups/${commitSha}`);
		expect(result.r2ObjectKey).toBe('_treeseed/mirrors/teams/team/projects/sdk/manifest.json');
		expect(runs[0]?.query).toContain('INSERT INTO treedx_commit_replications');
		expect(operations[0]).toMatchObject({ namespace: 'treedx', operation: 'replicate_commit',
			idempotencyKey: result.id, input: { replicationId: result.id } });
	});

	it('requeues retryable failed operations without duplicating them', async () => {
		const retried: string[] = [];
		const store: any = {
			async all(query: string) {
				if (query.includes('treedx_project_libraries')) return [];
				return [{ id: 'replication', operation_id: 'operation', operation_status: 'failed' }];
			},
			async retryPlatformOperation(id: string) { retried.push(id); },
		};
		const result = await new TreeDxCommitReplicationScheduler(store, 1).runIfDue(Date.parse('2026-08-29T00:00:00.000Z'));
		expect(result).toMatchObject({ scheduled: true, queued: 1 });
		expect(retried).toEqual(['operation']);
	});

	it('requeues completed archive operations so they are upgraded to file mirrors', async () => {
		const retried: string[] = [];
		const store: any = {
			async all(query: string) {
				if (query.includes('treedx_project_libraries')) return [];
				expect(query).toContain('treeseed.treedx-r2-file-mirror/v2');
				return [{ id: 'replication', operation_id: 'operation', operation_status: 'succeeded',
					commit_sha: 'a'.repeat(40), r2_receipt_json: { objectKey: 'old.tar.zst' } }];
			},
			async retryPlatformOperation(id: string) { retried.push(id); },
		};
		const result = await new TreeDxCommitReplicationScheduler(store, 1).runIfDue(Date.parse('2026-08-29T00:00:00.000Z'));
		expect(result).toMatchObject({ scheduled: true, queued: 1 });
		expect(retried).toEqual(['operation']);
	});

	it('periodically requeues canonical file mirrors so bucket resets are repaired', async () => {
		const retried: string[] = [];
		const runs: Array<{ query: string; params?: unknown[] }> = [];
		const store: any = {
			async run(query: string, params?: unknown[]) { runs.push({ query, params }); },
			async all(query: string, params?: unknown[]) {
				if (query.includes('treedx_project_libraries')) return [];
				expect(query).toContain("r.source_ref IN (?,?)");
				expect(query).toContain("ORDER BY CASE WHEN r.status IN ('pending','degraded','replicating')");
				expect(query).toContain('NOT EXISTS (SELECT 1 FROM treedx_commit_replications newer');
				expect(params).toContain('2026-08-28T23:55:00.000Z');
				return [{ id: 'canonical', operation_id: 'operation', operation_status: 'succeeded' }];
			},
			async retryPlatformOperation(id: string) { retried.push(id); },
		};
		const result = await new TreeDxCommitReplicationScheduler(store, 1).runIfDue(Date.parse('2026-08-29T00:00:00.000Z'));
		expect(result).toMatchObject({ scheduled: true, queued: 1 });
		expect(retried).toEqual(['operation']);
		expect(runs[0]?.query).toContain("status='cancelled'");
		expect(runs[0]?.params?.[0]).toContain('superseded_canonical_replication');
	});
});
