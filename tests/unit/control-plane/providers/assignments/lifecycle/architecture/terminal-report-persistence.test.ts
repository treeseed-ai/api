import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderAssignmentLifecycleService } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { CapacityRuntimeEvidenceRepository } from '../../../../../../../src/api/capacity/repositories/runtime/runtime-evidence.ts';
import { executePostgresBatch } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { workspaceCleanupFixture, workspaceId } from '../../architecture/workspace-cleanup-fixture.ts';
import { cancelNow } from '../../architecture/cancellation-fixture.ts';

// REAL lifecycle/transaction/row-lock/original SQL and independent official
// TreeDX HTTP read. Upstream state, principal, time and measurements are isolated
// inputs, NOT a native TreeDX server, actual provider charge or server concurrency.
afterEach(() => vi.useRealTimers());
const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
const report = { leaseToken: 'lease-token', code: 'assignment_timeout', retryable: false,
	activeSeconds: 2, elapsedSeconds: 3, usage: { inputTokens: 7, nativeUsage: { activeSeconds: 2, tokens: 7 } } };
async function fixture() {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(cancelNow));
	const native = await workspaceCleanupFixture();
	await native.query('UPDATE execution_nodes SET source_ref_json=?,authority_refs_json=?,estimate_json=?,required_capabilities_json=?,requested_permissions_json=?,workspace=? WHERE id=?',
		[JSON.stringify(native.attempt.sourceRef), JSON.stringify(native.attempt.authorityRefs), JSON.stringify(native.attempt.estimate),
			JSON.stringify(native.attempt.requiredCapabilities), JSON.stringify(native.attempt.effectiveProfile.permissionCeiling),
			native.attempt.workspace.mode, native.attempt.nodeId]);
	await native.query("UPDATE capacity_provider_assignments SET status='leased',lease_state='leased',lease_token='lease-token',lease_expires_at=?", [native.attempt.deadline]);
	const repository = new ProviderAssignmentRepository(native.owner), evidence = new CapacityRuntimeEvidenceRepository(native.owner);
	const store = { ...native.owner,
		db: { transaction: async <T>(run: (client: Parameters<typeof executePostgresBatch>[0]) => Promise<T>) =>
			native.db.transaction(transaction => run(transaction as unknown as Parameters<typeof executePostgresBatch>[0])) },
		getProviderAssignment: repository.get.bind(repository), recordAgentFallbackOutput: evidence.recordFallbackOutput.bind(evidence),
		recordProviderAssignmentExplanation: async () => { throw new Error('Terminal reporting must not invoke renewal explanation'); },
		updateCapacityWorkdayRun: async () => { throw new Error('This terminal report must not rewrite workday configuration'); } };
	return { ...native, repository, service: new ProviderAssignmentLifecycleService(store) };
}
describe('provider terminal reporting through original transaction and resource custody', () => {
	it('preserves the immutable attempt ordinal when a terminal report releases its lease and retains measured settlement', async () => {
		const native = await fixture();
		try {
			const before = (await native.repository.get('team', native.assignment.id))!, input = structuredClone(report);
			const result = await native.service.fail(principal, before.id, report);
			expect(result?.assignment.status).toBe('failed');
			expect(result?.assignment.leaseToken).toBeNull();
			expect((await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect(report).toEqual(input);
			expect(result?.assignment.assignmentAttempt).toEqual(before.assignmentAttempt);
			expect(result?.assignment.attemptCount).toBe(before.attemptCount);
		} finally { await native.close(); }
	});
	it('does not certify terminal revocation while the independently read exact workspace remains open', async () => {
		const native = await fixture();
		try {
			const result = await native.service.fail(principal, native.assignment.id, report);
			expect(result?.assignment.status).toBe('failed');
			const handle = (await native.query('SELECT status FROM treedx_proxy_handles')).rows;
			const remote = await native.client.workspaces.get(workspaceId);
			expect({ handle, remote }).toMatchObject({ handle: [{ status: 'revoked' }], remote: { workspaceId, status: 'closed' } });
		} finally { await native.close(); }
	});
	it('retains foreign-owner and wrong-token denials and matching terminal replay without another charge', async () => {
		const native = await fixture();
		try {
			const before = await native.snapshot();
			for (const authority of [{ ...principal, membershipId: 'foreign' }, { ...principal, capacityProviderId: 'foreign' }])
				await expect(native.service.fail(authority, native.assignment.id, report)).resolves.toBeNull();
			await expect(native.service.fail(principal, native.assignment.id, { ...report, leaseToken: 'foreign' })).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(before);
			const matching = await Promise.all([native.service.fail(principal, native.assignment.id, report), native.service.fail(principal, native.assignment.id, report)]);
			expect(matching.filter(Boolean)).toHaveLength(1);
			const terminal = await native.snapshot();
			await expect(native.service.fail(principal, native.assignment.id, report)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(terminal);
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await native.close(); }
	});
	it('rolls back a late SQL authority-revocation failure and retries terminal reporting without another settlement charge', async () => {
		const native = await fixture();
		try {
			const before = await native.snapshot(), handle = (await native.query('SELECT * FROM treedx_proxy_handles')).rows;
			await native.db.exec(`CREATE FUNCTION reject_terminal_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION 'isolated terminal revocation interruption'; END $$;
				CREATE TRIGGER reject_terminal_revoke BEFORE UPDATE ON treedx_proxy_handles
				FOR EACH ROW EXECUTE FUNCTION reject_terminal_revoke();`);
			await expect(native.service.fail(principal, native.assignment.id, report)).rejects.toThrow('isolated terminal revocation interruption');
			expect(await native.snapshot()).toEqual(before);
			expect((await native.query('SELECT * FROM treedx_proxy_handles')).rows).toEqual(handle);
			await native.db.exec('DROP TRIGGER reject_terminal_revoke ON treedx_proxy_handles; DROP FUNCTION reject_terminal_revoke();');
			expect((await native.service.fail(principal, native.assignment.id, report))?.assignment.status).toBe('failed');
			expect((await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await native.close(); }
	});
});
