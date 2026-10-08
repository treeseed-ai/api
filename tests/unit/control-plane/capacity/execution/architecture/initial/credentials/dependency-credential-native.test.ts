import { randomUUID } from 'node:crypto';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { PROVIDER_MEMBERSHIP_SCOPES } from '@treeseed/sdk/capacity-provider/contracts';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../../../../../../../../src/api/capacity/security.ts';
import { dependencyCredential } from './dependency-credential-fixture.ts';

async function credential(response: Response) {
	expect(response.status).toBe(200); const value: unknown = await response.json();
	if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('Original credential response missing');
	const data = CONTROL_PLANE_OPERATIONS.providers.exchangeCredential.schema.output.parse(value.data);
	if (typeof data.credential !== 'string' || !data.credential || typeof data.id !== 'string') throw new Error('Issued credential authority missing');
	return { data, secret: data.credential, id: data.id };
}

describe('real public credential rotation authorization exchange and dependency poll', () => {
	it('actual authenticated credential rotation and signed exchange issue one exact generation and its token polls the unchanged dependency attempt', async () => {
		const f = await dependencyCredential(); try {
			const custody = await f.custody(), before = await f.credentialState(); expect((await f.evaluate()).eligible).toBe(true);
			expect(before.credentials.find(row => row.id === 'token-credential')?.status).toBe('revoked'); expect(before.tokens.every(row => row.status === 'revoked')).toBe(true);
			const issued = await credential(await f.exchange());
			const publicIdentity = Object.fromEntries(['membershipId', 'teamId', 'providerId', 'issuanceGeneration', 'status', 'scopes', 'rotatedFromCredentialId'].map(key => [key, issued.data[key]]));
			expect(publicIdentity).toEqual({ membershipId: 'membership', teamId: 'team', providerId: 'provider', issuanceGeneration: 2,
				status: 'active', scopes: [...PROVIDER_MEMBERSHIP_SCOPES], rotatedFromCredentialId: 'token-credential' });
			const state = await f.credentialState(), row = state.credentials.find(value => value.id === issued.id); expect(row).toMatchObject({
				membership_id: 'membership', issuance_generation: 2, issue_idempotency_key: f.exchangeBody.idempotencyKey, status: 'active' });
			expect(typeof row?.revealed_at).toBe('string'); expect(state.authorizations.find(value => value.id === f.authorization.id)).toMatchObject({ status: 'issued', issued_credential_id: issued.id });
			expect(state.nonces.filter(value => value.jti === f.exchangePayload.jti)).toHaveLength(1);
			expect(state.audit.filter(value => value.action === 'provider-credential.issued' && value.resource_id === issued.id)).toHaveLength(1);
			const token = await f.issueExchanged(issued.secret, issued.id), response = await f.request(f.requestBody, { token }); expect(response.status).toBe(200);
			const value: unknown = await response.json(); if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('Original poll data missing');
			const polled = CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(value.data);
			expect(polled).toMatchObject({ assignment: {
				id: f.attempt.id, assignmentAttempt: { ...f.attempt, status: 'leased' }, workspaceContext: { predecessorResults: [f.actor, f.review] } } });
			expect(polled.assignment?.assignmentAttempt).toEqual({ ...f.attempt, status: 'leased' }); expect(f.attempt.status).toBe('created');
			const leased = await f.repository.get('team', f.attempt.id); expect(leased?.status).toBe('leased'); expect(Date.parse(leased?.leaseExpiresAt ?? '')).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			for (const old of before.credentials) expect(state.credentials).toContainEqual(old); for (const old of before.audit) expect(state.audit).toContainEqual(old);
			expect(await f.custody()).toEqual(custody); expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
	it('missing unapproved foreign revoked stale and malformed public exchange authority denies without credential issuance or financial changes', async () => {
		for (const mode of ['missing-request', 'pending', 'rejected', 'cancelled', 'member', 'missing-member', 'revoked-provider', 'version', 'signature', 'path', 'key', 'missing-proof', 'authorization'] as const) {
			const f = await dependencyCredential(); try {
				expect((await f.evaluate()).eligible).toBe(true); expect(f.authorization).toMatchObject({ generation: 2, status: 'pending' });
				let proof = f.proof(f.exchangePayload); const options: Parameters<typeof f.exchange>[1] = {};
				if (mode === 'missing-request') options.requestId = 'foreign-request';
				if (mode === 'pending' || mode === 'rejected' || mode === 'cancelled') await f.query("UPDATE capacity_provider_registration_requests SET status=? WHERE id='credential-request'", [mode]);
				if (mode === 'member') await f.query("UPDATE capacity_provider_team_memberships SET status='suspended' WHERE id='membership'");
				if (mode === 'missing-member') await f.query("UPDATE capacity_provider_registration_requests SET membership_id='foreign-membership' WHERE id='credential-request'");
				if (mode === 'revoked-provider') await f.query("UPDATE capacity_providers SET status='revoked' WHERE id='provider'");
				if (mode === 'version') proof = f.proof({ ...f.exchangePayload, identityVersion: 2 });
				if (mode === 'signature') proof = { ...proof, signature: Buffer.alloc(64).toString('base64url') };
				if (mode === 'path') proof = f.proof({ ...f.exchangePayload, path: '/foreign' }); if (mode === 'key') options.key = 'foreign-issuance-key';
				if (mode === 'missing-proof') options.body = { proof: null };
				if (mode === 'authorization') await f.query("UPDATE capacity_provider_credential_issuance_authorizations SET status='cancelled' WHERE id=?", [f.authorization.id]);
				const before = await f.credentialState(), custody = await f.custody(); const response = await f.exchange(proof, options);
				expect(response.status).toBe(['missing-request', 'pending', 'rejected', 'cancelled', 'authorization'].includes(mode) ? 409 : ['member', 'missing-member', 'revoked-provider'].includes(mode) ? 403 : 401);
				const after = await f.credentialState();
				if (mode === 'authorization') { expect(after.nonces).toHaveLength(before.nonces.length + 1); expect({ ...after, nonces: before.nonces }).toEqual(before); }
				else expect(after).toEqual(before);
				expect(await f.custody()).toEqual(custody);
				expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			} finally { await f.close(); }
		}
	});
	it('concurrent same key exchanges and fresh nonce replay retain one exact credential while duplicate nonce and different issuance key cannot reveal another', async () => {
		const f = await dependencyCredential(); try {
			const custody = await f.custody(), original = f.proof(f.exchangePayload);
			const responses = await Promise.all([f.exchange(original), f.exchange(f.proof({ ...f.exchangePayload, jti: randomUUID() }))]);
			const issued = await credential(responses[0]!), other = await credential(responses[1]!); expect(other.id).toBe(issued.id); expect(other.secret === issued.secret).toBe(true);
			const before = await f.credentialState(); expect(before.credentials.filter(row => row.status === 'active')).toHaveLength(1);
			expect(before.audit.filter(row => row.action === 'provider-credential.issued')).toHaveLength(1);
			expect((await f.exchange(original)).status).toBe(409); expect(await f.credentialState()).toEqual(before);
			const retry = await credential(await f.exchange(f.proof({ ...f.exchangePayload, jti: randomUUID() }))); expect(retry.id).toBe(issued.id); expect(retry.secret === issued.secret).toBe(true);
			const replay = await f.credentialState(); expect(replay.credentials).toEqual(before.credentials); expect(replay.authorizations).toEqual(before.authorizations); expect(replay.audit).toEqual(before.audit);
			const changedKey = 'different-exchange-key';
			const denied = await f.exchange(f.proof({ ...f.exchangePayload, jti: randomUUID(), bodySha256: sha256(canonicalJson({ ...f.exchangeBody, idempotencyKey: changedKey })) }), { key: changedKey });
			expect(denied.status).toBe(409); const after = await f.credentialState(); expect(after.credentials).toEqual(replay.credentials); expect(after.authorizations).toEqual(replay.authorizations); expect(after.audit).toEqual(replay.audit);
			expect(after.nonces).toHaveLength(replay.nonces.length + 1); expect(await f.custody()).toEqual(custody); expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
	it('native credential insert interruption rolls back authorization consumption but retains proof nonce before same key fresh signed retry commits once', async () => {
		const f = await dependencyCredential(); try {
			const before = await f.credentialState(), custody = await f.custody();
			await f.db.exec(`CREATE FUNCTION interrupt_credential_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.issuance_generation=2 THEN RAISE EXCEPTION 'credential insert interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_credential_insert BEFORE INSERT ON capacity_provider_team_credentials FOR EACH ROW EXECUTE FUNCTION interrupt_credential_insert();`);
			expect((await f.exchange()).status).toBe(500); const failed = await f.credentialState();
			expect(failed.nonces).toHaveLength(before.nonces.length + 1); expect({ ...failed, nonces: before.nonces }).toEqual(before);
			await f.db.exec('DROP TRIGGER interrupt_credential_insert ON capacity_provider_team_credentials; DROP FUNCTION interrupt_credential_insert();');
			expect((await f.exchange()).status).toBe(409); expect(await f.credentialState()).toEqual(failed);
			const issued = await credential(await f.exchange(f.proof({ ...f.exchangePayload, jti: randomUUID() }))), after = await f.credentialState();
			expect(after.authorizations.find(row => row.id === f.authorization.id)).toMatchObject({ status: 'issued', issued_credential_id: issued.id });
			expect(after.credentials.filter(row => row.status === 'active')).toHaveLength(1); expect(after.audit.filter(row => row.action === 'provider-credential.issued')).toHaveLength(1);
			for (const row of failed.nonces) expect(after.nonces).toContainEqual(row); for (const row of before.audit) expect(after.audit).toContainEqual(row);
			expect(await f.custody()).toEqual(custody); expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
	it('late credential audit interruption preserves issued authorization revealed credential and nonce before exact same key fresh proof recovers one missing audit', async () => {
		const f = await dependencyCredential(); try {
			const custody = await f.custody(); await f.db.exec(`CREATE FUNCTION interrupt_credential_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.action='provider-credential.issued' THEN RAISE EXCEPTION 'credential audit interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_credential_audit BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_credential_audit();`);
			expect((await f.exchange()).status).toBe(500); const failed = await f.credentialState(), rows = failed.credentials.filter(row => row.status === 'active'); expect(rows).toHaveLength(1);
			expect(typeof rows[0]?.revealed_at).toBe('string'); expect(failed.authorizations.find(row => row.id === f.authorization.id)?.status).toBe('issued');
			await f.db.exec('DROP TRIGGER interrupt_credential_audit ON capacity_audit_events; DROP FUNCTION interrupt_credential_audit();');
			const recovered = await credential(await f.exchange(f.proof({ ...f.exchangePayload, jti: randomUUID() }))); expect(recovered.id).toBe(rows[0]?.id);
			const after = await f.credentialState(); expect(after.credentials).toEqual(failed.credentials); expect(after.authorizations).toEqual(failed.authorizations);
			for (const row of failed.nonces) expect(after.nonces).toContainEqual(row); for (const row of failed.audit) expect(after.audit).toContainEqual(row);
			expect(after.audit.filter(row => row.action === 'provider-credential.issued')).toHaveLength(1); expect(await f.custody()).toEqual(custody);
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
});
