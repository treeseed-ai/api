import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceCleanupFixture, workspaceId } from './workspace-cleanup-fixture.ts';
import { cancelNow } from './cancellation-fixture.ts';
import { closeTerminalAssignmentWorkspace } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-terminal-workspace.ts';
import { terminalizeCapacityWorkdayAssignments } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';
import { OperatorAssignmentService } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function isolate() {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(cancelNow));
}
describe('native terminal workspace closure and SQL proxy custody', () => {
	it('does not turn an unidentified upstream 404 denial into durable workspace closure', async () => {
		isolate(); const native = await workspaceCleanupFixture();
		try {
			native.setFault('unidentified-404'); let denied = false;
			try { await terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: cancelNow }); } catch { denied = true; }
			expect({ denied, handles: (await native.query('SELECT status FROM treedx_proxy_handles')).rows,
				remote: await native.client.workspaces.get(workspaceId) })
				.toMatchObject({ denied: true, handles: [{ status: 'issued' }], remote: { status: 'open' } });
		} finally { await native.close(); }
	});
	it('closes the exact remote workspace before durable proxy revocation and retains settlement through replay', async () => {
		isolate(); const native = await workspaceCleanupFixture();
		try {
			const result = await terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: cancelNow });
			expect(result.unfinishedAssignmentCount).toBe(0);
			expect(await native.client.workspaces.get(workspaceId)).toMatchObject({ workspaceId, status: 'closed' });
			expect((await native.query('SELECT status,revoked_at FROM treedx_proxy_handles')).rows).toEqual([{ status: 'revoked', revoked_at: cancelNow }]);
			const before = await native.snapshot();
			await terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: cancelNow });
			expect(await native.snapshot()).toEqual(before);
			expect(native.requests.filter(route => route.startsWith('POST'))).toEqual([`POST /api/v1/workspaces/${workspaceId}/close`]);
			expect((await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
		} finally { await native.close(); }
	});
	it('keeps explicit already-absent closure idempotent through the actual HTTP error contract', async () => {
		isolate(); const native = await workspaceCleanupFixture();
		try {
			native.setFault('absent');
			await terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: cancelNow });
			expect((await native.query('SELECT status FROM treedx_proxy_handles')).rows).toEqual([{ status: 'revoked' }]);
			expect(await native.client.workspaces.get(workspaceId)).toMatchObject({ status: 'absent' });
		} finally { await native.close(); }
	});
	it('does not skip an open workspace merely because its SQL capability handle is already revoked', async () => {
		isolate(); const native = await workspaceCleanupFixture('revoked');
		try {
			await terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: cancelNow });
			expect(await native.client.workspaces.get(workspaceId)).toMatchObject({ workspaceId, status: 'closed' });
			expect(native.requests.filter(route => route.startsWith('POST'))).toEqual([`POST /api/v1/workspaces/${workspaceId}/close`]);
		} finally { await native.close(); }
	});
	it('retries an interrupted operator close through workday cleanup even after durable capability revocation', async () => {
		isolate(); const native = await workspaceCleanupFixture();
		try {
			native.setFault('denied');
			await expect(new OperatorAssignmentService(native.owner, assignment => closeTerminalAssignmentWorkspace(native.owner, assignment))
				.cancel('team', native.assignment.id, { idempotencyKey: 'workspace-cancel' })).rejects.toMatchObject({ status: 403 });
			expect((await native.query('SELECT status FROM treedx_proxy_handles')).rows).toEqual([{ status: 'revoked' }]);
			expect(await native.client.workspaces.get(workspaceId)).toMatchObject({ status: 'open' });
			native.setFault('none');
			await terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: cancelNow });
			expect(await native.client.workspaces.get(workspaceId)).toMatchObject({ status: 'closed' });
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await native.close(); }
	});
	it('rejects a still-open success response instead of certifying closure without authoritative resource agreement', async () => {
		isolate(); const native = await workspaceCleanupFixture();
		try {
			native.setFault('open-success'); const assignment = (await new ProviderAssignmentRepository(native.owner).get('team', native.assignment.id))!;
			const before = structuredClone(assignment); let denied = false;
			try { await closeTerminalAssignmentWorkspace(native.owner, assignment); } catch { denied = true; }
			expect({ denied, remote: await native.client.workspaces.get(workspaceId) }).toMatchObject({ denied: true, remote: { status: 'open' } });
			expect(assignment).toEqual(before);
		} finally { await native.close(); }
	});
	it('retains recoverable workspace custody when the configured library binding is unavailable', async () => {
		isolate(); const native = await workspaceCleanupFixture();
		try {
			// Removing both exact repository sources prevents fallback to another binding.
			native.setBound(false);
			await native.query("UPDATE capacity_provider_assignments SET workspace_context_json=?,treedx_proxy_handle_json=?", [
				JSON.stringify({ workspaceId }), JSON.stringify({ workspaceId, status: 'issued' })]);
			await expect(terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: cancelNow }))
				.rejects.toMatchObject({ code: 'assignment_terminal_workspace_cleanup_unavailable', status: 503 });
			expect((await native.query('SELECT status FROM treedx_proxy_handles')).rows).toEqual([{ status: 'issued' }]);
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			expect(native.requests).toEqual([]);
		} finally { await native.close(); }
	});
});
