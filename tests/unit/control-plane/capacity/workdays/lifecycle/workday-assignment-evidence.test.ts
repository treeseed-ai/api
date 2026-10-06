import { describe, expect, it, vi } from 'vitest';
import { CapacityWorkdayRecoveryRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-recovery.ts';

const assignmentId = 'assignment-1';
const result = {
	schemaVersion: 'treeseed.assignment-result/v1', id: 'result-1', assignmentId,
	status: 'completed', summary: 'Published one exact reference.',
	references: [{ kind: 'treedx', projectId: 'project', repository: 'library',
		commit: 'a'.repeat(40), path: 'knowledge/result.mdx' }],
	verification: [], usage: { elapsedSeconds: 12 }, diagnostics: [], completedAt: '2026-09-20T12:00:00.000Z',
};

describe('workday assignment-result evidence', () => {
	it('reads canonical results and content-integration audits without mode-run records', async () => {
		const all = vi.fn(async (sql: string) => sql.includes('FROM capacity_provider_assignments')
			? [{ id: assignmentId, assignment_result_json: JSON.stringify(result) }]
			: [{ id: 'audit-1', target_id: assignmentId, event_type: 'assignment.content.integrated' }]);
		const repository = new CapacityWorkdayRecoveryRepository({ ensureInitialized: vi.fn(), all } as never);
		expect(await repository.assignmentEvidence('team', 'workday')).toMatchObject({
			contentArtifactCount: 1, requiredContentOutcomeAssignments: 1,
			integratedContentOutcomeAssignments: 1, unresolvedContentOutcomeAssignments: 0,
		});
		expect(all.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('agent_mode_runs');
	});

	it('rejects a completed assignment missing its immutable result', async () => {
		const repository = new CapacityWorkdayRecoveryRepository({ ensureInitialized: vi.fn(),
			all: vi.fn(async () => [{ id: assignmentId, assignment_result_json: null }]) } as never);
		await expect(repository.assignmentEvidence('team', 'workday')).rejects.toMatchObject({
			code: 'capacity_durable_json_invalid',
		});
	});
});
