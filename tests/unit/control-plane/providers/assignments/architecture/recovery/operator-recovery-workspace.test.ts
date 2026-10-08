import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceCleanupFixture, workspaceId } from '../workspace-cleanup-fixture.ts';
import { executePostgresBatch } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { closeTerminalAssignmentWorkspace } from '../../../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-terminal-workspace.ts';
import { OperatorAssignmentService } from '../../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';

afterEach(() => vi.unstubAllEnvs());
describe('unresolved recovery retains native workspace custody', () => {
	it('native unresolved recovery denies open foreign and denied workspace readback then releases capacity only after exact native closure without usage', async () => {
		vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
		const f = await workspaceCleanupFixture('revoked', true);
		try {
			const owner = Object.assign(f.owner, { db: { transaction: async <T>(run: (client: Parameters<typeof executePostgresBatch>[0]) => Promise<T>) =>
				f.db.transaction(transaction => run(transaction as unknown as Parameters<typeof executePostgresBatch>[0])) } });
			const service = new OperatorAssignmentService(owner, assignment => closeTerminalAssignmentWorkspace(owner, assignment));
			const input = { expectedStateVersion: 1, reason: 'Retained failed measurement unavailable', actorId: 'operator', idempotencyKey: 'workspace-recovery' };
			for (const fault of ['denied', 'open-success', 'unidentified-404'] as const) {
				f.setFault(fault); const before = await f.snapshot();
				await expect(service.recover('team', f.assignment.id, input)).rejects.toBeInstanceOf(Error);
				expect(await f.snapshot()).toEqual(before); expect((await f.query('SELECT * FROM capacity_audit_events')).rows).toEqual([]);
			}
			f.setFault('none'); f.setReadResponse({ workspaceId, repoId: 'foreign', status: 'closed' });
			const retained = await f.snapshot(); await expect(service.recover('team', f.assignment.id, input))
				.rejects.toMatchObject({ code: 'assignment_terminal_workspace_readback_invalid' }); expect(await f.snapshot()).toEqual(retained);
			f.setReadResponse(undefined);
			expect(await service.recover('team', f.assignment.id, input)).toMatchObject({ usageStatus: 'unresolved', settled: false });
			expect(await f.client.workspaces.get(workspaceId)).toMatchObject({ workspaceId, status: 'closed' });
			expect((await f.query('SELECT * FROM capacity_usage_actuals')).rows).toEqual([]);
			expect((await f.query('SELECT * FROM capacity_ledger_entries')).rows).toEqual([]);
			expect((await f.snapshot()).capacity_provider_assignments).toEqual(retained.capacity_provider_assignments);
		} finally { await f.close(); }
	});
});
