import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApiApp } from '../../../src/api/app.js';
import { createMarketPostgresDatabase } from '../../../src/api/market-postgres.js';
import { ACCEPTANCE_ACTORS, API_ROUTE_DESCRIPTORS, SDK_METHOD_ROUTE_MAP } from '../../../src/api/route-descriptors.js';
import { MarketControlPlaneStore, validateProjectSlug } from '../../../src/api/store.js';
import { main as runMarketOperationsRunner } from '../../../src/operations-runner/entrypoint.js';

function createNoopStore() {
	return new Proxy({
		setArtifactBucket() {},
	}, {
		get(target, property) {
			if (property in target) return target[property as keyof typeof target];
			return async () => null;
		},
	});
}

describe('API package surface', () => {
	it('exports the backend constructors used by deployment entrypoints', () => {
		expect(typeof createApiApp).toBe('function');
		expect(typeof MarketControlPlaneStore).toBe('function');
		expect(typeof createMarketPostgresDatabase).toBe('function');
		expect(typeof validateProjectSlug).toBe('function');
		expect(typeof runMarketOperationsRunner).toBe('function');
	});

	it('constructs the Hono app with injected backend dependencies', () => {
		const app = createApiApp({
			db: {},
			store: createNoopStore(),
			config: {
				repoRoot: process.cwd(),
				projectId: 'treeseed-market-test',
				baseUrl: 'http://127.0.0.1:3000',
				issuer: 'http://127.0.0.1:3000',
				authSecret: 'test-auth-secret',
				webAssertionSecret: 'test-web-assertion-secret',
				webServiceId: 'web',
				webServiceSecret: 'test-web-service-secret',
				providers: {
					auth: 'stub',
				},
			},
			runtimeProviders: {
				auth: {
					stub: () => ({}),
				},
			},
			sdk: {},
		});

		expect(typeof app.fetch).toBe('function');
	});
});

describe('route descriptors', () => {
	it('covers the SDK route map with unique route ids', () => {
		const ids = new Set(API_ROUTE_DESCRIPTORS.map((descriptor) => descriptor.id));
		expect(ids.size).toBe(API_ROUTE_DESCRIPTORS.length);
		for (const routeId of Object.values(SDK_METHOD_ROUTE_MAP)) {
			expect(ids.has(routeId)).toBe(true);
		}
	});

	it('has expected acceptance statuses for every descriptor actor matrix entry', () => {
		const expected = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/acceptance/api/expected-statuses.json'), 'utf8'));
		const statuses = expected.statuses ?? {};
		for (const descriptor of API_ROUTE_DESCRIPTORS) {
			expect(statuses[descriptor.id], descriptor.id).toBeTruthy();
			for (const actor of ACCEPTANCE_ACTORS) {
				expect(statuses[descriptor.id][actor], `${descriptor.id}:${actor}`).toEqual(expect.any(Number));
			}
		}
	});
});
