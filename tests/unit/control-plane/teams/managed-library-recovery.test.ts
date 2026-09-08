import { describe, expect, it, vi } from 'vitest';
import { recoverManagedLibraryStartup } from '../../../../src/api/teams/managed-library-recovery.ts';

describe('managed Team Library startup recovery', () => {
	it('retries only transient failed teams and stops after recovery', async () => {
		const pending: Array<() => void> = [], delays: number[] = [];
		const reconcile = vi.fn().mockRejectedValueOnce(new Error('TreeDX network request failed')).mockResolvedValue({ state: 'known-good' });
		recoverManagedLibraryStartup([{teamId:'retry',state:'blocked',error:'TreeDX network request failed'}, {teamId:'ready',state:'known-good'}, {teamId:'denied',state:'blocked',error:'GitHub 403'}], reconcile, (work, delay) => { pending.push(work); delays.push(delay); });
		pending.shift()!(); await Promise.resolve(); await Promise.resolve();
		pending.shift()!(); await Promise.resolve(); await Promise.resolve();
		expect(reconcile.mock.calls).toEqual([['retry'],['retry']]);
		expect(delays).toEqual([5000,10000]); expect(pending).toHaveLength(0);
	});
	it('bounds retries and never retries permanent authority failures', async () => {
		const pending: Array<() => void> = [];
		const reconcile = vi.fn().mockRejectedValue(new Error('TreeDX network request failed'));
		recoverManagedLibraryStartup([{teamId:'retry',state:'blocked',error:'TreeDX network request failed'}], reconcile, work => {pending.push(work);});
		while(pending.length) { pending.shift()!(); await Promise.resolve(); await Promise.resolve(); }
		expect(reconcile).toHaveBeenCalledTimes(7);
		reconcile.mockClear().mockRejectedValue(new Error('Vault access denied'));
		recoverManagedLibraryStartup([{teamId:'retry',state:'blocked',error:'TreeDX network request failed'}], reconcile, work => {pending.push(work);});
		pending.shift()!(); await Promise.resolve(); await Promise.resolve();
		expect(reconcile).toHaveBeenCalledTimes(1); expect(pending).toHaveLength(0);
	});
});
