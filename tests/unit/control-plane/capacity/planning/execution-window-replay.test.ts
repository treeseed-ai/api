import { beforeEach, describe, expect, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { compileAssignmentExecutionWindow, compileAssignmentCloseoutWindow, startAssignmentExecutionWindow, startAssignmentCloseoutWindow } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-execution-window-service.ts';
import { compileAssignmentTimeBudget, beginAssignmentPreparationTimeBudget } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-time-budget.ts';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts', () => ({ ProviderAssignmentRepository: class { get = mocks.get; } }));
const now = '2026-09-11T12:00:00Z';
const executionRef = { nodeId: 'node', nodeRevision: 1, graphRevision: 2, attempt: 1 };
const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: [] };
function assignment() { return { id: 'assignment', capacityProviderId: 'provider', membershipId: 'membership', status: 'leased', leaseState: 'leased',
  leaseToken: 'current', leaseExpiresAt: '2026-09-11T12:05:00Z', stateVersion: 4,
	assignmentAttempt: { ...executionRef },
  metadata: { executionWindow: { idempotencyKey: 'execution-start:assignment', executionRef: { ...executionRef }, startedAt: '2026-09-11T11:59:00Z', executionDeadlineAt: '2026-09-11T12:02:00Z' },
    closeoutWindow: { idempotencyKey: 'closeout-start:assignment', startedAt: now } } }; }
beforeEach(() => { mocks.get.mockReset(); });

describe('execution transition replay authority', () => {
  it.each([
    ['captured EI sub-second execution', '2026-10-01T20:25:40.992Z', 11],
    ['inside closeout reserve', '2026-10-01T20:25:36.363Z', 5],
    ['exact closeout reserve', '2026-10-01T20:25:36.362Z', 5],
  ] as const)('rejects %s rather than starting a model that cannot close out', (_label, startedAt, closeoutSeconds) => {
    const timing = compileAssignmentTimeBudget({ now: '2026-10-01T20:24:42.595Z', requestedSeconds: 58,
      configuredBudget: { deadline: '2026-10-01T20:25:41.362Z', time: { closeoutSeconds } } });
    expect(() => compileAssignmentExecutionWindow({ capacityEnvelope: { budget: timing.capacityBudget }, metadata: {} } as never,
      startedAt, executionRef)).toThrowError(expect.objectContaining({ code: 'assignment_execution_window_exhausted' }));
  });
  it('preserves a short but productive window outside the existing closeout reserve', () => {
    const timing = compileAssignmentTimeBudget({ now: '2026-10-01T20:24:42.595Z', requestedSeconds: 58,
      configuredBudget: { deadline: '2026-10-01T20:25:41.362Z', time: { closeoutSeconds: 5 } } });
    const result = compileAssignmentExecutionWindow({ capacityEnvelope: { budget: timing.capacityBudget }, metadata: {} } as never,
      '2026-10-01T20:25:35.362Z', executionRef);
    expect(result.capacityEnvelope.budget.time).toMatchObject({ remainingSeconds: 6, closeoutSeconds: 5,
      authorityDeadlineAt: '2026-10-01T20:25:41.362Z', executionDeadlineAt: '2026-10-01T20:25:41.362Z' });
  });
  it('starts bounded preparation on claim after queueing without extending the outer deadline', () => {
    const timing = compileAssignmentTimeBudget({ now, requestedSeconds: 180, configuredBudget: { deadline: '2026-09-11T12:10:00Z' } });
    expect(timing.authorityExpiresAt).toBe('2026-09-11T12:10:00.000Z');
    expect(timing.capacityBudget.time.preparationStartedAt).toBeNull();
    const envelope = { requestedSeconds: 180, budget: timing.capacityBudget };
    const replay = beginAssignmentPreparationTimeBudget(envelope, '2026-09-11T12:02:30Z');
    const budget = replay.budget;
    assert.ok(budget && typeof budget === 'object' && 'time' in budget);
    const time = budget.time;
    assert.ok(time && typeof time === 'object' && 'authorityDeadlineAt' in time && 'preparationDeadlineAt' in time);
    expect(time.authorityDeadlineAt).toBe(timing.authorityExpiresAt);
    expect(time.preparationDeadlineAt).toBe('2026-09-11T12:03:30.000Z');
    const started = compileAssignmentExecutionWindow({ capacityEnvelope: replay, metadata: {} } as never,
      '2026-09-11T12:03:00Z', executionRef);
    expect(started.capacityEnvelope.budget.time.hardDeadlineAt).toBe('2026-09-11T12:06:00.000Z');
    const closed = compileAssignmentCloseoutWindow(started as never, '2026-09-11T12:05:00Z');
    expect(closed.capacityEnvelope.budget.time.hardDeadlineAt).toBe('2026-09-11T12:06:00.000Z');
    expect(closed.capacityEnvelope.budget.time.remainingSeconds).toBe(60);
    expect(() => compileAssignmentCloseoutWindow(started as never, '2026-09-11T12:06:00Z'))
      .toThrow('Closeout cannot extend an exhausted active window.');
    expect(() => compileAssignmentExecutionWindow({ capacityEnvelope: replay, metadata: {} } as never,
      '2026-09-11T12:03:31Z', executionRef)).toThrow('bounded preparation window');
  });
  it('reuses the original budget on a replacement runner without another transition', async () => {
    const current = assignment(), run = vi.fn(); mocks.get.mockResolvedValue(current);
    const result = await startAssignmentExecutionWindow({ run } as never, principal, 'assignment', {
      leaseToken: 'current', runnerId: 'replacement', expectedStateVersion: 4, idempotencyKey: 'execution-start:assignment',
    }, now);
    expect(result).toBe(current); expect(run).not.toHaveBeenCalled();
  });
  it.each(['wrong-lease', 'expired-lease', 'terminal'])('rejects %s even with the correct replay key', async boundary => {
    const current = assignment(); if (boundary === 'expired-lease') current.leaseExpiresAt = '2026-09-11T11:00:00Z';
    if (boundary === 'terminal') current.status = 'completed'; mocks.get.mockResolvedValue(current);
    const leaseToken = boundary === 'wrong-lease' ? 'stolen-old-token' : 'current';
    await expect(startAssignmentExecutionWindow({} as never, principal, 'assignment', { leaseToken, idempotencyKey: 'execution-start:assignment' }, now)).rejects.toMatchObject({ code: 'assignment_execution_lease_invalid' });
    await expect(startAssignmentCloseoutWindow({} as never, principal, 'assignment', { leaseToken, idempotencyKey: 'closeout-start:assignment' }, now)).rejects.toMatchObject({ code: 'assignment_closeout_lease_invalid' });
  });
  it('does not allow a replay to replace its graph-node attempt or restart an exhausted window', async () => {
    const current = assignment(); mocks.get.mockResolvedValue(current);
	current.assignmentAttempt.nodeRevision = 2;
	await expect(startAssignmentExecutionWindow({} as never, principal, 'assignment', { leaseToken: 'current', idempotencyKey: 'execution-start:assignment' }, now)).rejects.toMatchObject({ code: 'assignment_execution_replay_mismatch' });
	current.assignmentAttempt.nodeRevision = 1;
    current.metadata.executionWindow.executionDeadlineAt = '2026-09-11T11:59:59Z';
    await expect(startAssignmentExecutionWindow({} as never, principal, 'assignment', { leaseToken: 'current', idempotencyKey: 'execution-start:assignment' }, now)).rejects.toMatchObject({ code: 'assignment_execution_window_exhausted' });
  });
});
