import { describe, expect, it, vi } from 'vitest';
import { runMethod } from '../../../src/api/store/support/contracts/run.ts';

describe('control-plane store mutation result contract', () => {
	it('returns affected-row metadata to optimistic concurrency callers', async () => {
		const result = { success: true, results: [], meta: { changes: 1 } };
		const run = vi.fn().mockResolvedValue(result);
		const bind = vi.fn(() => ({ run }));
		const store = { db: { prepare: vi.fn(() => ({ bind })) } };

		await expect(runMethod.call(store as never, 'UPDATE records SET version = version + 1 WHERE id = ?', ['record-a']))
			.resolves.toBe(result);
		expect(bind).toHaveBeenCalledWith('record-a');
	});
});
