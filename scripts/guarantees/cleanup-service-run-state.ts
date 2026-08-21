import assert from 'node:assert/strict';
import { createControlPlanePostgresDatabase } from '../../src/api/support/control-plane-postgres.ts';

type RunValue = {
	value?: Record<string, unknown>;
};

const environment = process.env.TREESEED_ACCEPTANCE_ENVIRONMENT ?? '';
assert.equal(environment, 'local', 'Service guarantee fixture cleanup is restricted to the local acceptance environment.');

const databaseUrl = process.env.TREESEED_DATABASE_URL
	?? 'postgresql://treeseed:treeseed-local-dev@127.0.0.1:54329/treeseed_api';
const runState = JSON.parse(process.env.TREESEED_GUARANTEE_RUN_STATE ?? '{}') as Record<string, RunValue>;
const teamNames = [...new Set(Object.entries(runState)
	.filter(([key, entry]) => key.startsWith('team.primary@') && entry.value?.name)
	.map(([, entry]) => String(entry.value!.name)))];
assert.ok(teamNames.length > 0, 'Run state contains no UI-created team identifiers.');

const database = createControlPlanePostgresDatabase(databaseUrl);
const connectionOwnedTables = [
	'team_service_connections',
	'team_service_capability_bindings',
	'team_service_credential_profiles',
	'credential_envelopes',
	'external_vault_bindings',
	'secret_operation_leases',
] as const;
const cleaned = [];

try {
	for (const name of teamNames) {
		const team = await database.prepare(`SELECT id FROM teams WHERE name = ? LIMIT 1`).bind(name).first();
		assert.ok(team?.id, `Run-created team ${name} no longer resolves.`);
		const teamId = String(team.id);

		for (const table of connectionOwnedTables) {
			const row = await database.prepare(`SELECT COUNT(*)::integer AS count FROM ${table} WHERE team_id = ?`)
				.bind(teamId)
				.first();
			assert.equal(row?.count, 0, `${name} retains ${String(row?.count)} row(s) in ${table} after UI disconnection.`);
		}

		const keyRows = await database.prepare(
			`SELECT DISTINCT user_vault_key_id FROM team_vault_grants WHERE team_id = ?`,
		).bind(teamId).all();
		await database.batch([
			{ query: `DELETE FROM team_vault_grants WHERE team_id = ?`, params: [teamId] },
			{ query: `DELETE FROM team_vaults WHERE team_id = ?`, params: [teamId] },
		]);
		for (const row of keyRows.results) {
			await database.prepare(
				`DELETE FROM user_vault_keys
				 WHERE id = ?
				   AND NOT EXISTS (SELECT 1 FROM team_vault_grants WHERE user_vault_key_id = ?)`,
			).bind(row.user_vault_key_id, row.user_vault_key_id).run();
		}

		const remainingGrant = await database.prepare(
			`SELECT COUNT(*)::integer AS count FROM team_vault_grants WHERE team_id = ?`,
		).bind(teamId).first();
		const remainingVault = await database.prepare(
			`SELECT COUNT(*)::integer AS count FROM team_vaults WHERE team_id = ?`,
		).bind(teamId).first();
		assert.equal(remainingGrant?.count, 0, `${name} retains vault grants after fixture cleanup.`);
		assert.equal(remainingVault?.count, 0, `${name} retains a team vault after fixture cleanup.`);
		cleaned.push({ name, teamId, userVaultKeysConsidered: keyRows.results.length });
	}
} finally {
	await database.close();
}

process.stdout.write(`${JSON.stringify({ ok: true, cleaned }, null, 2)}\n`);
