import { randomUUID } from 'node:crypto';
import type { MarketControlPlaneStore } from '../../../persistence/store.ts';
import { isoNow } from '../../support/index.ts';

export async function transferTeamOwnershipMethod(
	this: MarketControlPlaneStore,
	teamId: string,
	input: { fromMembershipId: string; toMembershipId: string; expectedVersion?: string },
) {
	await this.ensureInitialized();
	const [from, to] = await Promise.all([
		this.first(`SELECT * FROM team_memberships WHERE id = ? AND team_id = ? AND status = 'active'`, [input.fromMembershipId, teamId]),
		this.first(`SELECT * FROM team_memberships WHERE id = ? AND team_id = ? AND status = 'active'`, [input.toMembershipId, teamId]),
	]);
	if (!from?.id || !to?.id) return { ok: false, code: 'missing', message: 'Both ownership transfer members must be active.' };
	if (input.expectedVersion && String(to.updated_at) !== input.expectedVersion) {
		return { ok: false, code: 'stale', message: 'The selected member changed. Reload and try again.' };
	}
	const fromRoles = await this.listRoleKeysForMembership(input.fromMembershipId);
	if (!fromRoles.includes('team_owner')) return { ok: false, code: 'not_owner', message: 'Only an owner can transfer ownership.' };
	const ownerRoleId = await this.roleIdForKey('team_owner');
	const leadRoleId = await this.roleIdForKey('project_lead');
	const timestamp = isoNow();
	await this.batch([
		{ query: `UPDATE teams SET updated_at = updated_at WHERE id = ?`, params: [teamId] },
		{ query: `DELETE FROM team_role_bindings WHERE team_membership_id IN (?, ?)`, params: [input.fromMembershipId, input.toMembershipId] },
		{ query: `INSERT INTO team_role_bindings (id, team_membership_id, role_id, created_at) VALUES (?, ?, ?, ?)`, params: [randomUUID(), input.toMembershipId, ownerRoleId, timestamp] },
		{ query: `INSERT INTO team_role_bindings (id, team_membership_id, role_id, created_at) VALUES (?, ?, ?, ?)`, params: [randomUUID(), input.fromMembershipId, leadRoleId, timestamp] },
		{ query: `UPDATE team_memberships SET updated_at = ? WHERE id IN (?, ?)`, params: [timestamp, input.fromMembershipId, input.toMembershipId] },
	]);
	return {
		ok: true,
		members: await this.listTeamMembers(teamId),
	};
}

export async function leaveTeamMethod(this: MarketControlPlaneStore, teamId: string, userId: string) {
	await this.ensureInitialized();
	const membership = await this.first(`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1`, [teamId, userId]);
	if (!membership?.id) return { ok: false, code: 'missing', message: 'You are not an active member of this team.' };
	return this.removeTeamMember(teamId, String(membership.id), String(membership.updated_at));
}
