import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextQueryCheckService } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
  ...await original<object>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));

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
  function service(rows: Record<string, unknown>[], withTest = true, kind: 'query' | 'query-set' = 'query') {
    const store = { all: vi.fn().mockResolvedValue(rows) };
    const instance = new ContextQueryCheckService(store as unknown as CapacityGovernanceDatabase);
    const root = kind === 'query' ? 'agent-context-queries' : 'agent-context-query-sets';
    const definitions = [{ kind, id: 'foundation', revision: 2, path: `${root}/foundation.mdx` },
      { kind: 'query', id: 'member', revision: 1, path: 'agent-context-queries/member.mdx' }];
    const documents = new Map<string, Record<string, unknown>>();
    for (const commit of [ref, passing.definition_commit]) {
      documents.set(`${commit}:agent-tests/foundation-test.mdx`, { id: 'foundation-test', testRef: 'test:2',
        expectedPaths: ['knowledge/foundation.mdx'] });
      documents.set(`${commit}:${root}/foundation.mdx`, { id: 'foundation', revision: 2,
        ...(kind === 'query' ? { query: 'foundation context' } : { queryRefs: [{ id: 'member', revision: 1 }] }) });
      documents.set(`${commit}:agent-context-queries/member.mdx`, { id: 'member', revision: 1, query: 'member context' });
    }
    const readRepositoryFiles = vi.fn(async ({ ref: commit, paths }: { ref: string; paths: string[] }) => ({
      resolvedRef: commit, files: paths.map(path => ({ path, content: `---\n${JSON.stringify(documents.get(`${commit}:${path}`))}\n---\n` })),
    }));
    vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ repositoryId: 'library', contentPath: '.',
      client: { readRepositoryFiles } } as never);
    vi.spyOn(instance, 'catalog').mockResolvedValue({
      definitions, tests: withTest ? [{ id: 'foundation-test', testRef: 'test:2', path: 'agent-tests/foundation-test.mdx',
        definitionKind: kind, definitionId: 'foundation', definitionRevision: 2 }] : [],
    } as unknown as Awaited<ReturnType<ContextQueryCheckService['catalog']>>);
    return Object.assign(instance, { documents, readRepositoryFiles });
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
  it.each([
    ['test assertions', 'agent-tests/foundation-test.mdx', { id: 'foundation-test', testRef: 'test:2', expectedPaths: ['knowledge/missing.mdx'] }],
    ['query definition', 'agent-context-queries/foundation.mdx', { id: 'foundation', revision: 2, query: 'changed context' }],
  ])('rejects changed %s under the same declared identity and revision', async (_name, path, document) => {
    const f = service([passing]);
    f.documents.set(`${ref}:${path}`, document as Record<string, unknown>);
    await expect(f.requirePassing('team', 'sdk', ref, [requested], now)).rejects.toMatchObject({
      code: 'agent_context_query_not_ready', message: expect.stringContaining('foundation-test: definition_changed'),
    });
  });
  it('rejects a changed query-set member while the set and member revisions are unchanged', async () => {
    const f = service([{ ...passing, definition_kind: 'query-set' }], true, 'query-set');
    f.documents.set(`${ref}:agent-context-queries/member.mdx`, { id: 'member', revision: 1, query: 'changed member context' });
    await expect(f.requirePassing('team', 'sdk', ref, [{ ...requested, kind: 'query-set' }], now))
      .rejects.toMatchObject({ code: 'agent_context_query_not_ready' });
  });
});
