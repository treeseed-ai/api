import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe,expect,it } from 'vitest';
import { ControlPlaneStore,validateProjectSlug } from '../../../src/api/persistence/store.js';
import { createPlatformApiApp } from '../../../src/api/support/app.js';
import { createControlPlanePostgresDatabase } from '../../../src/api/support/control-plane-postgres.js';
import { ACCEPTANCE_ACTORS,API_ROUTE_DESCRIPTORS } from '../../../src/api/support/route-descriptors.js';
import { main as runAPIOperationsRunner } from '../../../src/operations-runner/entrypoint.js';

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
		expect(typeof createPlatformApiApp).toBe('function');
		expect(typeof ControlPlaneStore).toBe('function');
		expect(typeof createControlPlanePostgresDatabase).toBe('function');
		expect(typeof validateProjectSlug).toBe('function');
		expect(typeof runAPIOperationsRunner).toBe('function');
	});

	it('constructs the Hono app with injected backend dependencies', () => {
		const app = createPlatformApiApp({
			db: {},
			store: createNoopStore(),
			config: {
				repoRoot: process.cwd(),
				projectId: 'treeseed-api-test',
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
