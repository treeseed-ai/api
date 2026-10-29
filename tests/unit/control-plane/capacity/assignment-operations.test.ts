import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createAssignmentOperations } from '../../../../src/api/control-plane/catalog/capacity/assignments.ts';
import { createAssignmentService } from '../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from './execution/fixtures/assignment.ts';
import { completedPlanningRow } from '../providers/assignments/planning/completed-assignment-row.ts';
import { serializeProviderAssignmentRow } from '../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

const principal = { id: 'user-1' };
describe('assignment catalog operations', () => {
	it('explains the same fully serialized completed planning row used by native integration', async () => {
		const attempt = assignmentAttemptSchema.parse({ ...original, status: 'completed',
			effectiveProfile: { ...original.effectiveProfile, activity: 'planning' } });
		const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'result',
			assignmentId: attempt.id, status: 'completed', summary: 'Controlled planning product, not a live result.',
			references: [], verification: [], diagnostics: [], usage: { elapsedSeconds: 0 }, completedAt: attempt.createdAt });
		const row = completedPlanningRow(attempt, result, 'project/planner');
		expect(serializeProviderAssignmentRow(row)).toMatchObject({ assignmentAttempt: attempt, assignmentResult: result });
		const planningAdmissions = [{ proposalId: 'proposal', disposition: 'not_adopted', reason: 'source_advanced' }];
		const store = { ensureInitialized: async () => {}, first: vi.fn(async (sql: string) =>
			sql.includes('FROM capacity_provider_assignments') ? row : { data_json: JSON.stringify({ planningAdmissions }) }) };
		expect(await createAssignmentService(store).explain({ id: 'operator', roles: ['admin'] }, 'team', attempt.id))
			.toMatchObject({ metadata: { planningAdmissions } });
	});

	it('binds only the six operator assignment operations including explicit unresolved recovery', () => {
		const assignments = Object.fromEntries(['recover', 'list', 'show', 'explain', 'cancel', 'retry'].map((name) => [name, vi.fn()])) as any;
		expect(createAssignmentOperations({ assignments }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.assignments.recover,
			CONTROL_PLANE_OPERATIONS.assignments.list, CONTROL_PLANE_OPERATIONS.assignments.show,
			CONTROL_PLANE_OPERATIONS.assignments.explain, CONTROL_PLANE_OPERATIONS.assignments.cancel,
			CONTROL_PLANE_OPERATIONS.assignments.retry,
		]);
	});

	it('passes API-derived actor and idempotency evidence to cancellation', async () => {
		const store = { principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['teams:manage:team'] })),
			cancelCapacityAssignment: vi.fn(async (_teamId, _assignmentId, input) => input) };
		await expect(createAssignmentService(store).cancel(principal, 'team-1', 'assignment-1', { reason: 'operator' }, 'cancel-1'))
			.resolves.toMatchObject({ reason: 'operator', actorId: 'user-1', idempotencyKey: 'cancel-1' });
	});
});
