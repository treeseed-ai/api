import { PostgresAuthStore } from '../../postgres-store.ts';

type CountRow = { count: number | string };
type UserRow = { id: string };

export async function localFirstAdminCandidate(store: PostgresAuthStore) {
	if (!store.config.localFirstUserAdmin) return null;

	const administratorCount = await store.first<CountRow>(
		`SELECT COUNT(*) AS count
		 FROM user_role_bindings
		 INNER JOIN roles ON roles.id = user_role_bindings.role_id
		 WHERE roles.key = 'platform_admin'`,
	);
	if (Number(administratorCount?.count ?? 0) !== 0) return null;

	const activeUsers = await store.all<UserRow>(
		`SELECT id
		 FROM users
		 WHERE status = 'active'
		 ORDER BY created_at ASC, id ASC
		 LIMIT 2`,
	);
	return activeUsers.length === 1 ? activeUsers[0]?.id ?? null : null;
}

export async function assignLocalFirstAdmin(store: PostgresAuthStore, expectedUserId?: string) {
	const candidateUserId = await localFirstAdminCandidate(store);
	if (!candidateUserId || (expectedUserId && candidateUserId !== expectedUserId)) return false;

	await store.assignRole(candidateUserId, 'platform_admin');
	await store.writeAuditEvent({
		actorType: 'system',
		actorId: null,
		eventType: 'auth.bootstrap_admin',
		targetType: 'user',
		targetId: candidateUserId,
		data: { matched: 'local-first-user' },
	});
	return true;
}
