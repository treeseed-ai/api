import { expect, it, vi } from 'vitest';
import { eventObserved } from './session-postgres-fixture.ts';

it('retains pending native observations but rejects success after the original caller deadline without accepting server cleanup early', async () => {
	let now = 100;
	const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
	try {
		for (const late of [false, true]) {
			now = 100;
			const predicate = vi.fn(async () => { if (late) now = 102; return true; });
			await expect.soft(eventObserved(predicate, late ? 101 : 99)).rejects.toThrow('Native session event observation did not complete');
			expect(predicate).toHaveBeenCalledTimes(late ? 1 : 0);
		}
		for (const deadline of [Number.NaN, Infinity, -Infinity]) {
			const predicate = vi.fn(async () => true);
			await expect(eventObserved(predicate, deadline)).rejects.toThrow('Native session event observation did not complete');
			expect(predicate).not.toHaveBeenCalled();
		}
		now = 100;
		await expect(eventObserved(async () => { now = 5101; return true; }, 10_000))
			.rejects.toThrow('Native session event observation did not complete');
		now = 100;
		let reads = 0;
		await expect(eventObserved(async () => { reads++; now++; return false; }, 102))
			.rejects.toThrow('Native session event observation did not complete');
		expect(reads).toBe(2);
		now = 100; await eventObserved(async () => true);
		now = 100;
		const original = [{ pid: 1922 }], held = structuredClone(original), observations: Array<typeof original> = [];
		await eventObserved(async () => {
			const rows = observations.length ? [] : original;
			observations.push(structuredClone(rows)); return rows.length === 0;
		}, 101);
		expect(observations).toEqual([original, []]); expect(original).toEqual(held);
		const failure = new Error('Original native query interrupted');
		await expect(eventObserved(async () => { throw failure; }, 101)).rejects.toBe(failure);
	} finally { clock.mockRestore(); }
});
