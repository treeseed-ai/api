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
		}
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
