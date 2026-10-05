import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverExpiredProviderAssignments } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import { OperatorAssignmentService } from '../../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { principal, returnedCompletion, completionFixture } from './terminal-report-fixture.ts';

// Real original-DDL owning transactions and public service methods. The
// preparation/execution clocks and previously settled measurements are inputs.
// Embedded calls are NOT independent server connections or physical teardown.
afterEach(() => vi.useRealTimers());
const completion = (f: Awaited<ReturnType<typeof completionFixture>>) => ({ leaseToken: 'lease-token',
	activeSeconds: 1, elapsedSeconds: 2, output: { assignmentResult: f.result } });
const failure = { leaseToken: 'lease-token', code: 'provider_assignment_failed', retryable: false,
	activeSeconds: 1, elapsedSeconds: 2, usage: { inputTokens: 7, nativeUsage: { activeSeconds: 1, tokens: 7 } } };
async function financialTruth(f: Awaited<ReturnType<typeof completionFixture>>) {
	return { usage: (await f.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
		ledger: (await f.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows,
		reservations: (await f.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
		counters: (await f.query('SELECT * FROM capacity_admission_counters ORDER BY id')).rows };
}
describe('terminal races preserve one immutable attempt and prior measured truth', () => {
	it('concurrent matching completions publish one canonical result and one graph transition without another settlement', async () => {
		const f = await completionFixture(); try {
			const input = completion(f), before = await financialTruth(f), immutable = structuredClone(f.attempt);
			const revision = Number((await f.query('SELECT COUNT(*) AS total FROM execution_graph_revisions')).rows[0]!.total);
			const results = await Promise.all([f.service.complete(principal, f.attempt.id, input), f.service.complete(principal, f.attempt.id, input)]);
			const terminal = await f.repository.get('team', f.attempt.id);
			expect(results.filter(Boolean)).toHaveLength(1); expect(terminal?.assignmentResult).toEqual(f.result);
			expect(terminal?.assignmentAttempt).toEqual(immutable); expect(terminal?.attemptCount).toBe(immutable.attempt);
			expect(await financialTruth(f)).toEqual(before);
			expect(Number((await f.query('SELECT COUNT(*) AS total FROM execution_graph_revisions')).rows[0]!.total) - revision).toBe(1);
			const snapshot = await f.snapshot(); expect(await f.service.complete(principal, f.attempt.id, input)).toBeNull(); expect(await f.snapshot()).toEqual(snapshot);
		} finally { await f.close(); }
	});
	it('simultaneous completion and failure have one winner while every original native measurement and attempt remains unchanged', async () => {
		const f = await completionFixture(); try {
			const before = await financialTruth(f), immutable = structuredClone(f.attempt);
			const outcomes = await Promise.allSettled([f.service.complete(principal, f.attempt.id, completion(f)), f.service.fail(principal, f.attempt.id, failure)]);
			const successes = outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value !== null);
			const terminal = await f.repository.get('team', f.attempt.id);
			expect(successes).toHaveLength(1); expect(['completed', 'failed']).toContain(terminal?.status);
			expect(terminal?.assignmentAttempt).toEqual(immutable); expect(terminal?.attemptCount).toBe(immutable.attempt);
			expect(terminal?.leaseToken).toBeNull(); expect(await financialTruth(f)).toEqual(before);
			if (terminal?.status === 'completed') expect(terminal.assignmentResult).toEqual(f.result);
		} finally { await f.close(); }
	});
	it('simultaneous completion and bounded return cannot both transition or overwrite their predecessor candidate', async () => {
		const f = await completionFixture(); try {
			const before = await financialTruth(f), immutable = structuredClone(f.attempt);
			const outcomes = await Promise.allSettled([f.service.complete(principal, f.attempt.id, completion(f)),
				f.service.return(principal, f.attempt.id, { ...failure, completion: returnedCompletion })]);
			expect(outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value !== null)).toHaveLength(1);
			const terminal = await f.repository.get('team', f.attempt.id); expect(['completed', 'returned']).toContain(terminal?.status);
			expect(terminal?.assignmentAttempt).toEqual(immutable); expect(terminal?.attemptCount).toBe(immutable.attempt);
			expect(await financialTruth(f)).toEqual(before);
			const beforeReplay = await f.snapshot(); await f.service.return(principal, f.attempt.id, { ...failure, completion: returnedCompletion });
			expect(await f.snapshot()).toEqual(beforeReplay);
		} finally { await f.close(); }
	});
	it('operator cancellation request and provider terminal return release once without erasing previously settled work', async () => {
		const f = await completionFixture(); try {
			const measured = await financialTruth(f), immutable = structuredClone(f.attempt);
			const request = await new OperatorAssignmentService(f.owner).cancel('team', f.attempt.id, { idempotencyKey: 'race-cancel' });
			expect(request.status).toBe('leased'); expect(request.metadata.cancellationRequested).toBe(true);
			expect(request.assignmentAttempt).toEqual(immutable); expect(await financialTruth(f)).toEqual(measured);
			const terminal = await f.service.return(principal, f.attempt.id, { ...failure, completion: returnedCompletion });
			expect(terminal?.assignment.status).toBe('cancelled'); expect(terminal?.assignment.assignmentAttempt).toEqual(immutable);
			expect(terminal?.assignment.attemptCount).toBe(immutable.attempt); expect(await financialTruth(f)).toEqual(measured);
			const after = await f.snapshot(); expect(await f.service.return(principal, f.attempt.id, failure)).toBeNull(); expect(await f.snapshot()).toEqual(after);
		} finally { await f.close(); }
	});
	it('terminal reporting races with native recovery selection without returning productive authority or charging twice', async () => {
		const f = await completionFixture(); try {
			const before = await financialTruth(f), immutable = structuredClone(f.attempt);
			const outcomes = await Promise.allSettled([f.service.complete(principal, f.attempt.id, completion(f)),
				recoverExpiredProviderAssignments(f.store, { now: '2026-10-02T21:00:02.000Z', teamId: 'team', providerId: 'provider' })]);
			expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true);
			const terminal = await f.repository.get('team', f.attempt.id); expect(terminal?.status).toBe('completed');
			expect(terminal?.assignmentAttempt).toEqual(immutable); expect(terminal?.attemptCount).toBe(immutable.attempt);
			expect(await financialTruth(f)).toEqual(before);
			expect(await recoverExpiredProviderAssignments(f.store, { now: '2026-10-02T21:10:00.000Z', teamId: 'team', providerId: 'provider' }))
				.toMatchObject({ scanned: 0, recovered: 0 });
		} finally { await f.close(); }
	});
	it('rejects stale node and graph revisions before completing against rewritten operational authority', async () => {
		const observations: boolean[] = [];
		for (const change of ["UPDATE execution_nodes SET node_revision=node_revision+1", "UPDATE capacity_provider_assignments SET execution_node_revision=execution_node_revision+1", "UPDATE capacity_provider_assignments SET graph_revision=graph_revision+1"]) {
			const f = await completionFixture(); try {
				await f.db.exec(change); const before = await f.snapshot(), graph = (await f.query('SELECT * FROM execution_nodes ORDER BY id')).rows;
				const outcome = await f.service.complete(principal, f.attempt.id, completion(f)).then(value => value === null, () => true);
				observations.push(outcome && JSON.stringify(await f.snapshot()) === JSON.stringify(before)
					&& JSON.stringify((await f.query('SELECT * FROM execution_nodes ORDER BY id')).rows) === JSON.stringify(graph));
			} finally { await f.close(); }
		}
		expect(observations).toEqual([true, true, true]);
	});
	it('native late result-write interruption rolls back the transition while preserving prior settlement and exact retry input', async () => {
		const f = await completionFixture(); try {
			await f.db.exec("CREATE FUNCTION reject_completion_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RAISE EXCEPTION 'isolated late completion interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_completion_write BEFORE UPDATE ON capacity_provider_assignments FOR EACH ROW EXECUTE FUNCTION reject_completion_write();");
			const before = await f.snapshot(), graph = (await f.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows, input = completion(f), original = structuredClone(input);
			await expect(f.service.complete(principal, f.attempt.id, input)).rejects.toThrow('isolated late completion interruption');
			expect(await f.snapshot()).toEqual(before); expect((await f.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows).toEqual(graph); expect(input).toEqual(original);
			await f.db.exec('DROP TRIGGER reject_completion_write ON capacity_provider_assignments; DROP FUNCTION reject_completion_write();');
			expect((await f.service.complete(principal, f.attempt.id, input))?.assignment.assignmentResult).toEqual(f.result);
			expect((await f.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await f.close(); }
	});
	it('expired productive authority never accepts a late success even with matching settled usage and a still-present candidate', async () => {
		const f = await completionFixture(); try {
			vi.setSystemTime(new Date(f.attempt.deadline)); const before = await f.snapshot(), input = completion(f), original = structuredClone(input);
			expect(await f.service.complete(principal, f.attempt.id, input)).toBeNull(); expect(await f.snapshot()).toEqual(before); expect(input).toEqual(original);
		} finally { await f.close(); }
	});
});
