import { describe, expect, it } from 'vitest';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../../../../src/api/capacity/database.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { createAssignmentService } from '../../../../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';
import { closeoutDatabase } from './closeout-sql-fixture.ts';

const principal = { id: 'isolated-reader', roles: ['admin'] };
async function fixture() {
	const base = await closeoutDatabase();
	const repository = new ProviderAssignmentRepository(base.store as unknown as CapacityGovernanceDatabase);
	return { ...base, service: createAssignmentService({ ...base.store, listProviderAssignmentsPage: repository.list.bind(repository) }) };
}
// REAL original-DDL SQL/repository/service integration, not authenticated HTTP,
// complete canonical Attempts, live provider usage or PostgreSQL-server concurrency.
describe('complete assignment observation through actual SQL and public owning service', () => {
	it('reads every creation-ordered and identity-tied page including a failed tail with exact workday and team scope', async () => {
		const { db, query, service } = await fixture();
		try {
			await query('DELETE FROM capacity_provider_assignments');
			for (let index = 0; index < 52; index++) {
				const id = `assignment-${String(index).padStart(3, '0')}`;
				await query(`INSERT INTO capacity_provider_assignments
					(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,work_day_id,mode,status,created_at,updated_at)
					VALUES (?,'membership','team','project','provider','arbitrary-observer',?,'acting',?,?,?)`,
				[id, index === 51 ? 'other-workday' : 'workday', index === 0 ? 'failed' : 'completed',
					'2026-10-02T21:00:01.000Z', '2026-10-02T21:00:01.000Z']);
				await query('UPDATE capacity_provider_assignments SET capacity_envelope_json=? WHERE id=?',
					[JSON.stringify({ teamId: 'team', projectId: 'project', mode: 'acting' }), id]);
			}
			await query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,work_day_id,mode,status,created_at,updated_at)
				VALUES ('foreign','membership','foreign-team','project','provider','arbitrary-observer','workday','acting','failed',?,?)`,
			['2026-10-02T21:00:02.000Z', '2026-10-02T21:00:02.000Z']);
			await query('UPDATE capacity_provider_assignments SET capacity_envelope_json=? WHERE id=?',
				[JSON.stringify({ teamId: 'foreign-team', projectId: 'project', mode: 'acting' }), 'foreign']);
			const before = await query('SELECT * FROM capacity_provider_assignments ORDER BY id');
			const first: CapacityPage<ProviderAssignment> = await service.list(principal, 'team', { limit: 50, workdayId: 'workday' });
			expect(first.items.map(value => value.id)).toEqual(Array.from({ length: 50 }, (_, index) => `assignment-${String(50 - index).padStart(3, '0')}`));
			expect(first.items.every(value => value.workDayId === 'workday' && value.teamId === 'team' && value.executionMode === 'simulation')).toBe(true);
			expect(first.page).toMatchObject({ limit: 50, hasMore: true });
			expect(decodeCapacityPageCursor(first.page.nextCursor)).toEqual({ id: 'assignment-001', createdAt: '2026-10-02T21:00:01.000Z' });
			const tail: CapacityPage<ProviderAssignment> = await service.list(principal, 'team', { limit: 50, workdayId: 'workday', cursor: first.page.nextCursor });
			expect(tail.items.map(value => ({ id: value.id, status: value.status }))).toEqual([{ id: 'assignment-000', status: 'failed' }]);
			expect(tail.page).toEqual({ limit: 50, hasMore: false, nextCursor: null });
			expect(await Promise.all([service.list(principal, 'team', { limit: 50, workdayId: 'workday' }),
				service.list(principal, 'team', { limit: 50, workdayId: 'workday', cursor: first.page.nextCursor })])).toEqual([first, tail]);
			expect(await query('SELECT * FROM capacity_provider_assignments ORDER BY id')).toEqual(before);
		} finally { await db.close(); }
	});
	it('returns explicit empty terminal authority and denies unauthenticated or invalid cursor and page requests', async () => {
		const { db, service } = await fixture();
		try {
			expect(await service.list(principal, 'team', { workdayId: 'absent' })).toEqual({ items: [], page: { limit: 50, hasMore: false, nextCursor: null } });
			await expect(service.list(undefined, 'team', {})).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
			for (const query of [{ cursor: 'invalid' }, { limit: 0 }, { limit: 201 }, { limit: 'invalid' }]) {
				await expect(service.list(principal, 'team', query)).rejects.toMatchObject({ status: 400, code: 'capacity_page_invalid' });
			}
		} finally { await db.close(); }
	});
});
