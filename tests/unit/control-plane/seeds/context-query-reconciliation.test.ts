import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyContextQueryCatalog } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts';
import { ContextQueryCheckService } from '../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import { CapacityGovernanceError } from '../../../../src/api/capacity/database.ts';

describe('seed context-query acceptance freshness', () => {
	afterEach(() => vi.restoreAllMocks());
	const input = { store: {}, teamId: 'team', projectId: 'sdk', ref: 'a'.repeat(40) };
	function fixture() {
		vi.spyOn(ContextQueryCheckService.prototype, 'catalog').mockResolvedValue({
			agentReferences: [{ kind: 'query', id: 'project', revision: 1 }],
			tests: [{ id: 'project-test', path: 'tests/project-test.mdx', definitionKind: 'query', definitionId: 'project', definitionRevision: 1 }],
		} as any);
		return vi.spyOn(ContextQueryCheckService.prototype, 'check').mockResolvedValue({ status: 'passing' } as any);
	}
	it('reuses current passing evidence without executing tests again', async () => {
		const check = fixture();
		vi.spyOn(ContextQueryCheckService.prototype, 'requirePassing').mockResolvedValue([]);
		await expect(verifyContextQueryCatalog(input)).resolves.toEqual({ references: 1, tests: 1 });
		expect(check).not.toHaveBeenCalled();
	});
	it('uses a new check identity after expiration, then requires fresh evidence', async () => {
		const check = fixture();
		const readiness = vi.spyOn(ContextQueryCheckService.prototype, 'requirePassing');
		for (let attempt = 0; attempt < 2; attempt++) {
			readiness.mockRejectedValueOnce(new CapacityGovernanceError('agent_context_query_not_ready', 'Expired', 409)).mockResolvedValueOnce([]);
			await verifyContextQueryCatalog(input);
		}
		expect(check).toHaveBeenCalledTimes(2);
		expect(check.mock.calls[0][2].idempotencyKey).not.toBe(check.mock.calls[1][2].idempotencyKey);
		expect(check.mock.calls[0][2].definitionRef).toBe(input.ref);
		expect(readiness).toHaveBeenCalledTimes(4);
	});
	it('does not suppress unavailable custody or failed validation', async () => {
		const check = fixture();
		vi.spyOn(ContextQueryCheckService.prototype, 'requirePassing').mockRejectedValue(new Error('TreeDX unavailable'));
		await expect(verifyContextQueryCatalog(input)).rejects.toThrow('TreeDX unavailable');
		expect(check).not.toHaveBeenCalled();
	});
});
