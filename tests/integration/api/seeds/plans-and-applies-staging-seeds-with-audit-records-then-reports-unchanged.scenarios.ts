import { resolve } from 'node:path';
import { authorizeApp,createTestApp,describe,expect,it,json,packageRoot } from '../../../support/api-harness.ts';

describe('control-plane API', () => {
it('plans and applies staging seeds with audit records, then reports unchanged', async () => {
		const app = createTestApp({ config: { repoRoot: resolve(packageRoot, 'tests/fixtures/seed-project') } });
		const token = await authorizeApp(app, { siteRoles: ['platform_admin'] });

		const unauthenticated = await app.request('/v1/seeds/treeseed/plan', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(unauthenticated.status).toBe(401);

		const teamResponse = await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ slug: 'treeseed', name: 'TreeSeed' }),
		});
		expect(teamResponse.status).toBe(200);
		const team = (await json(teamResponse)).payload;

		const planResponse = await app.request('/v1/seeds/treeseed/plan', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(planResponse.status).toBe(200);
		const plan = await json(planResponse);
		expect(plan.ok).toBe(true);
		expect(plan.summary.create).toBeGreaterThan(0);
		expect(plan.summary.update).toBeGreaterThan(0);
		expect(plan.summary.unchanged).toBe(0);
		expect(plan.run).toMatchObject({ state: 'completed', mode: 'plan', seedName: 'treeseed' });
		const selectedActionCount = plan.summary.create + plan.summary.update + plan.summary.unchanged;
		const mutationActionCount = plan.summary.create + plan.summary.update;

		const firstApplyResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(firstApplyResponse.status).toBe(200);
		const firstApply = await json(firstApplyResponse);
		expect(firstApply.ok).toBe(true);
		expect(firstApply.summary).toEqual(plan.summary);
		expect(firstApply.run).toMatchObject({ state: 'completed', mode: 'apply', seedName: 'treeseed' });
		expect(firstApply.result.actionCount).toBe(mutationActionCount);
		expect(firstApply.result).not.toHaveProperty('capacityProviderKeys');

		const resolvedResponse = await app.request('/v1/seeds/resources/resolve', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ keys: ['team:treeseed', 'project:treeseed/api'] }),
		});
		expect(resolvedResponse.status).toBe(200);
		const resolved = await json(resolvedResponse);
		expect(resolved.payload).toEqual([
			expect.objectContaining({ key: 'team:treeseed', kind: 'team', id: team.id }),
			expect.objectContaining({ key: 'project:treeseed/api', kind: 'project', teamId: team.id }),
		]);
		const staleResolution = await app.request('/v1/seeds/resources/resolve', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ keys: ['project:treeseed/missing'] }),
		});
		expect(staleResolution.status).toBe(409);

		const runs = await json(await app.request('/v1/seeds/runs', {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(JSON.stringify(runs)).not.toContain('tsp_');
		expect(runs.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				seedName: 'treeseed',
				mode: 'apply',
				state: 'completed',
			}),
		]));

		const secondApplyResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(secondApplyResponse.status).toBe(200);
		const secondApply = await json(secondApplyResponse);
		expect(secondApply.summary).toMatchObject({
			create: 0,
			update: 0,
			unchanged: selectedActionCount,
			skip: plan.summary.skip,
		});
		expect(secondApply.result.actionCount).toBe(0);
		expect(secondApply.result).not.toHaveProperty('capacityProviderKeys');

		const extensionApplyResponse = await app.request('/v1/seeds/extension/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(extensionApplyResponse.status).toBe(200);
		const extensionApply = await json(extensionApplyResponse);
		expect(extensionApply.summary).toMatchObject({ create: 1, update: 0, unchanged: 0 });
		const projectsResponse = await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(projectsResponse.status).toBe(200);
		const extension = (await json(projectsResponse)).data.projects.find((project: { slug?: string }) => project.slug === 'extension');
		expect(extension).toMatchObject({ slug: 'extension', name: 'TreeSeed Extension' });

		const extensionReplayResponse = await app.request('/v1/seeds/extension/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(extensionReplayResponse.status).toBe(200);
		expect((await json(extensionReplayResponse)).summary).toMatchObject({ create: 0, update: 0, unchanged: 1 });

		const exportResponse = await app.request(`/v1/teams/${team.id}/seeds/export`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ name: 'treeseed', environments: ['staging'], includeArtifacts: true }),
		});
		expect(exportResponse.status).toBe(200);
		const exported = await json(exportResponse);
		expect(exported.ok).toBe(true);
		expect(exported.yaml).not.toMatch(/encryptedPayload|BEGIN PRIVATE KEY|ghp_/u);
	});
});
