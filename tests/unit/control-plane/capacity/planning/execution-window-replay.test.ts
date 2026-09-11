import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startAssignmentExecutionWindow, startAssignmentCloseoutWindow } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-execution-window-service.ts';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts', () => ({ ProviderAssignmentRepository: class { get = mocks.get; } }));
const now = '2026-09-11T12:00:00Z', planRef = { id: 'plan', path: 'assignment-plans/assignment.mdx' };
const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: [] };
function assignment() { return { id: 'assignment', capacityProviderId: 'provider', membershipId: 'membership', status: 'leased', leaseState: 'leased',
  leaseToken: 'current', leaseExpiresAt: '2026-09-11T12:05:00Z', stateVersion: 4,
  metadata: { executionWindow: { idempotencyKey: 'execution-start:assignment', planRef, startedAt: '2026-09-11T11:59:00Z', executionDeadlineAt: '2026-09-11T12:02:00Z' },
    closeoutWindow: { idempotencyKey: 'closeout-start:assignment', startedAt: now } } }; }
beforeEach(() => { mocks.get.mockReset(); });

describe('execution transition replay authority', () => {
  it('reuses the original budget on a replacement runner without another transition', async () => {
    const current = assignment(), run = vi.fn(); mocks.get.mockResolvedValue(current);
    const result = await startAssignmentExecutionWindow({ run } as never, principal, 'assignment', {
      leaseToken: 'current', runnerId: 'replacement', expectedStateVersion: 4, idempotencyKey: 'execution-start:assignment', planRef,
    }, now);
    expect(result).toBe(current); expect(run).not.toHaveBeenCalled();
  });
  it.each(['wrong-lease', 'expired-lease', 'terminal'])('rejects %s even with the correct replay key', async boundary => {
    const current = assignment(); if (boundary === 'expired-lease') current.leaseExpiresAt = '2026-09-11T11:00:00Z';
    if (boundary === 'terminal') current.status = 'completed'; mocks.get.mockResolvedValue(current);
    const leaseToken = boundary === 'wrong-lease' ? 'stolen-old-token' : 'current';
    await expect(startAssignmentExecutionWindow({} as never, principal, 'assignment', { leaseToken, idempotencyKey: 'execution-start:assignment', planRef }, now)).rejects.toMatchObject({ code: 'assignment_execution_lease_invalid' });
    await expect(startAssignmentCloseoutWindow({} as never, principal, 'assignment', { leaseToken, idempotencyKey: 'closeout-start:assignment' }, now)).rejects.toMatchObject({ code: 'assignment_closeout_lease_invalid' });
  });
  it('does not allow a replay to replace its plan or restart an exhausted window', async () => {
    const current = assignment(); mocks.get.mockResolvedValue(current);
    await expect(startAssignmentExecutionWindow({} as never, principal, 'assignment', { leaseToken: 'current', idempotencyKey: 'execution-start:assignment', planRef: { ...planRef, path: 'other' } }, now)).rejects.toMatchObject({ code: 'assignment_execution_replay_mismatch' });
    current.metadata.executionWindow.executionDeadlineAt = '2026-09-11T11:59:59Z';
    await expect(startAssignmentExecutionWindow({} as never, principal, 'assignment', { leaseToken: 'current', idempotencyKey: 'execution-start:assignment', planRef }, now)).rejects.toMatchObject({ code: 'assignment_execution_window_exhausted' });
  });
});
