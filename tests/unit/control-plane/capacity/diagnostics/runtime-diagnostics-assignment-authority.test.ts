import { expect, it, vi } from 'vitest';
import { buildProjectCapacityRuntimeDiagnostics } from '../../../../../src/api/capacity/services/runtime/runtime-diagnostics-query-service.ts';

it('builds runtime diagnostics without reading retired mode-run records', async () => {
	const queries: string[] = [];
	const page = { items: [], page: { limit: 25, hasMore: false, nextCursor: null } };
	const repository = {
		first: vi.fn(async (sql: string) => { queries.push(sql); return { assignment_count: 0 }; }),
		all: vi.fn(async (sql: string) => { queries.push(sql); return []; }),
		getProject: vi.fn(async () => ({ id: 'project', teamId: 'team' })),
		listProviderAssignmentsPage: vi.fn(async () => page),
		listTreeDxProxyAuditPage: vi.fn(async () => page),
		listAgentFallbackOutputsPage: vi.fn(async () => page),
		listCapacityLedgerEntriesPage: vi.fn(async () => page),
	};
	const diagnostics = await buildProjectCapacityRuntimeDiagnostics(repository, 'project', 'team');
	expect(diagnostics?.assignments).toEqual([]);
	expect(JSON.stringify(diagnostics)).not.toMatch(/modeRuns/u);
	expect(queries.join('\n')).not.toContain('agent_mode_runs');
});
