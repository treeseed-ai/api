import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssignmentCompletionEvidence } from '@treeseed/sdk/agent-capacity';
import { ProviderAssignmentLifecycleService } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { CapacityRuntimeEvidenceRepository } from '../../../../../../../src/api/capacity/repositories/runtime/runtime-evidence.ts';
import { executePostgresBatch } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { workspaceCleanupFixture, workspaceId } from '../../architecture/workspace-cleanup-fixture.ts';
import { cancellationDatabase, cancelNow } from '../../architecture/cancellation-fixture.ts';

// REAL lifecycle/transaction/row-lock/original SQL and independent official
// TreeDX HTTP read. Upstream state, principal, time and measurements are isolated
// inputs, NOT a native TreeDX server, actual provider charge or server concurrency.
afterEach(() => vi.useRealTimers());
const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
const report = { leaseToken: 'lease-token', code: 'assignment_timeout', retryable: false,
	activeSeconds: 2, elapsedSeconds: 3, usage: { inputTokens: 7, nativeUsage: { activeSeconds: 2, tokens: 7 } } };
const returnedCompletion: AssignmentCompletionEvidence = { disposition: 'blocked',
	acceptanceChecks: [{ id: 'isolated-work-item', passed: false }], durableArtifactRefs: [], remainingBudget: {},
	completionReason: 'Isolated provider return input; unfinished work requires a later authorized attempt.', noUsefulScopedWorkRemaining: false };
async function fixture() {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(cancelNow));
	const native = await workspaceCleanupFixture();
	return { ...native, ...await lifecycle(native) };
}
async function lifecycle(native: Awaited<ReturnType<typeof cancellationDatabase>>) {
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
	return { repository, service: new ProviderAssignmentLifecycleService(store) };
}
async function returnFixture() {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T21:00:02.000Z'));
	const native = await cancellationDatabase('leased', true);
	try {
		// Isolated two-attempt policy INPUT. Original productive seconds/deadline
		// and frozen attempt remain unchanged; this does not raise a live allowance.
		const envelope = structuredClone(native.assignment.capacityEnvelope);
		if (!envelope.budget) throw new Error('Missing original bounded assignment budget');
		envelope.budget.maxAttempts = 2;
		await native.query('UPDATE capacity_provider_assignments SET capacity_envelope_json=? WHERE id=?',
			[JSON.stringify(envelope), native.assignment.id]);
		return { ...native, ...await lifecycle(native), close: () => native.db.close() };
	} catch (error) { await native.db.close(); throw error; }
}
describe('provider terminal reporting through original transaction and resource custody', () => {
	it('advances the retryable returned node revision without rewriting its historical assignment attempt', async () => {
		const native = await returnFixture();
		try {
			const before = (await native.repository.get('team', native.assignment.id))!;
			const input = { leaseToken: 'lease-token', code: 'provider_assignment_returned',
				activeSeconds: 1, elapsedSeconds: 2, completion: returnedCompletion }, original = structuredClone(input);
			const result = await native.service.return(principal, before.id, input);
			const node = (await native.query('SELECT status,node_revision FROM execution_nodes WHERE id=?', [native.attempt.nodeId])).rows[0];
			expect(result?.assignment.status).toBe('returned'); expect(input).toEqual(original);
			expect(result?.assignment.assignmentAttempt).toEqual(before.assignmentAttempt);
			expect({ ordinal: result?.assignment.attemptCount, node }).toEqual({ ordinal: before.attemptCount,
				node: { status: 'ready', node_revision: native.attempt.nodeRevision + 1 } });
		} finally { await native.close(); }
	});
	it('settles measured returned work exactly once and releases its consumed reservation before another attempt', async () => {
		const native = await returnFixture();
		try {
			const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
				usage: { inputTokens: 7, nativeUsage: { activeSeconds: 1, tokens: 7 } }, completion: returnedCompletion };
			expect((await native.service.return(principal, native.assignment.id, input))?.assignment.status).toBe('returned');
			const observations = {
				usage: (await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows,
				ledger: (await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows,
				reservation: (await native.query('SELECT state FROM capacity_reservations WHERE id=\'reservation\'')).rows,
			};
			const beforeReplay = await native.snapshot();
			await expect(native.service.return(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(beforeReplay);
			expect(observations).toEqual({ usage: [{ active_seconds: 1, elapsed_seconds: 2 }],
				ledger: [{ total: 1 }], reservation: [{ state: 'settled' }] });
		} finally { await native.close(); }
	});
	it('retains wrong-owner token and expired-return denials without changing graph or financial authority', async () => {
		const native = await returnFixture();
		try {
			const before = await native.snapshot(), graph = (await native.query('SELECT * FROM execution_nodes ORDER BY id')).rows;
			const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2, completion: returnedCompletion };
			for (const owner of [{ ...principal, membershipId: 'foreign' }, { ...principal, capacityProviderId: 'foreign' }])
				await expect(native.service.return(owner, native.assignment.id, input)).resolves.toBeNull();
			await expect(native.service.return(principal, native.assignment.id, { ...input, leaseToken: 'foreign' })).resolves.toBeNull();
			vi.setSystemTime(new Date(native.attempt.deadline));
			await expect(native.service.return(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(before); expect((await native.query('SELECT * FROM execution_nodes ORDER BY id')).rows).toEqual(graph);
		} finally { await native.close(); }
	});
	it('commits one returned transition and graph revision for concurrent matching reports and read-only replay', async () => {
		const native = await returnFixture();
		try {
			const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2, completion: returnedCompletion };
			const original = structuredClone(input), revisionCount = Number((await native.query('SELECT COUNT(*) AS total FROM execution_graph_revisions')).rows[0]!.total);
			const results = await Promise.all([native.service.return(principal, native.assignment.id, input),
				native.service.return(principal, native.assignment.id, input)]);
			const observations = { transitioned: results.filter(Boolean).length,
				revisions: Number((await native.query('SELECT COUNT(*) AS total FROM execution_graph_revisions')).rows[0]!.total) - revisionCount };
			const terminal = await native.snapshot(), graph = (await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows;
			await expect(native.service.return(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(input).toEqual(original); expect(await native.snapshot()).toEqual(terminal);
			expect((await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows).toEqual(graph);
			expect(observations).toEqual({ transitioned: 1, revisions: 1 });
		} finally { await native.close(); }
	});
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
