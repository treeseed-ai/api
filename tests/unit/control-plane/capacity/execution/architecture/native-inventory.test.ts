import { describe, expect, it } from 'vitest';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { verifyNativeInventory } from '../../../../../acceptance/execution-inventory.ts';

const clock = '2026-10-09T12:00:00.000Z';
const native = [{ id: 'first', created_at: clock }, { id: 'second', created_at: clock }];
const rows = [{ id: 'second', createdAt: clock, retained: 'actual second' }, { id: 'first', createdAt: clock, retained: 'actual first' }];
const cursor = encodeCapacityPageCursor({ id: 'second', createdAt: clock });
const pages = [{ items: [rows[0]], page: { limit: 1, hasMore: true, nextCursor: cursor } },
	{ items: [rows[1]], page: { limit: 1, hasMore: false, nextCursor: null } }];

describe('independent native producer inventory reconciliation', () => {
	it('reads exactly every native identity through complete public pages without changing original observations', async () => {
		const supplied = structuredClone(native), received = structuredClone(pages), calls: Array<string | undefined> = [];
		expect(await verifyNativeInventory(supplied, value => { calls.push(value); return received[calls.length - 1]; }, 1)).toEqual(rows);
		expect(calls).toEqual([undefined, cursor]); expect(supplied).toEqual(native); expect(received).toEqual(pages);
		expect(await verifyNativeInventory([], () => ({ items: [], page: { limit: 1, hasMore: false, nextCursor: null } }), 1)).toEqual([]);
	});
	it('denies malformed missing duplicated reordered foreign truncated or interrupted public inventories without repairing failed pages', async () => {
		for (const replacement of [undefined, null, {}, { items: rows }, { items: [], page: pages[0]!.page },
			{ ...pages[0], items: [rows[1]] }, { ...pages[0], items: [rows[0], rows[0]] },
			{ ...pages[0], items: [{ ...rows[0], id: 'foreign' }] }, { ...pages[0], items: [{ ...rows[0], createdAt: '2026-10-09T11:00:00.000Z' }] },
			{ ...pages[0], page: { limit: 0, hasMore: true, nextCursor: cursor } },
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
		const original = new Error('original public boundary interruption'); let index = 0;
		await expect(verifyNativeInventory(native, () => { if (index++) throw original; return pages[0]; }, 1)).rejects.toBe(original);
	});
	it('denies incomplete ambiguous native authority before querying the public boundary', async () => {
		for (const supplied of [undefined, {}, [null], [{ id: '', created_at: clock }], [{ id: 'first' }],
			[{ id: 'first', created_at: 'invalid' }], [native[0], native[0]]]) {
			let calls = 0; const before = structuredClone(supplied);
			await expect(verifyNativeInventory(supplied, () => { calls++; return pages[0]; }, 1)).rejects.toThrow();
			expect(calls).toBe(0); expect(supplied).toEqual(before);
		}
		for (const limit of [0, -1, 1.5, NaN, Infinity, 201]) await expect(verifyNativeInventory(native, () => pages[0], limit)).rejects.toThrow();
	});
});
