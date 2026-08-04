import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketControlPlaneStore } from '../../../../src/api/persistence/store.js';
import { MarketPostgresDatabase } from '../../../../src/api/support/market-postgres.js';
import { applyLocalSeedFromCli } from '../../../../src/market/seeds/apply.js';

const projectRoot = resolve(process.cwd(), '../..');
const migrationRoot = existsSync(resolve(projectRoot, 'packages/sdk/drizzle/market'))
	? resolve(projectRoot, 'packages/sdk/drizzle/market')
	: resolve(process.cwd(), 'node_modules/@treeseed/sdk/drizzle/market');

function fixture() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const db = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { db, store: new MarketControlPlaneStore({ repoRoot: projectRoot, projectId: 'membership-seed-test', authSecret: 'test', assertionSecret: 'test', serviceId: 'web', serviceSecret: 'test' }, db) };
}

describe('seed team membership claims', () => {
	it('defers a missing user, binds the verified email, and reapplies idempotently', async () => {
		const { db, store } = fixture();
		try {
			await applyLocalSeedFromCli({ projectRoot, seedName: 'treeseed', environments: 'local', store });
			const pending = await store.getSeedTeamMembershipClaim('treeseed', 'membership:treeseed/adrian-webb');
			expect(pending).toMatchObject({ status: 'pending', normalized_email: 'adrian.webb@knowledge.coop' });
			const now = new Date().toISOString();
			await store.run(`INSERT INTO users (id, email, display_name, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'active', '{}', ?, ?)`, ['seed-owner', 'adrian.webb@knowledge.coop', 'Adrian Webb', now, now]);
			await store.run(`INSERT INTO user_email_addresses (id, user_id, email, normalized_email, status, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, 'verified', true, ?, ?)`, ['seed-owner-email', 'seed-owner', 'adrian.webb@knowledge.coop', 'adrian.webb@knowledge.coop', now, now]);
			await store.claimSeedTeamMembershipsForVerifiedEmail('seed-owner', 'adrian.webb@knowledge.coop');
			await applyLocalSeedFromCli({ projectRoot, seedName: 'treeseed', environments: 'local', store });
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
