import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.js';
import { ControlPlanePostgresDatabase } from '../../../../src/api/support/control-plane-postgres.js';
import { applyLocalSeedFromCli } from '../../../../src/control-plane/seeds/apply.js';
import { seedTreeDxFetch } from '../../../support/seed-treedx.js';

const packageRoot = process.cwd();
const seedRoot = resolve(packageRoot, 'tests/fixtures/seed-project');
const migrationRoot = resolve(packageRoot, 'drizzle/control-plane');

function fixture() {
	const memory = newDb();
	memory.public.registerFunction({ name: "replace", args: [DataType.text, DataType.text, DataType.text], returns: DataType.text, implementation: (value: string, search: string, replacement: string) => value.split(search).join(replacement) });
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const db = ControlPlanePostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { db, store: new ControlPlaneStore({ repoRoot: packageRoot, projectId: 'membership-seed-test', authSecret: 'test', assertionSecret: 'test', serviceId: 'web', serviceSecret: 'test', fetchImpl: seedTreeDxFetch }, db) };
}

describe('seed team membership claims', () => {
	it('defers a missing user, binds the verified email, and reapplies idempotently', async () => {
		const { db, store } = fixture();
		try {
			await applyLocalSeedFromCli({ projectRoot: seedRoot, seedName: 'treeseed', environments: 'local', store });
			const pending = await store.getSeedTeamMembershipClaim('treeseed', 'membership:treeseed/adrian-webb');
			expect(pending).toMatchObject({ status: 'pending', normalized_email: 'adrian.webb@treeseed.dev' });
			const now = new Date().toISOString();
			await store.run(`INSERT INTO users (id, email, display_name, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'active', '{}', ?, ?)`, ['seed-owner', 'adrian.webb@treeseed.dev', 'Adrian Webb', now, now]);
			await store.run(`INSERT INTO user_email_addresses (id, user_id, email, normalized_email, status, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, 'verified', true, ?, ?)`, ['seed-owner-email', 'seed-owner', 'adrian.webb@treeseed.dev', 'adrian.webb@treeseed.dev', now, now]);
			await store.claimSeedTeamMembershipsForVerifiedEmail('seed-owner', 'adrian.webb@treeseed.dev');
			await applyLocalSeedFromCli({ projectRoot: seedRoot, seedName: 'treeseed', environments: 'local', store });
			const bound = await store.getSeedTeamMembershipClaim('treeseed', 'membership:treeseed/adrian-webb');
			expect(bound).toMatchObject({ status: 'bound', user_id: 'seed-owner' });
			const bindings = await store.all(`SELECT r.key AS role_key FROM team_role_bindings b JOIN roles r ON r.id = b.role_id WHERE b.team_membership_id = ?`, [bound!.membership_id]);
			expect(bindings.map((entry) => entry.role_key)).toContain('team_owner');
			expect((await store.all(`SELECT id FROM team_role_bindings WHERE id LIKE 'seed-member:%'`))).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});
