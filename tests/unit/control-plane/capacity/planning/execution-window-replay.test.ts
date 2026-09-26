import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('starts bounded preparation on claim after queueing without extending the outer deadline', () => {
    const timing = compileAssignmentTimeBudget({ now, requestedSeconds: 180, configuredBudget: { deadline: '2026-09-11T12:10:00Z' } });
    expect(timing.authorityExpiresAt).toBe('2026-09-11T12:10:00.000Z');
    expect(timing.capacityBudget.time.preparationStartedAt).toBeNull();
    const envelope = { requestedSeconds: 180, budget: timing.capacityBudget };
    const replay = beginAssignmentPreparationTimeBudget(envelope, '2026-09-11T12:02:30Z');
    expect(replay.budget.time.authorityDeadlineAt).toBe(timing.authorityExpiresAt);
    expect(replay.budget.time.preparationDeadlineAt).toBe('2026-09-11T12:03:30.000Z');
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
