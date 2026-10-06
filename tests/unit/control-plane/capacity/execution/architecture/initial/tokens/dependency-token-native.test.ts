import { randomUUID } from 'node:crypto';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it } from 'vitest';
import { dependencyToken, tokenProofInputs } from './dependency-token-fixture.ts';

async function issuedToken(response: Response) {
	expect(response.status).toBe(200); const envelope: unknown = await response.json();
	if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Public token envelope missing');
	const data = CONTROL_PLANE_OPERATIONS.providers.issueAccessToken.schema.output.parse(envelope.data);
	if (typeof data.accessToken !== 'string' || !data.accessToken || typeof data.id !== 'string' || !data.id) throw new Error('Original token response authority missing');
	return { data, token: data.accessToken, id: data.id };
}

describe('real signed issuance HTTP and dependency poll custody', () => {
	it('actual signed public issuance persists one original nonce token audit and authenticates the unchanged dependency attempt through public polling', async () => {
		const f = await dependencyToken(); try {
			const before = await f.custody(), calledAt = Date.now(), issued = await issuedToken(await f.issue()), receivedAt = Date.now();
			if (typeof issued.data.issuedAt !== 'string' || typeof issued.data.expiresAt !== 'string') throw new Error('Original issuance clocks missing');
			expect(Date.parse(issued.data.issuedAt)).toBeGreaterThanOrEqual(calledAt); expect(Date.parse(issued.data.issuedAt)).toBeLessThanOrEqual(receivedAt);
			expect(Date.parse(issued.data.expiresAt) - Date.parse(issued.data.issuedAt)).toBe(60000);
			const publicIdentity = Object.fromEntries(['membershipId', 'providerId', 'teamId', 'credentialId', 'scopes', 'identityVersion'].map(key => [key, issued.data[key]]));
			expect(publicIdentity).toEqual({ membershipId: f.principal.membershipId, providerId: f.principal.capacityProviderId,
				teamId: f.principal.teamId, credentialId: f.body.credentialId, scopes: ['provider:assignments:read'], identityVersion: 1 });
			const rows = (await f.query('SELECT * FROM capacity_provider_access_tokens WHERE idempotency_key=?', [f.body.idempotencyKey])).rows;
			expect(rows).toHaveLength(1); expect(rows[0]?.id).toBe(issued.id);
			expect((await f.query('SELECT * FROM capacity_provider_proof_nonces WHERE jti=?', [f.payload.jti])).rows).toHaveLength(1);
			expect((await f.query("SELECT * FROM capacity_audit_events WHERE action='provider-access-token.issued' AND resource_id=?", [issued.id])).rows).toHaveLength(1);
			const response = await f.request(f.requestBody, { token: issued.token }); expect(response.status).toBe(200);
			const envelope: unknown = await response.json(); if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Public poll data missing');
			expect(CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(envelope.data)).toMatchObject({ assignment: {
				id: f.attempt.id, assignmentAttempt: f.attempt, workspaceContext: { predecessorResults: [f.actor, f.review] } } });
			const leased = await f.repository.get(f.principal.teamId, f.attempt.id); expect(leased?.status).toBe('leased');
			expect(Date.parse(leased?.leaseExpiresAt ?? '')).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline)); expect(await f.custody()).toEqual(before);
		} finally { await f.close(); }
	});
	it('invalid credentials signed request mutations moved identity and revoked membership deny issuance without nonce token audit or assignment changes', async () => {
		for (const mode of ['missing', 'wrong', 'foreign-id', 'body', 'path', 'audience', 'signature', 'key', 'identity-version', 'revoked', 'member'] as const) {
			const f = await dependencyToken(); try {
				expect((await f.evaluate()).eligible).toBe(true); expect(await f.authenticate()).toMatchObject({ principal: { teamId: f.principal.teamId } });
				let proof = f.proof(); const options: Parameters<typeof f.issue>[1] = {};
				if (mode === 'missing') options.credential = ''; if (mode === 'wrong') options.credential = 'tspc_unknown_invalid';
				if (mode === 'foreign-id') options.body = { credentialId: 'foreign-credential' };
				if (mode === 'body') options.body = { requestedValiditySeconds: 61 };
				if (mode === 'path') proof = f.proof({ ...f.payload, path: '/foreign' });
				if (mode === 'audience') proof = f.proof({ ...f.payload, audience: 'http://foreign' });
				if (mode === 'signature') proof = { ...proof, signature: Buffer.alloc(64).toString('base64url') };
				if (mode === 'key') { const other = tokenProofInputs(new Date(), f.attempt.deadline);
					await f.query("UPDATE capacity_providers SET public_jwk_json=? WHERE id='provider'", [JSON.stringify(other.publicJwk)]); }
				if (mode === 'identity-version') await f.query("UPDATE capacity_providers SET identity_version=2 WHERE id='provider'");
				if (mode === 'revoked') await f.query("UPDATE capacity_provider_team_credentials SET status='revoked' WHERE id='token-credential'");
				if (mode === 'member') await f.query("UPDATE capacity_provider_team_memberships SET status='suspended' WHERE id='membership'");
				const before = await f.tokenState(); expect((await f.issue(proof, options)).status).toBe(mode === 'revoked' || mode === 'member' ? 403 : 401);
				expect(await f.tokenState()).toEqual(before);
			} finally { await f.close(); }
		}
	});
	it('original nonce replay denies while concurrent fresh signed retries of one issuance key return one immutable token and audit', async () => {
		const f = await dependencyToken(); try {
			const custody = await f.custody(), original = f.proof();
			const first = await Promise.all([f.issue(original), f.issue(f.proof({ ...f.payload, jti: randomUUID() }))]);
			const issued = await issuedToken(first[0]!), competing = await issuedToken(first[1]!);
			expect(competing.id).toBe(issued.id); expect(competing.token === issued.token).toBe(true);
			const before = await f.tokenState();
			expect(before.tokens.filter(row => row.idempotency_key === f.body.idempotencyKey)).toHaveLength(1);
			expect((await f.query("SELECT * FROM capacity_audit_events WHERE action='provider-access-token.issued' AND resource_id=?", [issued.id])).rows).toHaveLength(1);
			expect((await f.issue(original)).status).toBe(409); expect(await f.tokenState()).toEqual(before);
			const replies = await Promise.all([f.issue(f.proof({ ...f.payload, jti: randomUUID() })), f.issue(f.proof({ ...f.payload, jti: randomUUID() }))]);
			for (const response of replies) { const retry = await issuedToken(response); expect(retry.id).toBe(issued.id); expect(retry.token === issued.token).toBe(true); }
			const after = await f.tokenState(); expect(after.tokens).toEqual(before.tokens); expect(after.audit).toEqual(before.audit);
			expect(after.nonces).toHaveLength(before.nonces.length + 2); expect(await f.custody()).toEqual(custody);
		} finally { await f.close(); }
	});
	it('late issuance audit interruption retains original token nonce and pending assignment before same key fresh proof recovers exactly one missing audit', async () => {
		const f = await dependencyToken(); try {
			const custody = await f.custody();
			await f.db.exec(`CREATE FUNCTION interrupt_token_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.action='provider-access-token.issued' THEN RAISE EXCEPTION 'token audit interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_token_audit BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_token_audit();`);
			expect((await f.issue()).status).toBe(500); const failed = await f.tokenState();
			const tokens = failed.tokens.filter(row => row.idempotency_key === f.body.idempotencyKey); expect(tokens).toHaveLength(1);
			expect(failed.nonces.some(row => row.jti === f.payload.jti)).toBe(true); expect(await f.custody()).toEqual(custody);
			expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
			await f.db.exec('DROP TRIGGER interrupt_token_audit ON capacity_audit_events; DROP FUNCTION interrupt_token_audit();');
			expect(Date.now()).toBeLessThan(Date.parse(f.attempt.deadline)); const recovered = await issuedToken(await f.issue(f.proof({ ...f.payload, jti: randomUUID() })));
			expect(recovered.id).toBe(tokens[0]?.id); const after = await f.tokenState(); expect(after.tokens).toEqual(failed.tokens);
			for (const row of failed.nonces) expect(after.nonces).toContainEqual(row);
			for (const row of failed.audit) expect(after.audit).toContainEqual(row);
			expect((await f.query("SELECT * FROM capacity_audit_events WHERE action='provider-access-token.issued' AND resource_id=?", [recovered.id])).rows).toHaveLength(1);
			expect(await f.custody()).toEqual(custody);
		} finally { await f.close(); }
	});
});
