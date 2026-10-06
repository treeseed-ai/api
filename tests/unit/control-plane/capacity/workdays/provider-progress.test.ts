import { beforeEach, expect, it, vi } from 'vitest';
import type { CapacityWorkdayEventRecord } from '@treeseed/sdk/agent-capacity';
import { CapacityWorkdayEventService, projectsToDiscussionLifecycle } from '../../../../../src/api/capacity/services/capacity/workdays/content/workday-event-service.ts';
import { CapacityWorkdayEventRepository } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { CapacityWorkdayRunRepository } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { appendDiscussionEvent } from '../../../../../src/api/discussions/content.ts';
import { persistSessionEvent } from '../../../../../src/api/realtime/session-events.ts';

vi.mock('../../../../../src/api/discussions/content.ts', () => ({ appendDiscussionEvent: vi.fn() }));
vi.mock('../../../../../src/api/realtime/session-events.ts', () => ({ persistSessionEvent: vi.fn() }));

beforeEach(() => { vi.restoreAllMocks(); vi.mocked(appendDiscussionEvent).mockReset(); vi.mocked(persistSessionEvent).mockReset(); });

function fixture() {
	const rows = new Map<string, CapacityWorkdayEventRecord>();
	vi.spyOn(CapacityWorkdayRunRepository.prototype, 'get').mockResolvedValue({ parameters: { discussion: { discussionId: 'topic' } } } as never);
	vi.spyOn(CapacityWorkdayEventRepository.prototype, 'get').mockImplementation(async (_team, _run, id) => rows.get(id) ?? null);
	const create = vi.spyOn(CapacityWorkdayEventRepository.prototype, 'create').mockImplementation(async (teamId, runId, value) => {
		const row = { ...value, teamId, runId, eventIndex: rows.size }; rows.set(value.id, row); return row;
	});
	vi.mocked(persistSessionEvent).mockResolvedValue(undefined as never);
	vi.mocked(appendDiscussionEvent).mockResolvedValue({} as never);
	return { service: new CapacityWorkdayEventService({} as never), rows, create };
}

function input(eventType = 'provider.execution.preparing', status = 'recorded', id = 'provider-runtime:assignment:trace:1') {
	return { id, projectId: 'sdk', workdayId: 'run', assignmentId: 'assignment', eventType, status,
		message: 'Exact durable preparation progress', createdAt: '2026-10-01T21:32:08.418Z',
		context: { component: 'execution-provider', stage: 'source.preparing' }, refs: { source: 'exact-ref' }, metadata: { redactionStatus: 'sanitized' } };
}

it('persists all captured EJ preparation stages without waiting for TreeDX projection', async () => {
	const { service, create, rows } = fixture();
	vi.mocked(appendDiscussionEvent).mockRejectedValue(new Error('TreeDX is slow or unavailable'));
	for (const [index, type] of ['provider.execution.preparing', 'provider.sandbox.created', 'provider.execution.progress', 'provider.execution.progress'].entries()) {
		const value = input(type, 'recorded', `provider-runtime:assignment:trace:${index}`);
		await expect(service.create('team', 'run', value)).resolves.toMatchObject(value);
	}
	expect(create).toHaveBeenCalledTimes(4); expect(rows.size).toBe(4);
	expect(appendDiscussionEvent).not.toHaveBeenCalled();
	expect(persistSessionEvent).toHaveBeenCalledTimes(4);
	expect(persistSessionEvent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
		eventType: 'resource.invalidated', teamId: 'team', projectId: 'sdk', resourceId: 'run',
	}));
});

it('does not put a delayed discussion commit on the preparation critical path', async () => {
	const { service } = fixture(); let release!: () => void;
	vi.mocked(appendDiscussionEvent).mockImplementation(() => new Promise(resolve => { release = () => resolve({} as never); }));
	let completed = false; const pending = service.create('team', 'run', input()).then(value => { completed = true; return value; });
	try { await vi.waitFor(() => expect(completed).toBe(true), { timeout: 100, interval: 5 }); }
	finally { release?.(); await pending; }
	expect(appendDiscussionEvent).not.toHaveBeenCalled();
});

it('keeps routine provider progress in its one authoritative workday event stream', () => {
	for (const eventType of ['provider.execution.preparing', 'provider.sandbox.created', 'provider.execution.started', 'provider.execution.progress', 'provider.sandbox.destroyed']) {
		for (const status of ['recorded', 'active'] as const) expect(projectsToDiscussionLifecycle({ id: 'provider-runtime:assignment:trace:1', eventType, status })).toBe(false);
	}
});

it('preserves terminal and diagnostic warning discussion projection with exact durable content', async () => {
	const { service } = fixture();
	for (const [index, status] of ['completed', 'failed', 'warning', 'error'].entries()) {
		const value = input(status === 'completed' ? 'provider.execution.completed' : 'provider.execution.failed', status, `provider-runtime:assignment:terminal:${index}`);
		await service.create('team', 'run', value);
		expect(appendDiscussionEvent).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'sdk', teamId: 'team', discussionId: 'topic', event: expect.objectContaining(value) }));
	}
});

it('keeps required terminal projection failure fatal rather than returning a false receipt', async () => {
	const { service, rows } = fixture(); vi.mocked(appendDiscussionEvent).mockRejectedValue(new Error('exact read-back failed'));
	await expect(service.create('team', 'run', input('provider.execution.failed', 'failed'))).rejects.toThrow('exact read-back failed');
	expect(rows.size).toBe(1);
});

it('replays required terminal projection after a durable event survived a failed discussion commit', async () => {
	const { service, create } = fixture(); const value = input('provider.execution.failed', 'failed');
	vi.mocked(appendDiscussionEvent).mockRejectedValue(new Error('exact read-back failed'));
	await expect(service.create('team', 'run', value)).rejects.toThrow('exact read-back failed');
	await expect(service.create('team', 'run', value)).rejects.toThrow('exact read-back failed');
	vi.mocked(appendDiscussionEvent).mockResolvedValue({} as never);
	await expect(service.create('team', 'run', value)).resolves.toMatchObject(value);
	expect(create).toHaveBeenCalledTimes(1); expect(appendDiscussionEvent).toHaveBeenCalledTimes(3);
});

it('retains durable progress idempotency and rejects changed evidence', async () => {
	const { service, create } = fixture(); const value = input();
	const first = await service.create('team', 'run', value);
	expect(await service.create('team', 'run', value)).toEqual(first);
	await expect(service.create('team', 'run', { ...value, message: 'Different evidence' })).rejects.toMatchObject({ code: 'capacity_workday_event_idempotency_conflict' });
	expect(create).toHaveBeenCalledTimes(1); expect(appendDiscussionEvent).not.toHaveBeenCalled();
});

it('preserves ordinary workday lifecycle projection and activity mirror exclusion', async () => {
	const { service } = fixture(); await service.create('team', 'run', input('workday.started', 'recorded', 'workday:start'));
	expect(appendDiscussionEvent).toHaveBeenCalledTimes(1);
	expect(projectsToDiscussionLifecycle({ id: 'activity:assignment:completed', eventType: 'assignment.completed', status: 'completed' })).toBe(false);
});

it('still rejects transient token deltas before durable insertion', async () => {
	const { service, create } = fixture();
	await expect(service.create('team', 'run', input('provider.token.delta'))).rejects.toMatchObject({ code: 'capacity_workday_event_transient_only' });
	expect(create).not.toHaveBeenCalled(); expect(appendDiscussionEvent).not.toHaveBeenCalled();
});
