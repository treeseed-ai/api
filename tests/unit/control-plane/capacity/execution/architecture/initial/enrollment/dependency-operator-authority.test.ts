import { generateKeyPair, SignJWT } from 'jose';
import { IdentityAuthenticationError } from '@treeseed/identity';
import { expect, it, vi } from 'vitest';
import { createIdentityAuthenticator } from '../../../../../../../../src/api/auth/identity-authenticator.ts';
import type { IdentityPrincipalStore } from '../../../../../../../../src/api/auth/identity/principal-store.ts';
import { ControlPlaneStore } from '../../../../../../../../src/api/persistence/store.ts';

// Test-signed credentials and controlled local rows are INPUTS. This unit
// boundary does not issue a credential through Identity or authenticate HTTP.
it('original team management policy waits for the current membership read and cannot reuse earlier owner authority after revocation', async () => {
	const principal = { id: 'mapped-user', roles: ['platform_admin', 'team_owner'], permissions: ['*:*:*'] }, before = structuredClone(principal);
	const store = new ControlPlaneStore({}, { prepare: () => { throw new Error('Unexpected unit policy SQL'); } }); store.initializationPromise = Promise.resolve();
	const first = vi.spyOn(store, 'first'), all = vi.spyOn(store, 'all'), run = vi.spyOn(store, 'run'), batch = vi.spyOn(store, 'batch');
	let release: ((value: null) => void) | undefined;
	let authority: Promise<boolean> | undefined;
	const pendingRead = new Promise<null>(resolve => { release = resolve; });
	try {
		first.mockResolvedValueOnce({ id: 'original-membership' }); all.mockResolvedValueOnce([{ key: 'team_owner' }]);
		expect(await store.principalCanManageTeam(principal, 'team')).toBe(true);
		expect(first).toHaveBeenCalledExactlyOnceWith("SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1", ['team', 'mapped-user']);
		expect(all.mock.calls[0]?.[1]).toEqual(['original-membership']); expect(all).toHaveBeenCalledTimes(1);
		first.mockClear(); all.mockClear(); first.mockImplementationOnce(() => pendingRead);
		let settled = false; const reviewAuthority = store.principalCanManageTeam(principal, 'team'); authority = reviewAuthority; void reviewAuthority.then(() => { settled = true; }, () => { settled = true; });
		await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1)); expect(settled).toBe(false); expect(all).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
		// A revoked/missing active row is a controlled unit INPUT, not a native
		// administrative transition or authenticated winner history.
		release!(null); expect(await reviewAuthority).toBe(false);
		first.mockResolvedValueOnce(null); expect(await store.principalCanManageTeam(principal, 'team')).toBe(false);
		expect(first.mock.calls).toEqual(Array.from({ length: 2 }, () => ["SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1", ['team', 'mapped-user']]));
		expect(all).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled(); expect(principal).toEqual(before);
	} finally { release?.(null); try { if (authority) await authority; } finally { first.mockRestore(); all.mockRestore(); run.mockRestore(); batch.mockRestore(); } }
});

async function operatorInputs() {
	const keys = await generateKeyPair('RS256'), issuer = 'https://identity.example/realms/treeseed', audience = 'http://localhost';
	const local = { userId: 'mapped-user', principal: { id: 'mapped-user', roles: ['renamed-local-role'], permissions: ['*:*:*'], scopes: ['treeseed:read', 'treeseed:admin'], metadata: {} } };
	const store: IdentityPrincipalStore = { first: async () => null, principalForUser: async () => structuredClone(local) };
	const first = vi.spyOn(store, 'first'), principal = vi.spyOn(store, 'principalForUser');
	const authenticate = createIdentityAuthenticator({ issuer, audience, verificationKey: keys.publicKey, store });
	const sign = (options: { issuer?: string; audience?: string; scope?: string; client?: unknown; expiry?: number; key?: Parameters<SignJWT['sign']>[0] } = {}) =>
		new SignJWT({ typ: 'Bearer', azp: options.client === undefined ? 'renamed-client' : options.client, scope: options.scope ?? 'treeseed:read treeseed:admin', roles: ['platform_admin', 'team_owner'], permissions: ['*:*:*'] })
			.setProtectedHeader({ alg: 'RS256' }).setIssuer(options.issuer ?? issuer).setAudience(options.audience ?? audience).setSubject('signed-subject').setIssuedAt()
			.setExpirationTime(options.expiry ?? Math.floor(Date.now() / 1000) + 47).sign(options.key ?? keys.privateKey);
	const mapped = () => first.mockResolvedValueOnce({ user_id: local.userId, status: 'active' }).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: local.userId });
	return { local, first, principal, authenticate, sign, mapped };
}

it('original operator authentication intersects local authority with signed scopes and preserves the exact client and expiry without trusting issuer roles', async () => {
	const f = await operatorInputs(), before = structuredClone(f.local), expiry = Math.floor(Date.now() / 1000) + 47;
	try {
		for (const scope of ['treeseed:read treeseed:admin', 'treeseed:read', '']) {
			f.first.mockClear(); f.principal.mockClear(); f.mapped(); const credential = await f.sign({ scope, expiry });
			const result = await f.authenticate(credential);
			expect(result.principal).toEqual({ ...before.principal, scopes: before.principal.scopes.filter(value => scope.split(' ').includes(value)) });
			expect(result.credential).toEqual({ type: 'access_token', id: before.userId, oauthClientId: 'renamed-client', expiresAt: expiry });
			expect(result.userId).toBe(before.userId); expect(f.first).toHaveBeenCalledTimes(3); expect(f.principal).toHaveBeenCalledExactlyOnceWith(before.userId);
			expect(f.first.mock.calls[0]?.[1]).toEqual(['https://identity.example/realms/treeseed', 'signed-subject']); expect(f.local).toEqual(before);
		}
	} finally { f.first.mockRestore(); f.principal.mockRestore(); }
});

it('original operator authentication rejects wrong issuer audience signature expiry unmapped and ambiguous identities without manufacturing local authority', async () => {
	const f = await operatorInputs(), foreign = await generateKeyPair('RS256'), before = structuredClone(f.local);
	try {
		for (const options of [{ issuer: 'https://foreign.example' }, { audience: 'https://foreign-api.example' }, { key: foreign.privateKey }, { expiry: Math.floor(Date.now() / 1000) - 1 }]) {
			f.first.mockClear(); f.principal.mockClear(); const credential = await f.sign(options);
			await expect(f.authenticate(credential)).rejects.toBeInstanceOf(IdentityAuthenticationError); expect(f.first).not.toHaveBeenCalled(); expect(f.principal).not.toHaveBeenCalled();
		}
		for (const identity of ['unmapped', 'ambiguous', 'disabled'] as const) {
			f.first.mockClear(); f.principal.mockClear();
			f.first.mockResolvedValueOnce(identity === 'unmapped' ? null : { user_id: before.userId, status: identity === 'disabled' ? 'disabled' : 'active' })
				.mockResolvedValueOnce(identity === 'ambiguous' ? { id: 'competing-workload', client_id: 'renamed-client', display_name: 'Competing', status: 'active', permissions: [], scopes: ['treeseed:admin'] } : null);
			await expect(f.authenticate(await f.sign())).rejects.toBeInstanceOf(IdentityAuthenticationError); expect(f.first).toHaveBeenCalledTimes(2); expect(f.principal).not.toHaveBeenCalled(); expect(f.local).toEqual(before);
		}
	} finally { f.first.mockRestore(); f.principal.mockRestore(); }
});
