import { PostgresAuthStore } from '../../postgres-store.ts';
import { assignLocalFirstAdmin } from './local-first-admin.ts';

type BootstrapAdminCandidate = {
	user_id: string;
	email: string | null;
	provider: string | null;
	provider_subject: string | null;
};

export async function reconcileBootstrapAdminsMethod(this: PostgresAuthStore) {
	const allowlist = this.config.bootstrapAdminAllowlist;
	const candidates = allowlist.length > 0 ? await this.all<BootstrapAdminCandidate>(
		`SELECT users.id AS user_id,
			users.email,
			user_identities.provider,
			user_identities.provider_subject
		 FROM users
		 LEFT JOIN user_identities ON user_identities.user_id = users.id`,
	) : [];
	const matches = new Map<string, string>();
	for (const candidate of candidates) {
		const email = candidate.email?.trim().toLowerCase() ?? '';
		const providerSubject = candidate.provider && candidate.provider_subject
			? `${candidate.provider}:${candidate.provider_subject}`
			: '';
		const matched = allowlist.includes(providerSubject) ? providerSubject : email;
		if (matched && allowlist.includes(matched)) matches.set(candidate.user_id, matched);
	}

	for (const [userId, matched] of matches) {
		if ((await this.rolesForUser(userId)).includes('platform_admin')) continue;
		await this.assignRole(userId, 'platform_admin');
		await this.writeAuditEvent({
			actorType: 'system',
			actorId: null,
			eventType: 'auth.bootstrap_admin',
			targetType: 'user',
			targetId: userId,
			data: { matched },
		});
	}

	await assignLocalFirstAdmin(this);
}
