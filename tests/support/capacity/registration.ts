import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
import type { CapacityProviderPublicJwk, ProviderRegistrationSubmission } from '@treeseed/sdk/capacity-provider/contracts';
import { MarketPostgresDatabase } from '../../../src/api/support/market-postgres.js';
import { MarketControlPlaneStore } from '../../../src/api/persistence/store.js';
import { createCapacityControlPlane, type CapacityControlPlaneStore } from '../../../src/api/capacity/control-plane.ts';
import { CapacityGovernanceRepository } from '../../../src/api/capacity/repositories/governance/policy/governance.ts';
import { CapacityRegistrationService } from '../../../src/api/capacity/services/support/registration-service.ts';
import { CapacitySecretCodec, canonicalJson, capacityProviderFingerprint, sha256 } from '../../../src/api/capacity/security.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
export const capacityRegistrationAudience = 'https://api.example.test';

export function createCapacityRegistrationTestHarness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = createCapacityControlPlane(new MarketControlPlaneStore({
		repoRoot: packageRoot,
		authSecret: 'capacity-registration-test-auth-secret',
		serviceId: 'web',
		serviceSecret: 'test-service-secret',
		assertionSecret: 'test-assertion-secret',
	}, database));
	const repository = new CapacityGovernanceRepository(store);
	return {
		database,
		store,
		repository,
		service: new CapacityRegistrationService(
			repository,
			new CapacitySecretCodec('capacity-registration-test-secret-123'),
			capacityRegistrationAudience,
		),
	};
}

export function capacityProviderTestIdentity(): { privateKey: KeyObject; publicJwk: CapacityProviderPublicJwk } {
	const pair = generateKeyPairSync('ed25519');
	return {
		privateKey: pair.privateKey,
		publicJwk: pair.publicKey.export({ format: 'jwk' }) as CapacityProviderPublicJwk,
	};
}

export function capacityProviderTestProof(input: {
	privateKey: KeyObject;
	publicJwk: CapacityProviderPublicJwk;
	method: string;
	path: string;
	body: unknown;
	jti: string;
	identityVersion?: number;
	issuedAt?: string;
	expiresAt?: string;
}) {
	const now = Date.now();
	const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JOSE' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({
		schemaVersion: 1,
		algorithm: 'Ed25519',
		providerFingerprint: capacityProviderFingerprint(input.publicJwk),
		identityVersion: input.identityVersion ?? 1,
		method: input.method,
		path: input.path,
		bodySha256: sha256(canonicalJson(input.body)),
		audience: capacityRegistrationAudience,
		issuedAt: input.issuedAt ?? new Date(now - 1_000).toISOString(),
		expiresAt: input.expiresAt ?? new Date(now + 4 * 60_000).toISOString(),
		jti: input.jti,
	})).toString('base64url');
	return {
		protected: header,
		payload,
		signature: sign(null, Buffer.from(`${header}.${payload}`), input.privateKey).toString('base64url'),
	};
}

export function capacityProviderTestSubmission(
	identity: ReturnType<typeof capacityProviderTestIdentity>,
	team: string,
	jti: string,
): ProviderRegistrationSubmission {
	const unsigned = {
		schemaVersion: 1 as const,
		displayName: 'Shared Provider',
		publicJwk: identity.publicJwk,
		capabilitySummary: ['engineering', 'research'],
		supplyOffer: { weight: 1, maxConcurrentRunners: 2, capabilities: ['engineering', 'research'] },
		metadata: { requestedTeam: team },
	};
	return {
		...unsigned,
		proof: capacityProviderTestProof({
			privateKey: identity.privateKey,
			publicJwk: identity.publicJwk,
			method: 'POST',
			path: '/v1/provider-registrations',
			body: unsigned,
			jti,
		}),
	};
}

export async function ensureCapacityTestTeam(store: CapacityControlPlaneStore, teamId: string) {
	const now = new Date().toISOString();
	await store.run(
		`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
		[teamId, teamId, teamId, now, now],
	);
}
