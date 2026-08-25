import { describe, expect, it, vi } from 'vitest';
import { TreeDxUpstreamAdmission, TreeDxUpstreamAdmissionError } from '../../../../src/api/control-plane/treedx/upstream-admission.ts';

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
};

describe('TreeDX upstream admission', () => {
	it('bounds each project while allowing another project to use the connection', async () => {
		const gate = new TreeDxUpstreamAdmission({ connectionConcurrency: 2, projectConcurrency: 1, actorConcurrency: 2 });
		const first = deferred(); const order: string[] = [];
		const running = gate.run({ connectionId: 'c', projectId: 'p1', actorId: 'a1', retryable: false,
			invoke: async () => { order.push('p1-first'); await first.promise; } });
		const queued = gate.run({ connectionId: 'c', projectId: 'p1', actorId: 'a2', retryable: false,
			invoke: async () => { order.push('p1-second'); } });
		await gate.run({ connectionId: 'c', projectId: 'p2', actorId: 'a2', retryable: false,
			invoke: async () => { order.push('p2'); } });
		expect(order).toEqual(['p1-first', 'p2']);
		first.resolve(); await Promise.all([running, queued]);
		expect(order).toEqual(['p1-first', 'p2', 'p1-second']);
	});

	it('retries only a declared retryable transient operation', async () => {
		const gate = new TreeDxUpstreamAdmission(); const invoke = vi.fn()
			.mockRejectedValueOnce(new TypeError('network')).mockResolvedValue({ ok: true });
		await expect(gate.run({ connectionId: 'c', projectId: 'p', actorId: 'a', retryable: true, invoke })).resolves.toEqual({ ok: true });
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it('opens the connection circuit after repeated transient failures', async () => {
		let now = 10; const gate = new TreeDxUpstreamAdmission({ failureThreshold: 2, circuitOpenMs: 100, now: () => now });
		const request = () => gate.run({ connectionId: 'c', projectId: 'p', actorId: 'a', retryable: false,
			invoke: async () => { throw new TypeError('network'); } });
		await expect(request()).rejects.toThrow('network');
		await expect(request()).rejects.toThrow('network');
		await expect(request()).rejects.toMatchObject<TreeDxUpstreamAdmissionError>({ code: 'treedx_upstream_circuit_open' });
		now = 111;
		await expect(request()).rejects.toThrow('network');
	});

	it('removes cancelled queued work without invoking it', async () => {
		const gate = new TreeDxUpstreamAdmission({ connectionConcurrency: 1, projectConcurrency: 1, actorConcurrency: 1 });
		const first = deferred(); const running = gate.run({ connectionId: 'c', projectId: 'p', actorId: 'a', retryable: false,
			invoke: async () => { await first.promise; } });
		const controller = new AbortController(); const invoke = vi.fn();
		const queued = gate.run({ connectionId: 'c', projectId: 'p', actorId: 'a', retryable: false, signal: controller.signal, invoke });
		controller.abort();
		await expect(queued).rejects.toMatchObject({ code: 'treedx_upstream_cancelled' });
		first.resolve(); await running;
		expect(invoke).not.toHaveBeenCalled();
	});

	it('rejects excess queued work without invoking it', async () => {
		const gate = new TreeDxUpstreamAdmission({ connectionConcurrency: 1, projectConcurrency: 1, actorConcurrency: 1, queueLimit: 1 });
		const first = deferred(); const running = gate.run({ connectionId: 'c', projectId: 'p', actorId: 'a', retryable: false,
			invoke: async () => { await first.promise; } });
		const queued = gate.run({ connectionId: 'c', projectId: 'p', actorId: 'a', retryable: false, invoke: async () => undefined });
		const rejected = vi.fn();
		await expect(gate.run({ connectionId: 'c', projectId: 'p', actorId: 'a', retryable: false, invoke: rejected }))
			.rejects.toMatchObject({ code: 'treedx_upstream_busy' });
		first.resolve(); await Promise.all([running, queued]);
		expect(rejected).not.toHaveBeenCalled();
	});
});
