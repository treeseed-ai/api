import { afterEach, describe, expect, it } from 'vitest';
import {
	createCapacityRegistrationTestHarness,
	ensureCapacityTestTeam,
} from './capacity-registration-test-fixture.ts';
import { deleteTeamCapacityAggregate } from '../../src/api/capacity/services/team-deletion-service.ts';

const databases: Array<ReturnType<typeof createCapacityRegistrationTestHarness>['database']> = [];

describe('capacity team aggregate deletion', () => {
	afterEach(async () => {
		await Promise.all(databases.splice(0).map((database) => database.close()));
	});

	it('cascades team-owned history and collects only unreferenced provider identities', async () => {
		const { database, store } = createCapacityRegistrationTestHarness();
		databases.push(database);
		await ensureCapacityTestTeam(store, 'deletion-team');
		await ensureCapacityTestTeam(store, 'remaining-team');
		const now = new Date().toISOString();
		for (const providerId of ['isolated-provider', 'shared-provider']) {
			await store.run(
				`INSERT INTO capacity_providers
				 (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at)
				 VALUES (?, ?, '{}', ?, 1, 'active', '{}', ?, ?)`,
				[providerId, `${providerId}-fingerprint`, providerId, now, now],
			);
		}
		for (const [membershipId, teamId, providerId] of [
			['isolated-membership', 'deletion-team', 'isolated-provider'],
			['shared-deleted-membership', 'deletion-team', 'shared-provider'],
			['shared-remaining-membership', 'remaining-team', 'shared-provider'],
		]) {
			await store.run(
				`INSERT INTO capacity_provider_team_memberships
				 (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at)
				 VALUES (?, ?, ?, 'approved', ?, 'owner', '{}', ?, ?)`,
				[membershipId, teamId, providerId, now, now, now],
			);
		}
		await store.run(
			`INSERT INTO capacity_workday_runs
			 (id, team_id, scenario_id, status, environment, parameters_json, summary_json, metrics_json, expected_json, actual_json, report_refs_json, error_json, next_event_index, created_at, updated_at)
			 VALUES ('deletion-run', 'deletion-team', 'acceptance', 'completed', 'local', '{}', '{}', '{}', '{}', '{}', '{}', '{}', 0, ?, ?)`,
			[now, now],
		);

		const deleted = await deleteTeamCapacityAggregate(store, 'deletion-team', 'DELETE deletion-team');

		expect(deleted.ok).toBe(true);
		expect(await store.first(`SELECT id FROM teams WHERE id = 'deletion-team'`)).toBeNull();
		expect(await store.first(`SELECT id FROM capacity_workday_runs WHERE id = 'deletion-run'`)).toBeNull();
		expect(await store.first(`SELECT id FROM capacity_providers WHERE id = 'isolated-provider'`)).toBeNull();
		expect(await store.first(`SELECT id FROM capacity_providers WHERE id = 'shared-provider'`)).toMatchObject({
			id: 'shared-provider',
		});
		expect(await store.first(
			`SELECT id FROM capacity_provider_team_memberships WHERE id = 'shared-remaining-membership'`,
		)).toMatchObject({ id: 'shared-remaining-membership' });
	});
});
