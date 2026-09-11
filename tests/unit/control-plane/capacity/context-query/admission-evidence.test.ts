import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextQueryCheckService } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';

describe('context-query admission evidence', () => {
  afterEach(() => vi.restoreAllMocks());
  const now = new Date('2026-09-10T12:00:00Z');
  const ref = 'a'.repeat(40);
  const requested = { kind: 'query' as const, id: 'foundation', revision: 2 };
  const passing = {
    id: 'check', team_id: 'team', project_id: 'sdk', test_id: 'foundation-test', test_ref: 'test:2',
    definition_kind: 'query', definition_id: 'foundation', definition_revision: 2,
    definition_commit: 'b'.repeat(40), status: 'passing',
    checked_at: '2026-09-10T11:00:00Z', expires_at: '2026-09-11T11:00:00Z',
  };
  function service(rows: Record<string, unknown>[], withTest = true) {
    const store = { all: vi.fn().mockResolvedValue(rows) };
    const instance = new ContextQueryCheckService(store as unknown as CapacityGovernanceDatabase);
    vi.spyOn(instance, 'catalog').mockResolvedValue({
      tests: withTest ? [{ id: 'foundation-test', definitionKind: 'query', definitionId: 'foundation', definitionRevision: 2 }] : [],
    } as unknown as Awaited<ReturnType<ContextQueryCheckService['catalog']>>);
    return instance;
  }
  it('reuses fresh evidence across commits when the requested definition revision is unchanged', async () => {
    const result = await service([passing]).requirePassing('team', 'sdk', ref, [requested], now);
    expect(result[0].readiness.selectable).toBe(true);
    expect(result[0].definition.commit).toBe(passing.definition_commit);
  });
  it.each([
    ['missing', [], 'never_checked'],
    ['expired', [{ ...passing, expires_at: now.toISOString() }], 'check_expired'],
    ['changed', [{ ...passing, definition_revision: 1 }], 'definition_changed'],
    ['failing', [{ ...passing, status: 'failing' }], 'assertions_failed'],
  ])('rejects %s evidence and identifies the test without exposing content', async (_label, rows, reason) => {
    await expect(service(rows).requirePassing('team', 'sdk', ref, [requested], now)).rejects.toMatchObject({
      code: 'agent_context_query_not_ready',
      message: expect.stringContaining(`foundation-test: ${reason}`),
      details: { blocked: [expect.objectContaining({ failedChecks: [{ testId: 'foundation-test', reason }] })] },
    });
  });
  it('does not fall back to older passing evidence after a failed check', async () => {
    await expect(service([{ ...passing, status: 'failing' }, passing]).requirePassing('team', 'sdk', ref, [requested], now)).rejects.toThrow('assertions_failed');
  });
  it('rejects a definition without registered tests', async () => {
    await expect(service([], false).requirePassing('team', 'sdk', ref, [requested], now)).rejects.toThrow('foundation: no_tests');
  });
});
