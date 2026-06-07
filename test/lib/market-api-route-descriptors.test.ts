import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
	MARKET_API_ROUTE_DESCRIPTORS,
	SDK_METHOD_ROUTE_MAP,
	extractActiveMarketApiRoutes,
} from '../../src/api/route-descriptors.js';

function publicMarketClientMethods() {
	const sourcePath = existsSync(resolve(process.cwd(), '../sdk/src/market-client.ts'))
		? resolve(process.cwd(), '../sdk/src/market-client.ts')
		: resolve(process.cwd(), 'node_modules/@treeseed/sdk/dist/market-client.js');
	const source = readFileSync(sourcePath, 'utf8');
	const classStart = source.indexOf('export class MarketClient');
	const classSource = source.slice(classStart);
	const methodNames = [...classSource.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9_]*)\([^)]*\)\s*\{/gmu)]
		.map((match) => match[1])
		.filter((name) => !['constructor', 'headers', 'url', 'request', 'tryRequest'].includes(name));
	return [...new Set(methodNames)];
}

describe('Market API route descriptors', () => {
	it('describes every active v1 route declared by the Market API', () => {
		const extracted = extractActiveMarketApiRoutes();
		expect(MARKET_API_ROUTE_DESCRIPTORS.map((route) => route.id)).toEqual(extracted.map((route) => route.id));
		expect(MARKET_API_ROUTE_DESCRIPTORS).toHaveLength(315);
		expect(MARKET_API_ROUTE_DESCRIPTORS.find((route) => route.id === 'get.v1.users.by-username.username.profile')).toMatchObject({
			authClass: 'user',
			ownerDomain: 'market',
		});
	});

	it('keeps provider ingress and platform runner endpoints in separate trust classes', () => {
		const provider = MARKET_API_ROUTE_DESCRIPTORS.filter((route) => route.providerIngress);
		const runner = MARKET_API_ROUTE_DESCRIPTORS.filter((route) => route.internalRunner);
		expect(provider.length).toBeGreaterThan(0);
		expect(runner.length).toBeGreaterThan(0);
		expect(provider.every((route) => route.authClass === 'provider-key')).toBe(true);
		expect(runner.every((route) => route.authClass === 'platform-runner')).toBe(true);
	});

	it('attaches executable acceptance metadata to every active route', () => {
		for (const descriptor of MARKET_API_ROUTE_DESCRIPTORS) {
			expect(descriptor.acceptance).toMatchObject({
				successActors: expect.any(Array),
				denyActors: expect.any(Array),
				exactStatusRequired: true,
				productionSafe: true,
				productionStrategy: expect.any(String),
			});
			if (descriptor.method !== 'GET') {
				expect(descriptor.acceptance).toHaveProperty('bodyFactory');
			}
		}
	});

	it('maps every public MarketClient method to an active descriptor-backed endpoint', () => {
		const descriptorIds = new Set(MARKET_API_ROUTE_DESCRIPTORS.map((route) => route.id));
		const methods = publicMarketClientMethods();
		const missingMappings = methods.filter((method) => !(method in SDK_METHOD_ROUTE_MAP));
		const staleMappings = Object.entries(SDK_METHOD_ROUTE_MAP)
			.filter(([, routeId]) => !descriptorIds.has(routeId))
			.map(([method, routeId]) => `${method}:${routeId}`);
		expect(missingMappings).toEqual([]);
		expect(staleMappings).toEqual([]);
	});

	it('keeps live acceptance descriptor-covered with explicit email delivery coverage', () => {
		const spec = parse(readFileSync('test/acceptance/market-api.base.yaml', 'utf8')) as any;
		expect(spec.coverage?.requireAllDescriptors).toBe(true);
		expect(spec.coverage?.requireAllSdkMethods).toBe(true);
		expect(spec.descriptorMatrices).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: 'descriptor-executable-role-matrix',
				methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
				actors: expect.arrayContaining(['anonymous', 'siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator', 'providerKey', 'platformRunner']),
				excludeProviderIngress: false,
				excludeInternalRunner: false,
				coverageOnly: true,
			}),
		]));
		expect(spec.coverage?.requiredCaseIds).toContain('auth.web.sign-up.sends-confirmation-email');
		expect(spec.cases).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: 'auth.web.sign-up.sends-confirmation-email',
				method: 'POST',
				path: '${apiVersionPath}/auth/web/sign-up',
				expect: expect.objectContaining({ status: 200 }),
			}),
		]));
	});

	it('does not allow descriptor-generated acceptance cases to use broad status ranges', () => {
		const spec = parse(readFileSync('test/acceptance/market-api.base.yaml', 'utf8')) as any;
		expect(spec.descriptorMatrices ?? []).not.toEqual(expect.arrayContaining([
			expect.objectContaining({
				expect: expect.objectContaining({
					statusAny: expect.any(Array),
				}),
			}),
		]));
		for (const descriptor of MARKET_API_ROUTE_DESCRIPTORS) {
			expect(descriptor.acceptance).not.toHaveProperty('successStatusAny');
			expect(descriptor.acceptance).not.toHaveProperty('deniedStatusAny');
		}
	});

	it('has exact expected statuses for every descriptor actor pair', () => {
		const baseline = JSON.parse(readFileSync('test/acceptance/market-api.expected-statuses.json', 'utf8')) as any;
		for (const descriptor of MARKET_API_ROUTE_DESCRIPTORS) {
			for (const actor of ['anonymous', 'siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator', 'providerKey', 'platformRunner']) {
				expect(baseline.statuses?.[descriptor.id]?.[actor], `${descriptor.id} ${actor}`).toEqual(expect.any(Number));
			}
		}
	});
});
