import { resolve } from 'node:path';
import { runOnceWithClient } from '../../../../src/operations-runner/entrypoint.ts';
import { authorizeApp,ControlPlaneRunnerClient,createTestApp,describe,expect,it,json,withHttpControlPlaneApp } from '../../../support/api-harness.ts';

import { packageRoot } from '../../../support/api-harness.ts';

describe('control-plane API', () => {
it('lets the Treeseed operations runner complete a queued noop operation through API service auth', async () => {
		const app = createTestApp({
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const created = await json(await app.request('/v1/platform/operations', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'control-plane',
				operation: 'noop',
				input: { source: 'runner-integration-test' },
			}),
		}));
		await withHttpControlPlaneApp(app, async (baseUrl) => {
			const client = new ControlPlaneRunnerClient({
				serverUrl: baseUrl,
				serverId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-test-1',
				environment: 'local',
				dataDir: resolve(packageRoot, '.treeseed/test-treeseed-ops'),
			}, client, 'test');
			expect(result).toMatchObject({ ok: true, claimed: true });
		});
		const completed = await json(await app.request(`/v1/platform/operations/${created.operation.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(completed.operation).toMatchObject({
			status: 'succeeded',
			terminal: true,
			output: {
				ok: true,
				message: 'Treeseed operations runner diagnostic completed.',
			},
		});
	});
});
