import { describe, expect, it } from 'vitest';
import {
	addOptionalAcceptanceServiceHeaders,
	assertAcceptanceTarget,
	assertCoverage,
	bodyForFactory,
	expandDeploymentFlows,
	expandDescriptorMatrices,
	expandRoleMatrices,
	expandSdkMethodMatrices,
	loadSpec,
	usesHostedAcceptanceEmailBypass,
} from '../../scripts/api-acceptance.ts';
import { ACCEPTANCE_ACTORS, API_ROUTE_DESCRIPTORS, SDK_METHOD_ROUTE_MAP } from '../../src/api/route-descriptors.js';

describe('API acceptance framework', () => {
	it('refuses hosted acceptance runs against local dev URLs', () => {
		expect(() => assertAcceptanceTarget({ environment: 'staging', baseUrl: 'http://127.0.0.1:3000' })).toThrow('must target a live hosted API URL');
		expect(() => assertAcceptanceTarget({ environment: 'prod', baseUrl: 'https://api.preview.treeseed.dev' })).toThrow('Production API acceptance must target https://api.treeseed.dev');
		expect(() => assertAcceptanceTarget({ environment: 'staging', baseUrl: 'https://api.preview.treeseed.dev/' })).not.toThrow();
		expect(() => assertAcceptanceTarget({ environment: 'prod', baseUrl: 'https://api.treeseed.dev/' })).not.toThrow();
	});

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

	it('keeps generated seed namespaces short enough for all acceptance actors', () => {
		const spec = loadSpec('test/acceptance/api.base.yaml');
		const longestEnvironment = 'staging';
		const longestRunNonce = `${'a'.repeat(8)}-${'b'.repeat(8)}`;
		const namespace = String(spec.seed.namespace)
			.replace('${environment}', longestEnvironment)
			.replace('${runNonce}', longestRunNonce);
		expect(namespace.length).toBeLessThanOrEqual(32);
	});

	it('adds service-authenticated email bypass headers only for hosted email bypass requests', () => {
		const previousId = process.env.TREESEED_ACCEPTANCE_SERVICE_ID;
		const previousSecret = process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET;
		process.env.TREESEED_ACCEPTANCE_SERVICE_ID = 'web';
		process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET = 'acceptance-secret';
		try {
			const localHeaders = addOptionalAcceptanceServiceHeaders(new Headers(), { environment: 'local', enabled: true });
			expect(localHeaders.get('x-treeseed-service-id')).toBeNull();
			const disabledHeaders = addOptionalAcceptanceServiceHeaders(new Headers(), { environment: 'staging', enabled: false });
			expect(disabledHeaders.get('x-treeseed-service-id')).toBeNull();
			const headers = addOptionalAcceptanceServiceHeaders(new Headers(), { environment: 'staging', enabled: true });
			expect(headers.get('x-treeseed-service-id')).toBe('web');
			expect(headers.get('x-treeseed-service-secret')).toBe('acceptance-secret');
			expect(headers.get('x-treeseed-acceptance-email-bypass')).toBe('1');
		} finally {
			if (previousId === undefined) delete process.env.TREESEED_ACCEPTANCE_SERVICE_ID;
			else process.env.TREESEED_ACCEPTANCE_SERVICE_ID = previousId;
			if (previousSecret === undefined) delete process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET;
			else process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET = previousSecret;
		}
	});

	it('enables hosted email bypass for generated SDK email methods only outside local runs', () => {
		expect(usesHostedAcceptanceEmailBypass({ sdkMethod: 'webSignUp' }, 'staging')).toBe(true);
		expect(usesHostedAcceptanceEmailBypass({ sdkMethod: 'requestWebPasswordReset' }, 'prod')).toBe(true);
		expect(usesHostedAcceptanceEmailBypass({ sdkMethod: 'addWebEmail' }, 'staging')).toBe(true);
		expect(usesHostedAcceptanceEmailBypass({ sdkMethod: 'me' }, 'staging')).toBe(false);
		expect(usesHostedAcceptanceEmailBypass({ sdkMethod: 'webSignUp' }, 'local')).toBe(false);
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

	it('includes the local acceptance web deployment flow in expansion', () => {
		const spec = loadSpec('test/acceptance/api.base.yaml');
		const flows = expandDeploymentFlows(spec);
		expect(flows).toHaveLength(1);
		expect(flows[0]).toMatchObject({
			id: 'deployment-flow.local-acceptance-web-deployment',
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
			path: '${apiVersionPath}/teams/${fixtures.team.id}/members/${fixtures.memberships.teamManagedMember.id}',
			body: { roleKey: 'contributor' },
		});
		expect(explicitCases.find((entry) => entry.id === 'teams.member-remove.team-owner')?.path).toBe('${apiVersionPath}/teams/${fixtures.team.id}/members/${fixtures.memberships.teamManagedMember.id}');
	});

	it('maps every active API guarantee verifier ref to an acceptance case', async () => {
		const { readdirSync, readFileSync, statSync } = await import('node:fs');
		const { join } = await import('node:path');
		const spec = loadSpec('test/acceptance/api.base.yaml');
		const caseIds = new Set([
			...((spec.cases ?? []) as Array<{ id?: string }>).map((entry) => entry.id).filter(Boolean),
			...expandDeploymentFlows(spec).map((entry) => entry.id).filter(Boolean),
			...expandRoleMatrices(spec).map((entry) => entry.id).filter(Boolean),
			...expandDescriptorMatrices(spec).map((entry) => entry.id).filter(Boolean),
			...expandSdkMethodMatrices(spec).map((entry) => entry.id).filter(Boolean),
		]);
		const verifierText = readFileSync('guarantees/verifiers/api.verifiers.yaml', 'utf8');
		const verifierCaseIds = new Map<string, string>();
		for (const block of verifierText.split(/\n(?=  api\.)/u)) {
			const ref = block.match(/^\s*(api\.[^:]+):/u)?.[1];
			const caseId = block.match(/caseId:\s*([^\s]+)/u)?.[1];
			if (ref && caseId) verifierCaseIds.set(ref, caseId);
		}
		const files: string[] = [];
		const walk = (directory: string) => {
			for (const entry of readdirSync(directory)) {
				const path = join(directory, entry);
				if (statSync(path).isDirectory()) walk(path);
				else if (path.endsWith('.guarantee.yaml')) files.push(path);
			}
		};
		walk('guarantees');
		const activeGuarantees = files
			.map((file) => ({ file, text: readFileSync(file, 'utf8') }))
			.filter((entry) => /status:\s*active/u.test(entry.text));
		expect(activeGuarantees.length).toBeGreaterThanOrEqual(30);
		const refs = new Set<string>();
		for (const entry of activeGuarantees) {
			for (const match of entry.text.matchAll(/verifierRefs:\s*\[([^\]]+)\]/gu)) {
				for (const ref of match[1].split(',').map((value) => value.trim()).filter(Boolean)) refs.add(ref);
			}
			for (const match of entry.text.matchAll(/verifierRefs:\s*\n((?:\s+-\s+api\.[A-Za-z0-9_.-]+\n?)+)/gu)) {
				for (const refMatch of match[1].matchAll(/-\s+(api\.[A-Za-z0-9_.-]+)/gu)) refs.add(refMatch[1]);
			}
		}
		expect(refs.size).toBeGreaterThanOrEqual(25);
		for (const ref of refs) {
			const caseId = verifierCaseIds.get(ref);
			expect(caseId, `${ref} is missing from api.verifiers.yaml`).toBeTruthy();
			expect(caseIds.has(caseId!), `${ref} references missing acceptance case ${caseId}`).toBe(true);
		}
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
		expect(expanded.cases.some((entry: any) => entry.id === 'deployment-flow.local-acceptance-web-deployment' && entry.deploymentFlow === true)).toBe(true);
		expect(expanded.cases.filter((entry: any) => entry.expect?.statusAny !== undefined).map((entry: any) => entry.id)).toEqual([
			'sdk.auditProjectHosts.teamOwner',
			'sdk.resyncProjectHost.teamOwner',
			'sdk.rotateProjectHost.teamOwner',
		]);
	});
});
