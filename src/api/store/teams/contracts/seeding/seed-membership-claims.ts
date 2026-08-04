import { createHash,randomUUID } from 'node:crypto';
import { isoNow,type MarketControlPlaneStore } from '../../../../persistence/store.ts';

type ClaimInput = { seedName: string; resourceKey: string; teamId: string; email: string; roles: string[] };

function strings(value: unknown) {
	if (Array.isArray(value)) return value.map(String);
	try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

function bindingId(input: ClaimInput, role: string) {
	return `seed-member:${createHash('sha256').update(`${input.seedName}\0${input.resourceKey}\0${role}`).digest('hex').slice(0, 32)}`;
}

async function removeOwnedBindings(store: MarketControlPlaneStore, claim: Record<string, unknown> | null, retain: Set<string>) {
	for (const id of strings(claim?.binding_ids_json)) {
		if (retain.has(id)) continue;
		const binding = await store.first(`SELECT roles.key, team_role_bindings.team_membership_id FROM team_role_bindings INNER JOIN roles ON roles.id = team_role_bindings.role_id WHERE team_role_bindings.id = ? LIMIT 1`, [id]);
		if (binding?.key === 'team_owner') {
			const owners = await store.first(`SELECT COUNT(*) AS count FROM team_memberships INNER JOIN team_role_bindings ON team_role_bindings.team_membership_id = team_memberships.id INNER JOIN roles ON roles.id = team_role_bindings.role_id WHERE team_memberships.team_id = (SELECT team_id FROM team_memberships WHERE id = ?) AND team_memberships.status = 'active' AND roles.key = 'team_owner' AND team_role_bindings.id <> ?`, [binding.team_membership_id, id]);
			if (Number(owners?.count ?? 0) < 1) throw new Error('Seed membership reconciliation cannot remove the last team owner.');
		}
		await store.run(`DELETE FROM team_role_bindings WHERE id = ?`, [id]);
	}
}

export async function getSeedTeamMembershipClaimMethod(this: MarketControlPlaneStore, seedName: string, resourceKey: string) {
	await this.ensureInitialized();
	return this.first(`SELECT * FROM seed_team_membership_claims WHERE seed_name = ? AND resource_key = ? LIMIT 1`, [seedName, resourceKey]);
}

export async function reconcileSeedTeamMembershipClaimMethod(this: MarketControlPlaneStore, input: ClaimInput) {
	await this.ensureInitialized();
	const email = input.email.trim().toLowerCase();
	const roles = [...new Set(input.roles)].sort();
	const roleRows = await Promise.all(roles.map(async (role) => ({ role, id: await this.roleIdForKey(role) })));
	const invalid = roleRows.find((entry) => !entry.id);
	if (invalid) throw new Error(`Unknown team role ${invalid.role}.`);
	const existing = await this.getSeedTeamMembershipClaim(input.seedName, input.resourceKey);
	const user = await this.findUserByEmail(email);
	const now = isoNow();
	let membership: Record<string, unknown> | null = null;
	const desiredIds = new Set<string>();
	if (user?.id) {
		membership = await this.first(`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? LIMIT 1`, [input.teamId, user.id]);
		if (!membership?.id) {
			membership = { id: randomUUID() };
			await this.run(`INSERT INTO team_memberships (id, team_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`, [membership.id, input.teamId, user.id, now, now]);
		} else if (membership.status !== 'active') {
			await this.run(`UPDATE team_memberships SET status = 'active', updated_at = ? WHERE id = ?`, [now, membership.id]);
		}
		for (const entry of roleRows) {
			const id = bindingId(input, entry.role); desiredIds.add(id);
			if (!await this.first(`SELECT id FROM team_role_bindings WHERE id = ? LIMIT 1`, [id])) await this.run(`INSERT INTO team_role_bindings (id, team_membership_id, role_id, created_at) VALUES (?, ?, ?, ?)`, [id, membership.id, entry.id, now]);
		}
	}
	await removeOwnedBindings(this, existing, desiredIds);
	const id = String(existing?.id ?? `seed-claim:${createHash('sha256').update(`${input.seedName}\0${input.resourceKey}`).digest('hex').slice(0, 32)}`);
	const values = [input.seedName, input.resourceKey, input.teamId, email, JSON.stringify(roles), user?.id ? 'bound' : 'pending', user?.id ?? null, membership?.id ?? null, JSON.stringify([...desiredIds]), user?.id ? now : null, now, id];
	if (existing) await this.run(`UPDATE seed_team_membership_claims SET seed_name = ?, resource_key = ?, team_id = ?, normalized_email = ?, roles_json = ?, status = ?, user_id = ?, membership_id = ?, binding_ids_json = ?, bound_at = ?, updated_at = ? WHERE id = ?`, values);
	else await this.run(`INSERT INTO seed_team_membership_claims (seed_name, resource_key, team_id, normalized_email, roles_json, status, user_id, membership_id, binding_ids_json, bound_at, updated_at, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...values, now]);
	await this.recordAuditEvent({ actorType: 'system', actorId: null, eventType: user?.id ? 'seed.team_membership.bound' : 'seed.team_membership.deferred', targetType: 'team', targetId: input.teamId, data: { seedName: input.seedName, resourceKey: input.resourceKey, email, roles, userId: user?.id ?? null } });
	return { id, seedName: input.seedName, resourceKey: input.resourceKey, teamId: input.teamId, email, roles, status: user?.id ? 'bound' : 'pending', userId: user?.id ?? null, membershipId: membership?.id ?? null, bindingIds: [...desiredIds] };
}

export async function claimSeedTeamMembershipsForVerifiedEmailMethod(this: MarketControlPlaneStore, userId: string, email: string) {
	await this.ensureInitialized();
	const normalized = email.trim().toLowerCase();
	const verified = await this.first(`SELECT id FROM user_email_addresses WHERE user_id = ? AND normalized_email = ? AND status = 'verified' LIMIT 1`, [userId, normalized]);
	if (!verified) return [];
	const claims = await this.all(`SELECT * FROM seed_team_membership_claims WHERE normalized_email = ? ORDER BY seed_name, resource_key`, [normalized]);
	return Promise.all(claims.map((claim) => this.reconcileSeedTeamMembershipClaim({ seedName: String(claim.seed_name), resourceKey: String(claim.resource_key), teamId: String(claim.team_id), email: normalized, roles: strings(claim.roles_json) })));
}

export async function retireUndeclaredSeedTeamMembershipClaimsMethod(this: MarketControlPlaneStore, seedName: string, declaredKeys: string[]) {
	await this.ensureInitialized();
	const retained = new Set(declaredKeys);
	const claims = await this.all(`SELECT * FROM seed_team_membership_claims WHERE seed_name = ? AND status <> 'removed' ORDER BY resource_key`, [seedName]);
	const retired = [];
	for (const claim of claims) {
		const resourceKey = String(claim.resource_key);
		if (retained.has(resourceKey)) continue;
		await removeOwnedBindings(this, claim, new Set());
		const now = isoNow();
		await this.run(`UPDATE seed_team_membership_claims SET status = 'removed', binding_ids_json = '[]', updated_at = ? WHERE id = ?`, [now, claim.id]);
		await this.recordAuditEvent({ actorType: 'system', actorId: null, eventType: 'seed.team_membership.removed', targetType: 'team', targetId: String(claim.team_id), data: { seedName, resourceKey, email: claim.normalized_email } });
		retired.push({ seedName, resourceKey, teamId: String(claim.team_id), email: String(claim.normalized_email), status: 'removed' });
	}
	return retired;
}
