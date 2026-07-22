import type { CapacityGovernanceDatabase } from '../database.ts';

/**
 * Deletes a team and the capacity aggregate it owns in one database transaction.
 *
 * Team-scoped capacity history is append-only during the team's lifetime. Explicit
 * team deletion is the aggregate boundary: schema cascades remove team-owned
 * history, then provider identities with no remaining registration or membership
 * references are removed.
 */
export async function deleteTeamCapacityAggregate(
	database: CapacityGovernanceDatabase & {
		prepareTeamDeletion(teamId: string, confirmation: string): Promise<{
			ok: boolean;
			team?: unknown;
			[key: string]: unknown;
		}>;
	},
	teamId: string,
	confirmation: string,
) {
	const prepared = await database.prepareTeamDeletion(teamId, confirmation);
	if (!prepared.ok) return prepared;
	const providerRows = await database.all<{ capacity_provider_id: string }>(
		`SELECT DISTINCT capacity_provider_id
		 FROM (
			SELECT capacity_provider_id FROM capacity_provider_team_memberships WHERE team_id = ?
			UNION
			SELECT capacity_provider_id FROM capacity_provider_registration_requests WHERE team_id = ?
		 ) referenced_providers
		 ORDER BY capacity_provider_id`,
		[teamId, teamId],
	);
	const providerIds = providerRows
		.map((row) => row.capacity_provider_id)
		.filter((providerId): providerId is string => typeof providerId === 'string' && providerId.length > 0);
	const operations = [{ query: 'DELETE FROM teams WHERE id = ?', params: [teamId] }];
	if (providerIds.length > 0) {
		const placeholders = providerIds.map(() => '?').join(', ');
		operations.push({
			query: `DELETE FROM capacity_providers
			 WHERE id IN (${placeholders})
			   AND id NOT IN (
			   	SELECT capacity_provider_id FROM capacity_provider_team_memberships
			   )
			   AND id NOT IN (
			   	SELECT capacity_provider_id FROM capacity_provider_registration_requests
			   )`,
			params: providerIds,
		});
	}
	await database.batch(operations);
	return { ...prepared, providerIds };
}
