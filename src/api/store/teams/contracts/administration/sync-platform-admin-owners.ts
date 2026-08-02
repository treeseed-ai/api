import { randomUUID } from 'node:crypto';
import { isoNow, type MarketControlPlaneStore } from '../../../../persistence/store.ts';

const PLATFORM_LIBRARY_ID = 'treeseed-platform-library';
const PLATFORM_LIBRARY_BOOK_IDS = [
	'treeseed-accounts-and-identity', 'treeseed-team-administration', 'treeseed-services-and-providers',
	'treeseed-credential-security', 'treeseed-feedback-and-support', 'treeseed-platform-architecture-development',
];

async function syncPlatformLibrary(store: MarketControlPlaneStore, teamId: string, administratorIds: string[], timestamp: string) {
	const existing = await store.first(`SELECT id, book_ids_json FROM book_collections WHERE id = ? LIMIT 1`, [PLATFORM_LIBRARY_ID]);
	const bookIdsJson = JSON.stringify(PLATFORM_LIBRARY_BOOK_IDS);
	if (!existing) {
		await store.run(`INSERT INTO book_collections
			(id, team_id, name, summary, book_ids_json, created_by_user_id, version, created_at, updated_at)
			VALUES (?, ?, 'TreeSeed Platform Library', 'Canonical TreeSeed product, administration, security, support, and development knowledge.', ?, ?, 1, ?, ?)`,
			[PLATFORM_LIBRARY_ID, teamId, bookIdsJson, administratorIds[0] ?? 'system:seed', timestamp, timestamp]);
		return true;
	}
	if (existing.book_ids_json === bookIdsJson) return false;
	await store.run(`UPDATE book_collections SET team_id = ?, name = 'TreeSeed Platform Library',
		summary = 'Canonical TreeSeed product, administration, security, support, and development knowledge.',
		book_ids_json = ?, version = version + 1, updated_at = ? WHERE id = ?`, [teamId, bookIdsJson, timestamp, PLATFORM_LIBRARY_ID]);
	return true;
}

export async function syncPlatformAdminOwnersMethod(this: MarketControlPlaneStore) {
	const team = await this.first(`SELECT id FROM teams WHERE lower(slug) = 'treeseed' OR lower(name) = 'treeseed' LIMIT 1`);
	if (!team?.id) return { added: 0, removed: 0 };
	const ownerRole = await this.first(`SELECT id FROM roles WHERE key = 'team_owner' LIMIT 1`);
	if (!ownerRole?.id) return { added: 0, removed: 0 };
	const admins = await this.all(`SELECT DISTINCT bindings.user_id AS id
		FROM user_role_bindings bindings
		INNER JOIN roles ON roles.id = bindings.role_id
		WHERE roles.key = 'platform_admin'`);
	const adminIds = new Set(admins.map((admin) => String(admin.id)));
	const timestamp = isoNow();
	let added = 0;
	let removed = 0;
	for (const userId of adminIds) {
		let membership = await this.first(`SELECT id, status FROM team_memberships WHERE team_id = ? AND user_id = ? LIMIT 1`, [team.id, userId]);
		if (!membership?.id) {
			membership = { id: randomUUID(), status: 'active' };
			await this.run(`INSERT INTO team_memberships (id, team_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`, [membership.id, team.id, userId, timestamp, timestamp]);
		} else if (membership.status !== 'active') {
			await this.run(`UPDATE team_memberships SET status = 'active', updated_at = ? WHERE id = ?`, [timestamp, membership.id]);
		}
		const binding = await this.first(`SELECT id FROM team_role_bindings WHERE team_membership_id = ? AND role_id = ? LIMIT 1`, [membership.id, ownerRole.id]);
		if (!binding?.id) {
			await this.run(`INSERT INTO team_role_bindings (id, team_membership_id, role_id, created_at) VALUES (?, ?, ?, ?)`, [`platform-admin-owner:${team.id}:${userId}`, membership.id, ownerRole.id, timestamp]);
			added += 1;
		}
	}
	const stale = await this.all(`SELECT memberships.id, memberships.user_id, bindings.id AS binding_id
		FROM team_memberships memberships
		INNER JOIN team_role_bindings bindings ON bindings.team_membership_id = memberships.id
		WHERE memberships.team_id = ? AND bindings.role_id = ? AND bindings.id LIKE 'platform-admin-owner:%'`, [team.id, ownerRole.id]);
	for (const membership of stale) {
		if (adminIds.has(String(membership.user_id))) continue;
		await this.run(`DELETE FROM team_role_bindings WHERE id = ?`, [membership.binding_id]);
		const remaining = await this.first(`SELECT COUNT(*) AS count FROM team_role_bindings WHERE team_membership_id = ?`, [membership.id]);
		if (Number(remaining?.count ?? 0) === 0) await this.run(`UPDATE team_memberships SET status = 'inactive', updated_at = ? WHERE id = ?`, [timestamp, membership.id]);
		removed += 1;
	}
	const libraryChanged = await syncPlatformLibrary(this, String(team.id), [...adminIds].sort(), timestamp);
	const synchronizedOwners = await this.first(`SELECT COUNT(DISTINCT memberships.user_id) AS count
		FROM team_memberships memberships
		INNER JOIN team_role_bindings bindings ON bindings.team_membership_id = memberships.id
		WHERE memberships.team_id = ? AND memberships.status = 'active' AND bindings.role_id = ?
			AND memberships.user_id IN (SELECT role_bindings.user_id FROM user_role_bindings role_bindings
				INNER JOIN roles platform_roles ON platform_roles.id = role_bindings.role_id
				WHERE platform_roles.key = 'platform_admin')`, [team.id, ownerRole.id]);
	const ownerCount = Number(synchronizedOwners?.count ?? 0);
	if (ownerCount !== adminIds.size) {
		throw new Error(`Platform administrator ownership reconciliation failed: expected ${adminIds.size} owners and found ${ownerCount}.`);
	}
	if (added || removed) {
		await this.run(`INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at)
			VALUES (?, 'system', NULL, 'knowledge.platform_admin_ownership.synchronized', 'team', ?, ?, ?)`,
			[randomUUID(), team.id, JSON.stringify({ added, removed }), timestamp]);
	}
	if (libraryChanged) {
		await this.run(`INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at)
			VALUES (?, 'system', NULL, 'knowledge.collection.synchronized', 'book_collection', ?, ?, ?)`,
			[randomUUID(), PLATFORM_LIBRARY_ID, JSON.stringify({ teamId: team.id, bookIds: PLATFORM_LIBRARY_BOOK_IDS }), timestamp]);
	}
	return { added, removed, libraryChanged, administratorCount: adminIds.size, ownerCount };
}
