import { beforeEach, expect, it, vi } from 'vitest';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../src/api/capacity/control-plane.ts';
import { createControlPlanePostgresDatabase } from '../../../../src/api/support/control-plane-postgres.ts';
import { DirectControlPlaneRunnerClient } from '../../../../src/operations-runner/client/direct-control-plane-runner-client.ts';
import { postgresGraph } from '../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';

const mocks = vi.hoisted(() => ({ close: vi.fn(), heartbeat: vi.fn(async () => {}), work: vi.fn(),
	store: vi.fn<() => unknown>(() => null), client: vi.fn<() => unknown>(() => null),
	register: vi.fn<(client: unknown) => Promise<void>>(async () => {}) }));
vi.mock('../../../../src/operations-runner/entrypoint-support/index.js', () => ({
	startHealthServer: () => ({ close: mocks.close }), loadHealthConfig: () => ({}),
	packageVersion: async () => 'test', parseRunnerOptions: () => ({ pollIntervalMs: 0 }),
	loadConfig: async () => ({ runnerId: 'test' }),
	createClient: async () => mocks.client() ?? ({ heartbeat: mocks.heartbeat, close: async () => {} }),
	createControlPlaneStore: mocks.store, registerAndHeartbeat: mocks.register,
	runOnceWithClient: mocks.work,
}));
import { runLoop, startWorkdayMaintenanceClock } from '../../../../src/operations-runner/entrypoint-support/support/run-loop.ts';
beforeEach(() => { vi.resetAllMocks(); });

it('keeps workday maintenance ticking independently of an operation poll', async () => {
	vi.useFakeTimers();
	const maintenance = vi.fn(async () => null);
	const timer = startWorkdayMaintenanceClock({ runIfDue: maintenance }, 1_000);
	try {
		await vi.advanceTimersByTimeAsync(3_000);
		expect(maintenance).toHaveBeenCalledTimes(4);
	} finally {
		clearInterval(timer);
		vi.useRealTimers();
	}
});

it('retains the original runner failure while draining a store whose supported close returns void', async () => {
	vi.clearAllMocks();
	const original = new Error('controlled registration failure');
	const signals = new Map<string, () => void>();
	const once = vi.spyOn(process, 'once').mockImplementation((event, handler) => {
		signals.set(String(event), handler); return process;
	});
	const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
	const close = vi.fn(() => { signals.get('SIGTERM')?.(); });
	mocks.store.mockReturnValue({ db: { close } });
	mocks.register.mockRejectedValueOnce(original);
	try {
		await expect(runLoop()).resolves.toBeUndefined();
		expect(close).toHaveBeenCalledOnce();
		expect(mocks.work).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
		expect(errors.mock.calls.some(([message]) => message === JSON.stringify({ ok: false, error: original.message }))).toBe(true);
	} finally {
		mocks.store.mockReturnValue(null); mocks.register.mockResolvedValue(undefined);
		errors.mockRestore(); once.mockRestore();
	}
});

it('preserves runner failure and listener drain with missing asynchronous or throwing store close without repairing supplied custody', async () => {
	const original = new Error('controlled original runner failure');
	for (const outcome of ['missing-store', 'missing-close', 'resolved', 'rejected', 'throws']) {
		vi.resetAllMocks();
		const signals = new Map<string, () => void>();
		const once = vi.spyOn(process, 'once').mockImplementation((event, handler) => {
			signals.set(String(event), handler); return process;
		});
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const close = vi.fn(() => {
			if (outcome === 'throws') throw new Error('controlled cleanup failure');
			return outcome === 'rejected' ? Promise.reject(new Error('controlled cleanup failure')) : Promise.resolve();
		});
		const supplied = outcome === 'missing-store' ? null : { db: outcome === 'missing-close' ? {} : { close } };
		mocks.store.mockReturnValue(supplied);
		mocks.register.mockImplementation(async () => { signals.get('SIGTERM')?.(); throw original; });
		try {
			await expect(runLoop()).resolves.toBeUndefined();
			expect(close).toHaveBeenCalledTimes(outcome.startsWith('missing') ? 0 : 1);
			expect(mocks.store()).toBe(supplied); expect(mocks.work).not.toHaveBeenCalled();
			expect(mocks.close).toHaveBeenCalledOnce();
			expect(errors.mock.calls.some(([message]) => message === JSON.stringify({ ok: false, error: original.message }))).toBe(true);
			expect(errors.mock.calls.filter(([message]) => message === JSON.stringify({ ok: false,
				event: 'runner.store.close.failed', error: 'controlled cleanup failure' })))
				.toHaveLength(outcome === 'rejected' || outcome === 'throws' ? 1 : 0);
		} finally { errors.mockRestore(); once.mockRestore(); }
	}
});

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

it('native runner failure closes its actual PostgreSQL pool without replacing the failed registration or changing retained database truth', async () => {
	const f = await postgresGraph();
	const database = createControlPlanePostgresDatabase(f.connectionString);
	const closeDatabase = database.close.bind(database);
	let closing: Promise<void> | undefined;
	const signals = new Map<string, () => void>();
	const once = vi.spyOn(process, 'once').mockImplementation((event, handler) => {
		signals.set(String(event), handler); return process;
	});
	const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.clearAllMocks();
	try {
		await f.left.pool.query(`CREATE FUNCTION runner_registration_interruption() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'native_owned_registration_failure'; END $$;
			CREATE TRIGGER runner_registration_interruption BEFORE INSERT ON control_plane_operation_runners
			FOR EACH ROW EXECUTE FUNCTION runner_registration_interruption()`);
		const baseline = await f.snapshot();
		const runners = (await f.right.pool.query('SELECT * FROM control_plane_operation_runners ORDER BY id')).rows;
		const store = createCapacityControlPlane(new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, database));
		store.initializationPromise = Promise.resolve(); // The original full migrations above are already complete.
		// Delegate the actual native pool close, exposing the allowed void return.
		// No query, registration, capacity maintenance or SQL outcome is mocked.
		Object.assign(database, { close() { closing = closeDatabase(); signals.get('SIGTERM')?.(); } });
		mocks.store.mockReturnValue(store);
		mocks.client.mockReturnValue(new DirectControlPlaneRunnerClient(store, false));
		mocks.register.mockImplementation(async client => {
			if (!(client instanceof DirectControlPlaneRunnerClient)) throw new Error('Actual owning runner client required');
			await client.register({ runnerId: 'native-failed-registration', environment: 'staging' });
		});
		await expect(runLoop()).resolves.toBeUndefined();
		expect(closing).toBeDefined(); await closing;
		await expect(database.pool.query('SELECT 1')).rejects.toThrow(/Cannot use a pool after calling end/u);
		expect(await f.snapshot()).toEqual(baseline);
		expect((await f.right.pool.query('SELECT * FROM control_plane_operation_runners ORDER BY id')).rows).toEqual(runners);
		expect(mocks.work).not.toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalledOnce();
		expect(errors.mock.calls.some(([message]) => message === JSON.stringify({ ok: false, error: 'native_owned_registration_failure' }))).toBe(true);
	} finally {
		mocks.store.mockReturnValue(null); mocks.client.mockReturnValue(null); mocks.register.mockResolvedValue(undefined);
		errors.mockRestore(); once.mockRestore();
		try { await (closing ?? closeDatabase()); } finally { await f.close(); }
	}
});
