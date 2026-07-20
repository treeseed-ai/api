import type { ProviderCredentialIssuanceAuthorization, ProviderTeamMembership } from '@treeseed/sdk/capacity-provider/contracts';
import type { CapacityGovernanceDatabase } from '../database.ts';

function authorization(row: Record<string, unknown>): ProviderCredentialIssuanceAuthorization {
	return {
		id: String(row.id),
		membershipId: String(row.membership_id),
		teamId: String(row.team_id),
		providerId: String(row.capacity_provider_id),
		generation: Number(row.generation),
		status: row.status as ProviderCredentialIssuanceAuthorization['status'],
		issuedCredentialId: row.issued_credential_id ? String(row.issued_credential_id) : null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export class CapacityCredentialAuthorizationRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async byIssueKey(membershipId: string, idempotencyKey: string) {
		await this.database.ensureInitialized();
		const row = await this.database.first(`SELECT * FROM capacity_provider_credential_issuance_authorizations WHERE membership_id = ? AND idempotency_key = ? LIMIT 1`, [membershipId, idempotencyKey]);
		return row ? authorization(row) : null;
	}

	async pending(membershipId: string) {
		await this.database.ensureInitialized();
		const row = await this.database.first(`SELECT * FROM capacity_provider_credential_issuance_authorizations WHERE membership_id = ? AND status = 'pending' ORDER BY generation DESC LIMIT 1`, [membershipId]);
		return row ? authorization(row) : null;
	}

	async authorizeRotation(input: { id: string; membership: ProviderTeamMembership; idempotencyKey: string; actorId: string; actorType: 'team-principal' | 'provider-identity'; now: string }) {
		const latest = await this.database.first(`SELECT COALESCE(MAX(generation), 0) AS generation FROM capacity_provider_credential_issuance_authorizations WHERE membership_id = ?`, [input.membership.id]);
		const generation = Number(latest?.generation ?? 0) + 1;
		await this.database.batch([
			{ query: `INSERT INTO capacity_provider_credential_issuance_authorizations (id, membership_id, team_id, capacity_provider_id, generation, idempotency_key, status, created_by_type, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`, params: [input.id, input.membership.id, input.membership.teamId, input.membership.providerId, generation, input.idempotencyKey, input.actorType, input.actorId, input.now, input.now] },
			{ query: `UPDATE capacity_provider_team_credentials SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE membership_id = ? AND status <> 'revoked'`, params: [input.now, input.now, input.membership.id] },
			{ query: `UPDATE capacity_provider_access_tokens SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE membership_id = ? AND status = 'active'`, params: [input.now, input.now, input.membership.id] },
		]);
		return this.byIssueKey(input.membership.id, input.idempotencyKey);
	}
}
