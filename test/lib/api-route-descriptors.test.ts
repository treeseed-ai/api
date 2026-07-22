import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CAPACITY_OPERATOR_CAPABILITIES } from '@treeseed/sdk/agent-capacity';
import {
	API_ENDPOINT_GUARANTEE_FAMILIES,
	API_ROUTE_DESCRIPTORS,
	ACCEPTANCE_ACTORS,
	TEAM_MANAGER_ACTORS,
	TEAM_MEMBER_ACTORS,
	PROJECT_MANAGER_ACTORS,
	PROJECT_MEMBER_ACTORS,
	SDK_METHOD_ROUTE_MAP,
	extractActiveApiRoutes,
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

describe('API route descriptors', () => {
	it('implements every API route in the canonical capacity operator matrix', () => {
		const descriptors = new Set(API_ROUTE_DESCRIPTORS.map((descriptor) => descriptor.id));
		const missing = CAPACITY_OPERATOR_CAPABILITIES.flatMap((capability) =>
			capability.apiRouteIds
				.filter((routeId) => !descriptors.has(routeId))
				.map((routeId) => ({ capability: capability.id, routeId })),
		);
		expect(missing).toEqual([]);
	});

	it('matches every human capacity capability to its descriptor permission class', () => {
		const descriptors = new Map(API_ROUTE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));
		const actors = {
			'team-read': TEAM_MEMBER_ACTORS,
			'team-manage': TEAM_MANAGER_ACTORS,
			'project-read': PROJECT_MEMBER_ACTORS,
			'project-manage': PROJECT_MANAGER_ACTORS,
		} as const;
		const mismatches = CAPACITY_OPERATOR_CAPABILITIES.flatMap((capability) => {
			if (!(capability.access in actors)) return [];
			const expected = actors[capability.access as keyof typeof actors];
			return capability.apiRouteIds.flatMap((routeId) => {
				const actual = descriptors.get(routeId)?.acceptance.successActors;
				return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ capability: capability.id, routeId, expected, actual }];
			});
		});
		expect(mismatches).toEqual([]);
	});

	it('describes every active v1 route declared by the API', () => {
		const extracted = extractActiveApiRoutes();
		expect(API_ROUTE_DESCRIPTORS.map((route) => route.id)).toEqual(extracted.map((route) => route.id));
		expect(new Set(API_ROUTE_DESCRIPTORS.map((route) => route.id)).size).toBe(API_ROUTE_DESCRIPTORS.length);
		expect(API_ROUTE_DESCRIPTORS.find((route) => route.id === 'get.v1.users.by-username.username.profile')).toMatchObject({
			authClass: 'user',
			ownerDomain: 'market',
		});
	});

	it('discovers routes from every focused capacity route owner', () => {
		const descriptorIds = new Set(API_ROUTE_DESCRIPTORS.map((route) => route.id));
		for (const id of [
			'post.v1.provider.assignments.next',
			'post.v1.provider.assignments.assignmentId.mode-runs',
			'post.v1.decisions.decisionId.estimates',
			'post.v1.structured-agent-estimates.estimateId.accept',
			'post.v1.structured-agent-estimates.estimateId.reject',
			'post.v1.decisions.decisionId.assignment-graphs.compile',
			'post.v1.deliverable-contracts.contractId.approve',
			'post.v1.deliverable-contracts.contractId.reject',
			'get.v1.deliverable-manifests.manifestId',
		]) expect(descriptorIds.has(id), id).toBe(true);
	});

	it('keeps provider ingress and platform runner endpoints in separate trust classes', () => {
		const provider = API_ROUTE_DESCRIPTORS.filter((route) => route.providerIngress);
		const runner = API_ROUTE_DESCRIPTORS.filter((route) => route.internalRunner);
		expect(provider.length).toBeGreaterThan(0);
		expect(runner.length).toBeGreaterThan(0);
		expect(provider.every((route) => ['provider-access-token', 'provider-proof'].includes(route.authClass))).toBe(true);
		expect(provider.some((route) => route.authClass === 'provider-proof')).toBe(true);
		expect(provider.filter((route) => route.authClass === 'provider-access-token').every((route) => route.acceptance.successActors.includes('providerAccessToken'))).toBe(true);
		expect(API_ROUTE_DESCRIPTORS.some((route) => route.path.includes('/heartbeat') && route.path.includes('/capacity/providers/'))).toBe(false);
		expect(JSON.stringify(API_ROUTE_DESCRIPTORS)).not.toMatch(/providerKey|provider-key/u);
		expect(runner.every((route) => route.authClass === 'platform-runner')).toBe(true);
	});

	it('models capacity read, management, reveal, and provider trust boundaries exactly', () => {
		const byId = new Map(API_ROUTE_DESCRIPTORS.map((route) => [route.id, route]));
		for (const id of [
			'get.v1.teams.teamId.capacity-registration-key',
			'get.v1.teams.teamId.capacity-registration-key.reveal',
			'post.v1.teams.teamId.capacity-registration-key.rotate',
			'post.v1.teams.teamId.capacity-provider-requests.requestId.approve',
			'post.v1.teams.teamId.capacity-provider-memberships.membershipId.suspend',
			'post.v1.teams.teamId.capacity-provider-memberships.membershipId.credentials.rotate',
			'post.v1.teams.teamId.capacity-grants',
			'post.v1.teams.teamId.capacity.allocation-sets.allocationSetId.activate',
			'post.v1.teams.teamId.workday-runs.runId.tick',
		]) {
			expect(byId.get(id)?.acceptance.successActors, id).toEqual(TEAM_MANAGER_ACTORS);
		}
		for (const id of [
			'get.v1.teams.teamId.capacity-provider-requests',
			'get.v1.teams.teamId.capacity-grants',
			'get.v1.teams.teamId.capacity.assignments',
			'post.v1.teams.teamId.capacity.allocation-sets.allocationSetId.explain',
		]) {
			expect(byId.get(id)?.acceptance.successActors, id).toEqual(TEAM_MEMBER_ACTORS);
		}
		expect(byId.get('post.v1.provider.assignments.next')?.authClass).toBe('provider-access-token');
		expect(byId.get('post.v1.provider.assignments.next')?.acceptance.successActors).toEqual(['providerAccessToken']);
	});

	it('attaches executable acceptance metadata to every active route', () => {
		for (const descriptor of API_ROUTE_DESCRIPTORS) {
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

	it('attaches endpoint guarantee family metadata to every active route', () => {
		const families = new Set(API_ENDPOINT_GUARANTEE_FAMILIES);
		for (const descriptor of API_ROUTE_DESCRIPTORS) {
			expect(descriptor.guarantee, descriptor.id).toMatchObject({
				familyId: expect.any(String),
				verifierRef: expect.stringMatching(/^api\.endpoints\./u),
				coverage: expect.stringMatching(/^(descriptor-matrix|workflow|descriptor-and-workflow)$/u),
			});
			expect(families.has(descriptor.guarantee.familyId), descriptor.id).toBe(true);
			expect(descriptor.guarantee.verifierRef).toBe(`api.endpoints.${descriptor.guarantee.familyId}`);
		}
		expect(new Set(API_ROUTE_DESCRIPTORS.map((route) => route.guarantee.familyId))).toEqual(families);
	});

	it('backs every endpoint guarantee family with an honest lifecycle state and verifier ref', () => {
		for (const familyId of API_ENDPOINT_GUARANTEE_FAMILIES) {
			const guaranteePath = resolve(process.cwd(), 'guarantees/api/endpoints', `${familyId}.guarantee.yaml`);
			expect(existsSync(guaranteePath), familyId).toBe(true);
			const text = readFileSync(guaranteePath, 'utf8');
			const guarantee = parse(text) as { status?: string };
			expect(['active', 'planned', 'blocked', 'backlog']).toContain(guarantee.status);
			expect(text).toContain(`api.endpoints.${familyId}`);
		}
		const verifierText = readFileSync('guarantees/verifiers/api.verifiers.yaml', 'utf8');
		for (const familyId of API_ENDPOINT_GUARANTEE_FAMILIES) {
			expect(verifierText, familyId).toContain(`api.endpoints.${familyId}:`);
		}
	});

	it('generates a route descriptor endpoint guarantee coverage report', () => {
		const report = {
			routeCount: API_ROUTE_DESCRIPTORS.length,
			descriptorCount: API_ROUTE_DESCRIPTORS.length,
			coveredByGuarantee: API_ROUTE_DESCRIPTORS.filter((descriptor) => descriptor.guarantee?.familyId).length,
			missingRoutes: API_ROUTE_DESCRIPTORS.filter((descriptor) => !descriptor.guarantee?.familyId).map((descriptor) => descriptor.id),
			families: Object.fromEntries(API_ENDPOINT_GUARANTEE_FAMILIES.map((familyId) => [
				familyId,
				API_ROUTE_DESCRIPTORS.filter((descriptor) => descriptor.guarantee.familyId === familyId).map((descriptor) => descriptor.id),
			])),
		};
		expect(report.missingRoutes).toEqual([]);
		expect(report.coveredByGuarantee).toBe(report.routeCount);
		mkdirSync(resolve(process.cwd(), 'reports'), { recursive: true });
		writeFileSync(resolve(process.cwd(), 'reports/api-endpoint-guarantee-coverage.json'), `${JSON.stringify(report, null, 2)}\n`);
	});

	it('maps every public MarketClient method to an active descriptor-backed endpoint', () => {
		const descriptorIds = new Set(API_ROUTE_DESCRIPTORS.map((route) => route.id));
		const methods = publicMarketClientMethods();
		const missingMappings = methods.filter((method) => !(method in SDK_METHOD_ROUTE_MAP));
		const staleMappings = Object.entries(SDK_METHOD_ROUTE_MAP)
			.filter(([, routeId]) => !descriptorIds.has(routeId))
			.map(([method, routeId]) => `${method}:${routeId}`);
		expect(missingMappings).toEqual([]);
		expect(staleMappings).toEqual([]);
	});

	it('keeps live acceptance descriptor-covered with explicit email delivery coverage', () => {
		const spec = parse(readFileSync('test/acceptance/api.base.yaml', 'utf8')) as any;
		expect(spec.coverage?.requireAllDescriptors).toBe(true);
		expect(spec.coverage?.requireAllSdkMethods).toBe(true);
		expect(spec.descriptorMatrices).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: 'descriptor-executable-role-matrix',
				methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
				actors: expect.arrayContaining(['anonymous', 'siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator', 'platformRunner']),
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
		const spec = parse(readFileSync('test/acceptance/api.base.yaml', 'utf8')) as any;
		expect(spec.descriptorMatrices ?? []).not.toEqual(expect.arrayContaining([
			expect.objectContaining({
				expect: expect.objectContaining({
					statusAny: expect.any(Array),
				}),
			}),
		]));
		for (const descriptor of API_ROUTE_DESCRIPTORS) {
			expect(descriptor.acceptance).not.toHaveProperty('successStatusAny');
			expect(descriptor.acceptance).not.toHaveProperty('deniedStatusAny');
		}
	});

	it('has exact expected statuses for every descriptor actor pair', () => {
		const baseline = JSON.parse(readFileSync('test/acceptance/api.expected-statuses.json', 'utf8')) as any;
		for (const descriptor of API_ROUTE_DESCRIPTORS) {
			for (const actor of ACCEPTANCE_ACTORS) {
				expect(baseline.statuses?.[descriptor.id]?.[actor], `${descriptor.id} ${actor}`).toEqual(expect.any(Number));
			}
		}
	});
});
