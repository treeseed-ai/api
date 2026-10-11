import { describe, expect, it } from 'vitest';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { verifyNativeInventory, verifyNativeAssignmentReadback } from '../../../../../acceptance/execution-inventory.ts';
import { assignment } from '../fixtures/assignment.ts';

const clock = '2026-10-09T12:00:00.000Z';
const native = [{ id: 'first', created_at: clock }, { id: 'second', created_at: clock }];
const rows = [{ id: 'second', createdAt: clock, retained: 'actual second' }, { id: 'first', createdAt: clock, retained: 'actual first' }];
const cursor = encodeCapacityPageCursor({ id: 'second', createdAt: clock });
const pages = [{ items: [rows[0]], page: { limit: 1, hasMore: true, nextCursor: cursor } },
	{ items: [rows[1]], page: { limit: 1, hasMore: false, nextCursor: null } }];
const scope = { id: assignment.workdayId, teamId: assignment.teamId };
const nativeAssignment = { id: assignment.id, team_id: assignment.teamId, project_id: assignment.projectId,
	work_day_id: assignment.workdayId, membership_id: 'membership', capacity_provider_id: assignment.provider.providerId,
	status: 'pending', lease_state: 'unleased', reservation_id: assignment.reservationId, execution_kind: 'workday',
	project_agent_class_id: 'class',
	execution_node_id: assignment.nodeId, execution_node_revision: assignment.nodeRevision, graph_revision: assignment.graphRevision,
	assignment_attempt_json: JSON.stringify(assignment), assignment_result_json: null };
const publicAssignment = { id: assignment.id, teamId: assignment.teamId, projectId: assignment.projectId,
	workDayId: assignment.workdayId, membershipId: 'membership', capacityProviderId: assignment.provider.providerId,
	status: 'pending', leaseState: 'unleased', reservationId: assignment.reservationId, assignmentAttempt: assignment, assignmentResult: null,
	projectAgentClassId: 'class',
	executionNodeId: assignment.nodeId, executionNodeRevision: assignment.nodeRevision, graphRevision: assignment.graphRevision };
const nativeReservation = { id: assignment.reservationId, assignment_id: assignment.id, team_id: assignment.teamId,
	project_id: assignment.projectId, work_day_id: assignment.workdayId, membership_id: 'membership',
	capacity_provider_id: assignment.provider.providerId, execution_provider_id: assignment.provider.executionProviderId,
	reserved_seconds: assignment.limits.maximumSeconds, state: 'reserved', mode: 'acting', idempotency_key: assignment.idempotencyKey,
	project_agent_class_id: 'class', policy_snapshot_json: '{}', metadata_json: '{}',
	requested_seconds: assignment.limits.maximumSeconds, active_seconds: 0, elapsed_seconds: 0, released_seconds: 0, overrun_seconds: 0,
	created_at: assignment.createdAt, updated_at: assignment.createdAt };

