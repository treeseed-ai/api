import { describe, expect, it } from 'vitest';
import {
	assertCoverage,
	bodyForFactory,
	expandDeploymentFlows,
	expandDescriptorMatrices,
	expandRoleMatrices,
	expandSdkMethodMatrices,
	loadSpec,
} from '../../scripts/api-acceptance.ts';
import { ACCEPTANCE_ACTORS, API_ROUTE_DESCRIPTORS, SDK_METHOD_ROUTE_MAP } from '../../src/api/route-descriptors.js';

describe('API acceptance framework', () => {
	it('expands every active route into coverage actor cases', () => {
		const spec = loadSpec('test/acceptance/api.base.yaml');
		const descriptorCases = expandDescriptorMatrices(spec);
		const descriptorIds = new Set(descriptorCases.map((entry) => entry.descriptorId));
		expect(descriptorIds.size).toBe(API_ROUTE_DESCRIPTORS.length);
		for (const descriptor of API_ROUTE_DESCRIPTORS) {
			for (const actor of ACCEPTANCE_ACTORS) {
				expect(descriptorCases.some((entry) => entry.descriptorId === descriptor.id && entry.actor === actor)).toBe(true);
			}
		}
		expect(descriptorCases.every((entry) => entry.coverageOnly === true)).toBe(true);
		expect(descriptorCases.every((entry) => Number.isInteger(entry.expect.status))).toBe(true);
		expect(descriptorCases.every((entry) => entry.expect.statusAny === undefined)).toBe(true);
		expect(descriptorCases.find((entry) => entry.id === 'descriptor-executable-role-matrix.post.v1.auth.web.sign-up.anonymous')).toMatchObject({
			method: 'POST',
			path: '/v1/auth/web/sign-up',
			expect: { status: 200 },
			coverageOnly: true,
		});
	});

	it('requires a live sign-up case that sends confirmation email', () => {
		const spec = loadSpec('test/acceptance/api.base.yaml');
		const explicitCases = (spec.cases ?? []) as Array<{ id?: string }>;
		expect(spec.coverage.requiredCaseIds).toContain('auth.web.sign-up.sends-confirmation-email');
		expect(explicitCases.find((entry) => entry.id === 'auth.web.sign-up.sends-confirmation-email')).toMatchObject({
			actor: 'anonymous',
			method: 'POST',
			path: '${apiVersionPath}/auth/web/sign-up',
			expect: {
				status: 200,
				envelope: { ok: true },
			},
		});
	});

	it('generates safe request bodies for non-GET route descriptors', () => {
		for (const descriptor of API_ROUTE_DESCRIPTORS.filter((entry) => entry.method !== 'GET')) {
			const body = bodyForFactory(descriptor.acceptance.bodyFactory, descriptor, 'teamOwner');
			if (descriptor.acceptance.bodyFactory === 'empty') {
				expect(body).toBeUndefined();
			} else {
				expect(body).toBeDefined();
			}
		}
	});

	it('expands SDK method cases from the descriptor map and enforces coverage', () => {
		const spec = loadSpec('test/acceptance/api.base.yaml');
		const allCases = [
			...(spec.cases ?? []),
			...expandDeploymentFlows(spec),
			...expandRoleMatrices(spec),
			...expandDescriptorMatrices(spec),
			...expandSdkMethodMatrices(spec),
		];
		assertCoverage(spec, allCases);
		const sdkMethods = new Set(allCases.map((entry) => entry.sdkMethod).filter(Boolean));
		expect([...sdkMethods].sort()).toEqual(Object.keys(SDK_METHOD_ROUTE_MAP).sort());
	});

	it('includes the mocked web deployment acceptance flow in expansion', () => {
		const spec = loadSpec('test/acceptance/api.base.yaml');
		const flows = expandDeploymentFlows(spec);
		expect(flows).toHaveLength(1);
		expect(flows[0]).toMatchObject({
			id: 'deployment-flow.mocked-web-deployment',
			actor: 'teamOwner',
			deploymentFlow: true,
			method: 'FLOW',
		});
		expect(JSON.stringify(flows)).not.toMatch(/capacityProviderId|runnerToken|TREESEED_PLATFORM_RUNNER_SECRET/u);
	});

	it('filters generated cases by explicit case id before expansion', () => {
		const spec = loadSpec('test/acceptance/api.base.yaml');
		expect(expandRoleMatrices(spec, 'site-role-matrix.me.teamOwner').map((entry) => entry.id)).toEqual(['site-role-matrix.me.teamOwner']);
		expect(expandDeploymentFlows(spec, 'site-role-matrix.me.teamOwner')).toEqual([]);
		expect(expandDescriptorMatrices(spec, undefined, 'descriptor-executable-role-matrix.get.v1.me.teamOwner').map((entry) => entry.id)).toEqual([
			'descriptor-executable-role-matrix.get.v1.me.teamOwner',
		]);
		expect(expandSdkMethodMatrices(spec, undefined, 'sdk.me.teamOwner').map((entry) => entry.id)).toEqual(['sdk.me.teamOwner']);
	});

	it('defines team guarantee verifier cases against stable seeded fixture fields', () => {
		const spec = loadSpec('test/acceptance/api.base.yaml');
		const explicitCases = (spec.cases ?? []) as Array<{ id?: string; path?: string; body?: Record<string, unknown> }>;
		expect(explicitCases.find((entry) => entry.id === 'teams.profile.by-name')?.path).toBe('${apiVersionPath}/teams/by-name/${fixtures.team.slug}/profile');
		expect(explicitCases.find((entry) => entry.id === 'teams.member-role.team-owner')).toMatchObject({
			path: '${apiVersionPath}/teams/${fixtures.team.id}/members/${fixtures.memberships.teamViewer.id}',
			body: { roleKey: 'contributor' },
		});
		expect(explicitCases.find((entry) => entry.id === 'teams.member-remove.team-owner')?.path).toBe('${apiVersionPath}/teams/${fixtures.team.id}/members/${fixtures.memberships.teamViewer.id}');
	});

	it('writes an expanded case report for review without requiring live credentials', async () => {
		const { mkdtempSync, readFileSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const { spawnSync } = await import('node:child_process');
		const dir = mkdtempSync(join(tmpdir(), 'treeseed-acceptance-expand-'));
		const output = join(dir, 'cases.json');
		const result = spawnSync(process.execPath, ['./scripts/api-acceptance.ts', '--environment', 'local', '--expand-json', output], {
			encoding: 'utf8',
		});
		expect(result.status).toBe(0);
		const expanded = JSON.parse(readFileSync(output, 'utf8'));
		expect(expanded.caseCount).toBeGreaterThan(2700);
		expect(expanded.cases.some((entry: any) => entry.id === 'deployment-flow.mocked-web-deployment' && entry.deploymentFlow === true)).toBe(true);
		expect(expanded.cases.filter((entry: any) => entry.expect?.statusAny !== undefined).map((entry: any) => entry.id)).toEqual([
			'sdk.auditProjectHosts.teamOwner',
			'sdk.resyncProjectHost.teamOwner',
			'sdk.rotateProjectHost.teamOwner',
		]);
	});
});
