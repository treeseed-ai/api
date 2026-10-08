import { randomUUID } from 'node:crypto';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it } from 'vitest';
import { capacityProviderFingerprint } from '../../../../../../../../src/api/capacity/security.ts';
import { dependencyIdentity } from './dependency-identity-fixture.ts';

async function identity(response: Response) {
	expect(response.status).toBe(200); const value: unknown = await response.json();
	if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('Original public identity missing');
	return CONTROL_PLANE_OPERATIONS.providers.rotateIdentity.schema.output.parse(value.data);
}

describe('real signed public identity rotation and token revocation SQL', () => {
	it('actual two proof public rotation revokes old tokens and newly signed issuance polls the unchanged original dependency attempt', async () => {
		const f = await dependencyIdentity(); try {
			const custody = await f.custody(); expect((await f.evaluate()).eligible).toBe(true);
			expect(await f.authenticator.authenticateAccessToken(f.issued.token)).not.toBeNull();
			const result = await identity(await f.rotate()); expect(result).toMatchObject({ providerId: 'provider', identityVersion: 2,
				fingerprint: capacityProviderFingerprint(f.next.publicJwk), publicJwk: f.next.publicJwk, status: 'active' });
			const after = await f.identityState(); expect(after.rotations).toHaveLength(1);
			expect(after.nonces.filter(row => row.jti === f.oldPayload.jti || row.jti === f.newPayload.jti)).toHaveLength(2);
			expect(after.tokens.every(row => row.status === 'revoked')).toBe(true);
			expect(after.audit.filter(row => row.action === 'provider-identity.rotated')).toHaveLength(1);
			expect((await f.request(f.requestBody, { token: f.issued.token })).status).toBe(401);
			const issued = await f.newToken(), response = await f.request(f.requestBody, { token: issued.token }); expect(response.status).toBe(200);
			const value: unknown = await response.json(); if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('Original poll missing');
			expect(CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(value.data)).toMatchObject({ assignment: {
				id: f.attempt.id, assignmentAttempt: { ...f.attempt, status: 'leased' }, workspaceContext: { predecessorResults: [f.actor, f.review] } } });
			const leased = await f.repository.get('team', f.attempt.id); expect(leased?.status).toBe('leased');
			expect(Date.parse(leased?.leaseExpiresAt ?? '')).toBeLessThanOrEqual(Date.parse(f.attempt.deadline)); expect(await f.custody()).toEqual({ ...custody, attempt: { ...custody.attempt, status: 'leased' } });
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
	it('invalid missing mismatched and stale rotation proofs deny with original identity nonce token audit and assignment custody retained', async () => {
		for (const mode of ['missing-old', 'missing-new', 'old-signature', 'new-signature', 'stale-version', 'old-version', 'new-version', 'foreign-key', 'missing-token'] as const) {
			const f = await dependencyIdentity(); try {
				expect((await f.evaluate()).eligible).toBe(true); expect(await f.authenticator.authenticateAccessToken(f.issued.token)).not.toBeNull();
				const body: Record<string, unknown> = structuredClone(f.body);
				if (mode === 'missing-old') delete body.oldProof; if (mode === 'missing-new') delete body.newProof;
				if (mode === 'old-signature') body.oldProof = { ...f.body.oldProof, signature: Buffer.alloc(64).toString('base64url') };
				if (mode === 'new-signature') body.newProof = { ...f.body.newProof, signature: Buffer.alloc(64).toString('base64url') };
				if (mode === 'stale-version') body.expectedIdentityVersion = 0;
				if (mode === 'old-version') body.oldProof = f.proof({ ...f.oldPayload, identityVersion: 2 });
				if (mode === 'new-version') body.newProof = f.next.proof({ ...f.newPayload, identityVersion: 1 });
				if (mode === 'foreign-key') body.newPublicJwk = f.publicJwk;
				const before = await f.identityState(), input = structuredClone(body);
				const status = (await f.rotate(body, mode === 'missing-token' ? '' : f.issued.token)).status;
				expect(status).toBe(mode === 'stale-version' ? 409 : mode === 'missing-old' || mode === 'missing-new' || mode === 'old-version' || mode === 'new-version' ? 400 : 401);
				expect(await f.identityState()).toEqual(before); expect(body).toEqual(input);
			} finally { await f.close(); }
		}
	});
	it('concurrent competing public rotation keys commit one version and same key authenticated replay retains exact rotation nonce and audit history', async () => {
		const f = await dependencyIdentity(); try {
			const custody = await f.custody(), original = await f.identityState(); const other = { ...f.body, oldProof: f.proof({ ...f.oldPayload, jti: randomUUID() }), newProof: f.next.proof({ ...f.newPayload, jti: randomUUID() }) };
			const responses = await Promise.all([f.rotate(), f.rotate(other, f.issued.token, 'competing-rotation')]);
			expect(responses.filter(response => response.status === 200)).toHaveLength(1);
			for (const response of responses.filter(response => response.status !== 200)) expect([401, 409]).toContain(response.status);
			const state = await f.identityState(); expect(state.rotations).toHaveLength(1); expect(state.accounts[0]?.identity_version).toBe(2);
			expect(state.nonces).toHaveLength(original.nonces.length + 2); expect(state.audit.filter(row => row.action === 'provider-identity.rotated')).toHaveLength(1);
			const key = state.rotations[0]?.idempotency_key; if (typeof key !== 'string') throw new Error('Original rotation key missing');
			const issued = await f.newToken(), before = await f.identityState();
			expect(await identity(await f.rotate(f.body, issued.token, key))).toMatchObject({ identityVersion: 2, fingerprint: capacityProviderFingerprint(f.next.publicJwk) });
			expect(await f.identityState()).toEqual(before); expect(await f.custody()).toEqual(custody);
			expect((await f.rotate({ ...f.body, expectedIdentityVersion: 2 }, issued.token, key)).status).toBe(409); expect(await f.identityState()).toEqual(before);
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
	it('late rotation audit failure retains committed identity revoked tokens and both nonces before authenticated same key recovery creates one missing audit', async () => {
		const f = await dependencyIdentity(); try {
			const custody = await f.custody(); await f.db.exec(`CREATE FUNCTION interrupt_identity_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.action='provider-identity.rotated' THEN RAISE EXCEPTION 'identity audit interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_identity_audit BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_identity_audit();`);
			expect((await f.rotate()).status).toBe(500); const failed = await f.identityState(); expect(failed.rotations).toHaveLength(1);
			expect(failed.accounts[0]?.identity_version).toBe(2); expect(failed.tokens.every(row => row.status === 'revoked')).toBe(true);
			expect(failed.nonces.filter(row => row.jti === f.oldPayload.jti || row.jti === f.newPayload.jti)).toHaveLength(2); expect(await f.custody()).toEqual(custody);
			await f.db.exec('DROP TRIGGER interrupt_identity_audit ON capacity_audit_events; DROP FUNCTION interrupt_identity_audit();');
			const issued = await f.newToken(); expect(await identity(await f.rotate(f.body, issued.token))).toMatchObject({ identityVersion: 2 });
			const after = await f.identityState(); expect(after.accounts).toEqual(failed.accounts); expect(after.rotations).toEqual(failed.rotations);
			for (const row of failed.nonces) expect(after.nonces).toContainEqual(row); for (const row of failed.audit) expect(after.audit).toContainEqual(row);
			expect(after.audit.filter(row => row.action === 'provider-identity.rotated')).toHaveLength(1);
			expect(await f.custody()).toEqual(custody); expect((await f.repository.get('team', f.attempt.id))?.status).toBe('pending');
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
	it('native identity update interruption rolls back rotation nonces and token revocation before exact original signed retry commits once', async () => {
		const f = await dependencyIdentity(); try {
			expect((await f.evaluate()).eligible).toBe(true); expect(await f.authenticator.authenticateAccessToken(f.issued.token)).not.toBeNull();
			const before = await f.identityState(), custody = await f.custody(), input = structuredClone(f.body);
			await f.db.exec(`CREATE FUNCTION interrupt_identity_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.identity_version <> OLD.identity_version THEN RAISE EXCEPTION 'identity update interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_identity_update BEFORE UPDATE ON capacity_providers FOR EACH ROW EXECUTE FUNCTION interrupt_identity_update();`);
			expect((await f.rotate()).status).toBe(500); expect(await f.identityState()).toEqual(before); expect(f.body).toEqual(input);
			await f.db.exec('DROP TRIGGER interrupt_identity_update ON capacity_providers; DROP FUNCTION interrupt_identity_update();');
			expect(await identity(await f.rotate())).toMatchObject({ identityVersion: 2 }); const after = await f.identityState();
			expect(after.rotations).toHaveLength(1); expect(after.nonces.filter(row => row.jti === f.oldPayload.jti || row.jti === f.newPayload.jti)).toHaveLength(2);
			expect(after.audit.filter(row => row.action === 'provider-identity.rotated')).toHaveLength(1);
			for (const row of before.audit) expect(after.audit).toContainEqual(row); expect(f.body).toEqual(input);
			expect(await f.custody()).toEqual(custody);
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
});
