import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createTeamInviteOperation } from '../../../src/api/control-plane/catalog/team-operations.ts';

function dependencies(deliverTeamInvite = vi.fn(async () => undefined)) {
	const revokeTeamInvite = vi.fn(async () => ({ ok: true }));
	return {
		deliverTeamInvite,
		revokeTeamInvite,
		value: {
			deliverTeamInvite,
			store: {
				async getTeam() { return { id: 'team-a', status: 'active' }; },
				async principalCanAccessTeam() { return true; },
				async resolvePrincipalTeamContext() { return { roles: ['team_owner'] }; },
				async createTeamInvite() { return { ok: true, invite: { id: 'invite-1', email: 'member@example.test', roleKey: 'contributor' }, token: 'secret-token' }; },
				revokeTeamInvite,
				async recordAuditEvent() {},
			},
		} as any,
	};
}

describe('team invitation operation', () => {
	it('delivers through API custody without returning the invitation token', async () => {
		const fixture = dependencies();
		const operation = createTeamInviteOperation(fixture.value);
		const output = await operation.handler({ path: { teamId: 'team-a' }, query: {}, body: {
			email: 'member@example.test', roleKey: 'contributor',
		} }, { principal: { id: 'user-1' }, interface: 'rest', requestId: 'request-1' });
		expect(operation.binding).toBe(CONTROL_PLANE_OPERATIONS.teams.invite);
		expect(output).toEqual({ ok: true, invite: expect.objectContaining({ id: 'invite-1' }) });
		expect(output).not.toHaveProperty('token');
		expect(fixture.deliverTeamInvite).toHaveBeenCalledWith(expect.objectContaining({ token: 'secret-token' }));
	});

	it('revokes the pending invitation when delivery fails', async () => {
		const fixture = dependencies(vi.fn(async () => { throw new Error('smtp unavailable'); }));
		const operation = createTeamInviteOperation(fixture.value);
		await expect(operation.handler({ path: { teamId: 'team-a' }, query: {}, body: {
			email: 'member@example.test', roleKey: 'contributor',
		} }, { principal: { id: 'user-1' }, interface: 'rest', requestId: 'request-1' })).rejects.toMatchObject({
			status: 503, code: 'team_invite_delivery_failed',
		});
		expect(fixture.revokeTeamInvite).toHaveBeenCalledWith('team-a', 'invite-1');
	});
});
