import { describe, expect, it } from 'vitest';
import { dependencyLease } from './dependency-lease-fixture.ts';
import { createSourceWorkspaceService } from '../../../../../../../../src/api/control-plane/repositories/providers/source/source-workspace-service.ts';
import { createSourceCredentialRecipient } from '@treeseed/deployment/security/source';

describe('owning SQL lease authority for an admitted dependency assignment', () => {
	it('native source authorization retains the admitted canonical repository branch and ordinal through exact repeated reads without changing finance', async () => {
		const f = await dependencyLease();
		try {
			if (f.attempt.workspace.mode !== 'git') throw new Error('Original admitted Git workspace required');
			const workspace = f.attempt.workspace, [owner, name] = workspace.repository.split('/');
			expect(owner && name).toBeTruthy();
			await f.query("UPDATE capacity_provider_assignments SET status='leased',lease_state='leased',runner_id='source-runner',lease_token='controlled-source-lease',lease_expires_at=?,attempt_count=? WHERE id=?",
				[f.attempt.deadline, f.attempt.attempt, f.attempt.id]);
			const service = createSourceWorkspaceService(f.store, { getProject: async () => ({ id: f.attempt.projectId, teamId: f.attempt.teamId }),
				listHubRepositories: async () => [{ id: 'database-repository-id', role: 'software', provider: 'github', owner, name, currentBranch: 'staging' }] },
				{ controlPlaneId: 'https://api.example.invalid', now: () => new Date(f.now), fetchImpl: async () => { throw new Error('Exact local simulation source must not fetch upstream'); } });
			const request = { runnerId: 'source-runner', leaseToken: 'controlled-source-lease', recipientPublicKey: createSourceCredentialRecipient().publicKey };
			const principal = { ...f.principal, scopes: ['provider:assignments:read'] }, first = await service({ principal }, f.attempt.id, request);
			const pinned = await f.snapshot(), retry = await service({ principal }, f.attempt.id, request);
			for (const response of [first, retry]) {
				expect(response.authorization).toMatchObject({ assignmentId: f.attempt.id, attempt: f.attempt.attempt,
					publicationRef: workspace.branch, source: { repositoryId: workspace.repository, commit: workspace.baseCommit } });
				expect(response.repository.ref).toBe(workspace.baseCommit); expect(response.credential).toBeNull();
			}
			expect(await f.snapshot()).toEqual(pinned);
			expect((await f.repository.get(f.attempt.teamId, f.attempt.id))?.assignmentAttempt).toEqual(f.attempt);
		} finally { await f.db.close(); }
	});
	it('actual account reservation workday proxy and availability reads retain the exact admitted dependency context without new financial writes', async () => {
		const f = await dependencyLease(); try {
			const before = await f.snapshot(), authority = await f.evaluate();
			expect(authority).toMatchObject({ eligible: true, reasons: [], sessionId: 'session', gates: { assignmentAuthority: 'living_execution_graph', membershipStatus: 'approved',
				providerStatus: 'active', reservationState: 'reserved', workdayStatus: 'running', workspaceStatus: 'issued', sessionStatus: 'open' } });
			const read = await f.repository.get(f.principal.teamId, f.attempt.id);
			expect(read?.assignmentAttempt).toEqual(f.attempt); expect(read?.workspaceContext.predecessorResults).toEqual([f.actor, f.review]);
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('foreign team provider membership and unavailable identity deny through original SQL joins without changing admitted custody', async () => {
		for (const mode of ['team', 'provider', 'membership', 'suspended', 'revoked'] as const) {
			const f = await dependencyLease(); try {
				expect((await f.evaluate()).eligible).toBe(true);
				const identity = { ...f.principal };
				if (mode === 'team') identity.teamId = 'foreign-team';
				if (mode === 'provider') identity.capacityProviderId = 'foreign-provider';
				if (mode === 'membership') identity.membershipId = 'foreign-membership';
				if (mode === 'suspended') await f.query("UPDATE capacity_provider_team_memberships SET status='suspended' WHERE id='membership'");
				if (mode === 'revoked') await f.query("UPDATE capacity_providers SET status='revoked' WHERE id='provider'");
				const before = await f.snapshot(); expect((await f.evaluate(f.now, identity)).eligible).toBe(false); expect(await f.snapshot()).toEqual(before);
			} finally { await f.db.close(); }
		}
	});
	it('missing inactive and expired exact reservation proxy workday and availability authority deny the owning SQL lease gate', async () => {
		for (const sql of [
			"DELETE FROM capacity_reservations WHERE assignment_id='assignment'",
			"UPDATE capacity_reservations SET state='released' WHERE assignment_id='assignment'",
			"UPDATE capacity_reservations SET expires_at='2026-10-02T21:00:19.000Z' WHERE assignment_id='assignment'",
			"UPDATE treedx_proxy_handles SET status='revoked'",
			"UPDATE treedx_proxy_handles SET expires_at='2026-10-02T21:00:19.000Z'",
			"UPDATE capacity_workday_runs SET status='cancelled' WHERE id='workday'",
			"UPDATE capacity_provider_availability_sessions SET status='closed' WHERE id='session'",
			"UPDATE capacity_provider_availability_sessions SET available_until='2026-10-02T21:00:20.000Z' WHERE id='session'",
		]) {
			const f = await dependencyLease(); try {
				expect((await f.evaluate()).eligible).toBe(true);
				await f.query(sql); const before = await f.snapshot(); expect((await f.evaluate()).eligible).toBe(false); expect(await f.snapshot()).toEqual(before);
			} finally { await f.db.close(); }
		}
	});
	it('malformed authoritative session reservation and proxy clocks and unknown current time deny without granting unbounded lease authority', async () => {
		for (const mode of ['now', 'session-from', 'session-until', 'session-expiry', 'reservation', 'proxy'] as const) {
			const f = await dependencyLease(); try {
				expect((await f.evaluate()).eligible).toBe(true);
				if (mode === 'session-from') await f.query("UPDATE capacity_provider_availability_sessions SET available_from='malformed'");
				if (mode === 'session-until') await f.query("UPDATE capacity_provider_availability_sessions SET available_until='malformed'");
				if (mode === 'session-expiry') await f.query("UPDATE capacity_provider_availability_sessions SET available_until=NULL,expires_at='malformed'");
				if (mode === 'reservation') await f.query("UPDATE capacity_reservations SET expires_at='malformed' WHERE assignment_id='assignment'");
				if (mode === 'proxy') await f.query("UPDATE treedx_proxy_handles SET expires_at='malformed'");
				const before = await f.snapshot();
				const allowed = await f.evaluate(mode === 'now' ? 'malformed' : f.now).then(value => value.eligible, () => false);
				expect(allowed).toBe(false); expect(await f.snapshot()).toEqual(before);
			} finally { await f.db.close(); }
		}
	});
	it('rotated availability retains only the same unexpired supplied lease and explicit closed-session or expired-lease requests stay denied', async () => {
		const f = await dependencyLease(); try {
			expect((await f.evaluate()).eligible).toBe(true);
			await f.query("UPDATE capacity_provider_assignments SET status='leased',lease_state='leased',lease_expires_at=? WHERE id=?", [f.attempt.deadline, f.attempt.id]);
			await f.query("UPDATE capacity_provider_availability_sessions SET status='closed' WHERE id='session'");
			await f.query(`INSERT INTO capacity_provider_availability_sessions (id,membership_id,team_id,capacity_provider_id,opened_at,refreshed_at,expires_at,available_from,available_until,created_at,updated_at)
				VALUES ('rotated','membership','team','provider',?,?,?,?,?,?,?)`, [f.now, f.now, f.attempt.deadline, f.now, f.attempt.deadline, f.now, f.now]);
			const before = await f.snapshot();
			expect(await f.evaluate(f.now, f.principal, null)).toMatchObject({ eligible: true, sessionId: 'rotated' });
			expect((await f.evaluate(f.now, f.principal, 'session')).eligible).toBe(false);
			expect((await f.evaluate(f.attempt.deadline, f.principal, null)).eligible).toBe(false);
			const repeated = await Promise.all([f.evaluate(f.now, f.principal, null), f.evaluate(f.now, f.principal, null)]);
			expect(repeated[0]).toEqual(repeated[1]); expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
});
