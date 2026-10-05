import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceId } from '../../architecture/workspace-cleanup-fixture.ts';
import { principal, report, returnedCompletion, fixture, returnFixture, completionFixture } from './terminal-report-fixture.ts';

// REAL owning SQL/transaction boundary with supplied clocks and usage.
afterEach(() => vi.useRealTimers());
describe('provider terminal reporting through original transaction and resource custody', () => {
	it('denies completed result clocks outside the immutable attempt and actual reporting interval without state mutation', async () => {
		const observations: boolean[] = [];
		for (const clock of ['2026-10-02T20:59:59.000Z', '2026-10-02T21:00:02.001Z', '2026-10-02T21:00:04.000Z']) {
			const native = await completionFixture();
			try {
				const before = await native.snapshot(), graph = (await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows;
				const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
					output: { assignmentResult: { ...native.result, completedAt: clock } } }, original = structuredClone(input);
				let denied = false;
				try { denied = await native.service.complete(principal, native.assignment.id, input) === null; } catch { denied = true; }
				observations.push(denied && JSON.stringify(await native.snapshot()) === JSON.stringify(before)
					&& JSON.stringify((await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows) === JSON.stringify(graph));
				expect(input).toEqual(original);
			} finally { await native.close(); }
		}
		expect(observations).toEqual([true, true, true]);
	});
	it('retains canonical completed result after public exactly-once settlement and replays without another charge', async () => {
		const native = await completionFixture();
		try {
			const settled = await native.snapshot(), nodes = (await native.query('SELECT * FROM execution_nodes ORDER BY id')).rows,
				revisions = (await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows;
			for (const field of ['id', 'assignmentId'] as const) for (const nested of [false, true]) {
				const changed = { ...native.result, [field]: ` ${native.result[field]} ` }, invalid = {
					leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
					...(nested ? { output: { assignmentResult: changed } } : { assignmentResult: changed }) };
				const supplied = structuredClone(invalid);
				await expect(native.service.complete(principal, native.assignment.id, invalid)).rejects.toMatchObject({ code: 'assignment_result_invalid' });
				expect(invalid).toEqual(supplied); expect(await native.snapshot()).toEqual(settled);
				expect((await native.query('SELECT * FROM execution_nodes ORDER BY id')).rows).toEqual(nodes);
				expect((await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows).toEqual(revisions);
			}
			const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
				usage: { inputTokens: 7, nativeUsage: { activeSeconds: 1, tokens: 7 } }, output: { assignmentResult: native.result } }, original = structuredClone(input);
			const result = await native.service.complete(principal, native.assignment.id, input);
			expect(result?.assignment.status).toBe('completed'); expect(result?.assignment.assignmentResult).toEqual(native.result);
			const terminal = await native.snapshot();
			await expect(native.service.complete(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(terminal); expect(input).toEqual(original);
			expect({ usage: (await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows,
				ledger: (await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows,
				reservation: (await native.query("SELECT state FROM capacity_reservations WHERE id='reservation'")).rows })
				.toEqual({ usage: [{ active_seconds: 1, elapsed_seconds: 2 }], ledger: [{ total: 1 }], reservation: [{ state: 'consumed' }] });
		} finally { await native.close(); }
	});
	it('denies completion before public settlement without creating a result or rewriting financial authority', async () => {
		const native = await completionFixture(false);
		try {
			const before = await native.snapshot();
			await expect(native.service.complete(principal, native.assignment.id, { leaseToken: 'lease-token',
				output: { assignmentResult: native.result } })).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(before);
		} finally { await native.close(); }
	});
	it('denies noncompleted result status and wrong completion owner token or deadline without changing stored authority', async () => {
		const native = await completionFixture();
		try {
			const before = await native.snapshot(), input = { leaseToken: 'lease-token', output: { assignmentResult: native.result } };
			for (const status of ['blocked', 'failed'] as const)
				await expect(native.service.complete(principal, native.assignment.id, { ...input, output: { assignmentResult: { ...native.result, status } } }))
					.rejects.toMatchObject({ code: 'assignment_content_result_invalid' });
			for (const completedAt of [undefined, 'invalid'])
				await expect(native.service.complete(principal, native.assignment.id, { ...input, output: { assignmentResult: { ...native.result, completedAt } } }))
					.rejects.toMatchObject({ code: 'assignment_result_invalid' });
			for (const owner of [{ ...principal, membershipId: 'foreign' }, { ...principal, capacityProviderId: 'foreign' }])
				await expect(native.service.complete(owner, native.assignment.id, input)).resolves.toBeNull();
			await expect(native.service.complete(principal, native.assignment.id, { ...input, leaseToken: 'foreign' })).resolves.toBeNull();
			vi.setSystemTime(new Date(native.attempt.deadline));
			await expect(native.service.complete(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(before);
		} finally { await native.close(); }
	});
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
				ledger: [{ total: 1 }], reservation: [{ state: 'consumed' }] });
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