describe('independent native producer inventory reconciliation', () => {
	it('reads exactly every native identity through complete public pages without changing original observations', async () => {
		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [nativeReservation])).toEqual(assignment);
		const retainedAssignment = structuredClone({ nativeAssignment, publicAssignment, nativeReservation });
		for (const state of ['reserved', 'consuming', 'consumed', 'released', 'expired', 'failed', 'overran_pending_approval', 'continuation_required'])
			expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [{ ...nativeReservation, state }])).toEqual(assignment);
		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [{ ...nativeReservation, reserved_seconds: '3' }])).toEqual(assignment);
		const unrelated = { ...nativeReservation, id: 'another-reservation', assignment_id: 'another-assignment' };
		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [unrelated, nativeReservation])).toEqual(assignment);
		expect({ nativeAssignment, publicAssignment, nativeReservation }).toEqual(retainedAssignment);
		const supplied = structuredClone(native), received = structuredClone(pages), calls: Array<string | undefined> = [];
		expect(await verifyNativeInventory(supplied, value => { calls.push(value); return received[calls.length - 1]; }, 1)).toEqual(rows);
		expect(calls).toEqual([undefined, cursor]); expect(supplied).toEqual(native); expect(received).toEqual(pages);
		expect(await verifyNativeInventory([], () => ({ items: [], page: { limit: 1, hasMore: false, nextCursor: null } }), 1)).toEqual([]);
		expect(await verifyNativeInventory(native, () => ({ items: rows, page: { limit: 200, hasMore: false, nextCursor: null } }), 200)).toEqual(rows);
		const ascending = [...rows].reverse(), next = encodeCapacityPageCursor({ id: 'first', createdAt: clock }); let index = 0;
		expect(await verifyNativeInventory(native, () => ({ items: [ascending[index++]], page: { limit: 1, hasMore: index < 2, nextCursor: index < 2 ? next : null } }), 1, 'ascending')).toEqual(ascending);
	});
	it('denies malformed missing duplicated reordered foreign truncated or interrupted public inventories without repairing failed pages', async () => {
		const before = structuredClone({ nativeAssignment, publicAssignment });
		expect(() => Reflect.apply(verifyNativeAssignmentReadback, undefined,
			[nativeAssignment, publicAssignment, scope, [], []])).toThrow('ACCEPTANCE_NATIVE_RESERVATION');
		expect({ nativeAssignment, publicAssignment }).toEqual(before);
		for (const supplied of [undefined, null, {}, [], [null], [[]], ['malformed'], [nativeReservation, nativeReservation],
			[{ ...nativeReservation, id: 'foreign', assignment_id: 'foreign' }],
			[nativeReservation, { ...nativeReservation, id: 'duplicate-assignment-reservation' }]]) {
			const original = structuredClone(supplied);
			expect(() => Reflect.apply(verifyNativeAssignmentReadback, undefined, [nativeAssignment, publicAssignment, scope, supplied])).toThrow();
			expect(supplied).toEqual(original);
		}
		for (const field of Object.keys(nativeReservation)) for (const invalid of [undefined, null, '', false, {}, [], 'foreign']) {
			const changed = structuredClone(nativeReservation); Reflect.set(changed, field, invalid); const original = structuredClone(changed);
			const validOpaque = ['metadata_json', 'policy_snapshot_json'].includes(field) && invalid && typeof invalid === 'object' && !Array.isArray(invalid);
			const observe = () => verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [changed]);
			if (validOpaque) expect.soft(observe).not.toThrow();
			else expect.soft(observe, `${field}=${JSON.stringify(invalid)}`).toThrow();
			expect(changed).toEqual(original);
		}
		for (const field of ['requested_seconds', 'reserved_seconds', 'active_seconds', 'elapsed_seconds', 'released_seconds', 'overrun_seconds'])
			for (const invalid of [-1, NaN, Infinity, -Infinity, 'NaN', 'Infinity', '0x3']) {
				const changed = structuredClone(nativeReservation); Reflect.set(changed, field, invalid);
				expect(() => verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [changed])).toThrow();
			}
		expect(() => verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope,
			[{ ...nativeReservation, updated_at: '2026-09-13T11:00:00.000Z' }])).toThrow('ACCEPTANCE_NATIVE_RESERVATION');
		for (const [originalNative, originalPublic, fields] of [
			[nativeAssignment, publicAssignment, ['reservation_id', 'capacity_provider_id', 'project_id', 'work_day_id', 'membership_id', 'project_agent_class_id', 'lease_state', 'execution_node_id', 'execution_node_revision', 'graph_revision']],
			[publicAssignment, nativeAssignment, ['reservationId', 'projectId', 'projectAgentClassId', 'leaseState', 'executionNodeId', 'executionNodeRevision', 'graphRevision']],
		] as const) for (const field of fields) for (const invalid of [undefined, null, '', false, {}, [], 'foreign', 0]) {
			const changed = structuredClone(originalNative); Reflect.set(changed, field, invalid); const held = structuredClone(changed);
			expect.soft(() => field.includes('_') ? verifyNativeAssignmentReadback(changed, originalPublic, scope, [nativeReservation])
				: verifyNativeAssignmentReadback(originalPublic, changed, scope, [nativeReservation])).toThrow();
			expect(changed).toEqual(held);
		}
		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [nativeReservation])).toEqual(assignment);
		for (const replacement of [undefined, null, {}, { items: rows }, { ...pages[0], items: null }, { ...pages[0], page: [] },
			{ ...pages[0], items: [null] }, { ...pages[0], items: [[]] }, { ...pages[0], items: ['malformed'] }, { items: [], page: pages[0]!.page },
			{ ...pages[0], items: [rows[1]] }, { ...pages[0], items: [rows[0], rows[0]] },
			{ ...pages[0], items: [{ ...rows[0], id: 'foreign' }] }, { ...pages[0], items: [{ ...rows[0], createdAt: '2026-10-09T11:00:00.000Z' }] },
			{ ...pages[0], page: { limit: 0, hasMore: true, nextCursor: cursor } },
			{ ...pages[0], page: { limit: '1', hasMore: true, nextCursor: cursor } }, { ...pages[0], page: { limit: 1, hasMore: 'true', nextCursor: cursor } },
			{ ...pages[0], page: { limit: 1, hasMore: false, nextCursor: null } },
			{ ...pages[0], page: { limit: 1, hasMore: true, nextCursor: null } },
			{ ...pages[0], page: { limit: 1, hasMore: true, nextCursor: 'malformed' } },
			{ ...pages[0], page: { limit: 1, hasMore: true, nextCursor: encodeCapacityPageCursor({ id: 'first', createdAt: clock }) } },
		]) {
			const retained = structuredClone(replacement);
			await expect(verifyNativeInventory(native, () => replacement, 1)).rejects.toThrow(); expect(replacement).toEqual(retained);
		}
		for (const tail of [undefined, { ...pages[1], items: [rows[0]] }, { ...pages[1], page: { limit: 1, hasMore: false, nextCursor: cursor } }]) {
			let index = 0; const received = [pages[0], tail], before = structuredClone(received);
			await expect(verifyNativeInventory(native, () => received[index++], 1)).rejects.toThrow(); expect(received).toEqual(before);
		}
		for (const original of [new Error('original public boundary interruption'), Object.assign(new Error('original permission denial'), { status: 403 }), new DOMException('original cancellation', 'AbortError')]) {
			let index = 0;
			await expect(verifyNativeInventory(native, () => index++ ? Promise.reject(original) : pages[0], 1)).rejects.toBe(original);
		}
	});
	it('denies incomplete ambiguous native authority before querying the public boundary', async () => {
		for (const supplied of [undefined, {}, [null], [{ id: '', created_at: clock }], [{ id: 'first' }],
			[{ id: 'first', created_at: 'invalid' }], [native[0], native[0]]]) {
			let calls = 0; const before = structuredClone(supplied);
			await expect(verifyNativeInventory(supplied, () => { calls++; return pages[0]; }, 1)).rejects.toThrow();
			expect(calls).toBe(0); expect(supplied).toEqual(before);
		}
		for (const limit of [0, -1, 1.5, NaN, Infinity, 201]) await expect(verifyNativeInventory(native, () => pages[0], limit)).rejects.toThrow();
		await expect(verifyNativeInventory(native, () => pages[0], 1, 'unknown' as never)).rejects.toThrow();
	});
});
