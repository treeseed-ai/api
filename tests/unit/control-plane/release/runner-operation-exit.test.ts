import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ operation: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('../../../../src/operations-runner/entrypoint-support/index.js', () => ({
    createClient: async () => ({ close: mocks.close }),
    createControlPlaneStore: () => null,
    createExecutorsForOptions: () => ({}),
    loadConfig: async () => ({ runnerId: 'test', dataDir: '/tmp/test-runner', environment: 'staging' }),
    packageVersion: async () => 'test',
    registerAndHeartbeat: async () => {},
}));
vi.mock('../../../../src/operations-runner/entrypoint-support/operations/operation-execution.js', () => ({
    runPlatformOperationOnce: mocks.operation,
}));
import { runOnce, runOnceWithClient } from '../../../../src/operations-runner/entrypoint-support/operations/operation-poll.ts';

const originalExitCode = process.exitCode;
beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { process.exitCode = originalExitCode; vi.restoreAllMocks(); });

describe('runner operation and process outcomes', () => {
    it('does not poison a continuous runner exit after a handled operation failure', async () => {
        mocks.operation.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
        const config = { runnerId: 'test', dataDir: '/tmp/test-runner', environment: 'staging' };
        expect(await runOnceWithClient(config, {}, 'test')).toEqual({ ok: false });
        expect(process.exitCode).toBeUndefined();
        expect(await runOnceWithClient(config, {}, 'test')).toEqual({ ok: true });
        expect(process.exitCode).toBeUndefined();
    });

    it('preserves an unrelated fatal status during continuous polling', async () => {
        process.exitCode = 2;
        mocks.operation.mockResolvedValue({ ok: false });
        await runOnceWithClient({ runnerId: 'test' }, {}, 'test');
        expect(process.exitCode).toBe(2);
    });

    it('keeps failed one-shot executions nonzero and closes the client', async () => {
        mocks.operation.mockResolvedValue({ ok: false });
        expect(await runOnce()).toEqual({ ok: false });
        expect(process.exitCode).toBe(1);
        expect(mocks.close).toHaveBeenCalledOnce();
    });

    it('does not clear an unrelated fatal status on one-shot success', async () => {
        process.exitCode = 2;
        mocks.operation.mockResolvedValue({ ok: true });
        expect(await runOnce()).toEqual({ ok: true });
        expect(process.exitCode).toBe(2);
        expect(mocks.close).toHaveBeenCalledOnce();
    });
});
