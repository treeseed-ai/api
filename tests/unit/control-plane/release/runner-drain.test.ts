import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ close: vi.fn(), heartbeat: vi.fn(async () => {}), work: vi.fn() }));
vi.mock('../../../../src/operations-runner/entrypoint-support/index.js', () => ({
	startHealthServer: () => ({ close: mocks.close }), loadHealthConfig: () => ({}),
	packageVersion: async () => 'test', parseRunnerOptions: () => ({ pollIntervalMs: 0 }),
	loadConfig: async () => ({ runnerId: 'test' }),
	createClient: async () => ({ heartbeat: mocks.heartbeat, close: async () => {} }),
	createControlPlaneStore: () => null, registerAndHeartbeat: async () => {},
	runOnceWithClient: mocks.work,
}));
import { runLoop } from '../../../../src/operations-runner/entrypoint-support/support/run-loop.ts';

it('finishes active work, marks offline, and closes the listener after a drain signal', async () => {
	const signals = new Map<string, (...args: any[]) => void>();
	const once = vi.spyOn(process, 'once').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
		signals.set(event, handler); return process;
	}) as typeof process.once);
	mocks.work.mockImplementation(async () => { signals.get('SIGTERM')?.(); expect(mocks.close).not.toHaveBeenCalled(); });
	try {
		await runLoop();
		expect(mocks.work).toHaveBeenCalledTimes(1);
		expect(mocks.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ status: 'offline', activeJobCount: 0 }));
		expect(mocks.close).toHaveBeenCalledTimes(1);
	} finally { once.mockRestore(); }
});
