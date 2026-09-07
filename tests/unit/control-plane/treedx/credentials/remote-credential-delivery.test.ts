import { describe, expect, it } from 'vitest';
import { createRemoteGitCredentialDelivery as create } from '../../../../../src/security/remote-git-credential-delivery.ts';

function fixture() {
	const grants: any[] = [];
	const deliveries: any[] = [];
	const store = {
		async all(_sql: string, [operation, pattern]: string[]) {
			return grants.filter(g => g.operation_id === operation && g.idempotency_key.startsWith(pattern.slice(0, -1)))
				.map(g => { const d = deliveries.find(d => d.grant_id === g.id); return {
					id: g.id, idempotency_key: g.idempotency_key, grant_status: g.status,
					grant_expires_at: g.expires_at, delivery_id: d?.id, status: d?.status, expires_at: d?.expires_at,
				}; });
		},
		async run(sql: string, p: any[]) {
			if (sql.includes('INSERT INTO remote_git_operation_grants')) {
				grants.push({ id: p[0], operation_id: p[1], status: 'delivered', expires_at: p[12], idempotency_key: p[13] });
			} else {
				deliveries.push({ id: p[0], grant_id: p[1], status: 'ready', expires_at: p[6] });
			}
		},
		async first(sql: string, [key]: string[]) {
			return sql.includes('remote_git_operation_grants')
				? grants.find(g => g.idempotency_key === key) : deliveries.find(d => d.grant_id === key);
		},
	};
	const input = { store, operationId: 'operation', actorId: 'actor', teamId: 'team', projectId: 'project',
		repositoryBindingId: 'binding', credentialAuthorityId: 'authority', nodeId: 'node',
		sourceRef: 'refs/heads/review', destinationRef: 'refs/heads/main', reviewedCommit: 'a'.repeat(40),
		expectedRemoteHead: null, purpose: 'push' as const };
	return { input, grants, deliveries };
}

describe('remote Git credential delivery authorization context', () => {
	it('reuses exact-context active deliveries', async () => {
		const { input } = fixture();
		const first = await create(input);
		expect(await create(input)).toEqual({ ...first, reused: true });
	});

	it.each([
		['sourceRef', 'refs/treedx/commits/reviewed'], ['destinationRef', 'refs/heads/staging'],
		['refspec', '+refs/heads/review:refs/heads/main'], ['nodeId', 'other-node'],
		['credentialAuthorityId', 'other-authority'], ['repositoryBindingId', 'other-binding'],
		['actorId', 'other-actor'], ['teamId', 'other-team'], ['projectId', 'other-project'],
		['expectedRemoteHead', 'b'.repeat(40)], ['purpose', 'fetch'],
	])('does not reuse a delivery when %s changes', async (field, value) => {
		const { input } = fixture();
		const first = await create(input);
		const next = await create({ ...input, [field]: value });
		expect(next.deliveryId).not.toBe(first.deliveryId);
		expect(next.reused).toBe(false);
	});

	it.each(['revoked', 'expired'])('does not reuse a %s grant with a ready delivery', async (state) => {
		const { input, grants } = fixture();
		const first = await create(input);
		if (state === 'revoked') grants[0].status = state;
		else grants[0].expires_at = new Date(0).toISOString();
		expect((await create(input)).deliveryId).not.toBe(first.deliveryId);
	});

	it('recovers a partial grant using its recorded idempotency key', async () => {
		const { input, deliveries, grants } = fixture();
		await create(input);
		deliveries.length = 0;
		grants[0].idempotency_key = grants[0].idempotency_key.replace(/:1$/, ':7');
		await create(input);
		expect(grants).toHaveLength(1);
		expect(deliveries[0].grant_id).toBe(grants[0].id);
	});
});
