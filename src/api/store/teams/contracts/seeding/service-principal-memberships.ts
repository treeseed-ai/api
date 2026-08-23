import { createHash } from 'node:crypto';
import { isoNow, type ControlPlaneStore } from '../../../../persistence/store.ts';

type Input = {
	seedName: string;
	resourceKey: string;
	teamId: string;
	principalKey: string;
	displayName: string;
	roles: string[];
};

const stableId = (prefix: string, value: string) => `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
const parseRoles = (value: unknown) => {
	try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed.map(String).sort() : []; }
	catch { return []; }
};

export async function getSeedServicePrincipalMembershipMethod(this: ControlPlaneStore, seedName: string, resourceKey: string) {
	await this.ensureInitialized();
	return this.first(`SELECT memberships.*, principals.principal_key, principals.display_name, principals.interactive_login
		FROM team_service_principal_memberships memberships
		INNER JOIN service_principals principals ON principals.id = memberships.service_principal_id
		WHERE memberships.seed_name = ? AND memberships.resource_key = ? LIMIT 1`, [seedName, resourceKey]);
}

export async function reconcileSeedServicePrincipalMembershipMethod(this: ControlPlaneStore, input: Input) {
	await this.ensureInitialized();
	const now = isoNow();
	const roles = [...new Set(input.roles)].sort();
	for (const role of roles) if (!await this.roleIdForKey(role)) throw new Error(`Unknown team role ${role}.`);
	let principal = await this.first(`SELECT * FROM service_principals WHERE principal_key = ? LIMIT 1`, [input.principalKey]);
	if (!principal) {
		principal = { id: stableId('service-principal', input.principalKey) };
		await this.run(`INSERT INTO service_principals (id, principal_key, display_name, interactive_login, status, created_at, updated_at)
			VALUES (?, ?, ?, false, 'active', ?, ?)`, [principal.id, input.principalKey, input.displayName, now, now]);
	} else {
		await this.run(`UPDATE service_principals SET display_name = ?, interactive_login = false, status = 'active', updated_at = ? WHERE id = ?`,
			[input.displayName, now, principal.id]);
	}
	let membership = await this.first(`SELECT * FROM team_service_principal_memberships WHERE team_id = ? AND service_principal_id = ? LIMIT 1`, [input.teamId, principal.id]);
	if (!membership) {
		membership = { id: stableId('service-principal-membership', `${input.teamId}\0${input.principalKey}`) };
		await this.run(`INSERT INTO team_service_principal_memberships
			(id, team_id, service_principal_id, roles_json, status, seed_name, resource_key, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
			[membership.id, input.teamId, principal.id, JSON.stringify(roles), input.seedName, input.resourceKey, now, now]);
	} else {
		await this.run(`UPDATE team_service_principal_memberships SET roles_json = ?, status = 'active', seed_name = ?, resource_key = ?, updated_at = ? WHERE id = ?`,
			[JSON.stringify(roles), input.seedName, input.resourceKey, now, membership.id]);
	}
	await this.recordAuditEvent({ actorType: 'system', actorId: null, eventType: 'seed.service_principal.bound',
		targetType: 'team', targetId: input.teamId,
		data: { seedName: input.seedName, resourceKey: input.resourceKey, principalKey: input.principalKey, roles } });
	return { id: membership.id, principalId: principal.id, teamId: input.teamId, principalKey: input.principalKey,
		displayName: input.displayName, interactiveLogin: false, roles, status: 'active' };
}

export async function retireUndeclaredSeedServicePrincipalMembershipsMethod(this: ControlPlaneStore, seedName: string, declaredKeys: string[]) {
	await this.ensureInitialized();
	const retained = new Set(declaredKeys);
	const memberships = await this.all(`SELECT memberships.*, principals.principal_key FROM team_service_principal_memberships memberships
		INNER JOIN service_principals principals ON principals.id = memberships.service_principal_id
		WHERE memberships.seed_name = ? AND memberships.status <> 'removed' ORDER BY memberships.resource_key`, [seedName]);
	const retired = [];
	for (const membership of memberships) {
		if (retained.has(String(membership.resource_key))) continue;
		const now = isoNow();
		await this.run(`UPDATE team_service_principal_memberships SET status = 'removed', roles_json = '[]', updated_at = ? WHERE id = ?`, [now, membership.id]);
		retired.push({ resourceKey: membership.resource_key, principalKey: membership.principal_key, status: 'removed' });
	}
	return retired;
}

export { parseRoles as parseSeedServicePrincipalRoles };
