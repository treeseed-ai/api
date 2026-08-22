import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubConnectorService } from '../../../src/api/control-plane/repositories/github-connector-service.ts';
import { createGitHubWebhookService } from '../../../src/api/control-plane/repositories/github-webhook-service.ts';
import { connectorStateHash, createConnectorState, readConnectorState } from '../../../src/security/github-connector-config.ts';

const environment = {
	TREESEED_GITHUB_REPOSITORY_APP_ID: '1234', TREESEED_GITHUB_REPOSITORY_APP_CLIENT_ID: 'client-id',
	TREESEED_GITHUB_REPOSITORY_APP_CLIENT_SECRET: 'client-secret', TREESEED_GITHUB_REPOSITORY_APP_PRIVATE_KEY: 'private-key',
	TREESEED_GITHUB_REPOSITORY_APP_WEBHOOK_SECRET: 'webhook-secret', TREESEED_GITHUB_REPOSITORY_APP_SLUG: 'repository-connector',
	TREESEED_PROVIDER_CONNECTOR_BASE_URL: 'https://connect.example.test', TREESEED_PROVIDER_CONNECTOR_STATE_SECRET: 'state-secret',
};

function configure() { for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value); }
afterEach(() => vi.unstubAllEnvs());

describe('GitHub provider catalog services', () => {
	it('starts setup without persisting connector secrets', async () => {
		configure(); const statements: Array<{ sql: string; parameters: unknown[] }> = [];
		const store = { principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['services:manage:team'] })),
			getTeamServiceConnection: vi.fn(async () => ({ providerId: 'github' })),
			run: vi.fn(async (sql: string, parameters: unknown[]) => { statements.push({ sql, parameters }); }) };
		const result = await createGitHubConnectorService(store).setup({ id: 'user-1' }, 'repository',
			{ teamId: 'team-1', connectionId: 'connection-1' });
		expect(result.redirect).toContain('github.com/apps/repository-connector/installations/new');
		expect(statements).toHaveLength(1);
		expect(JSON.stringify(statements)).not.toContain(environment.TREESEED_GITHUB_REPOSITORY_APP_WEBHOOK_SECRET);
		expect(JSON.stringify(statements)).not.toContain(environment.TREESEED_GITHUB_REPOSITORY_APP_PRIVATE_KEY);
	});

	it('verifies exact raw webhook bytes before replay lookup', async () => {
		configure(); const store = { first: vi.fn(async () => ({ id: 'existing-delivery' })), run: vi.fn() };
		const webhook = createGitHubWebhookService(store); const body = '{}';
		await expect(webhook('repository', {}, body, { 'content-type': 'application/json', 'x-github-delivery': 'delivery-1',
			'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=deadbeef' })).rejects.toMatchObject({
			status: 401, code: 'webhook_signature_invalid',
		});
		expect(store.first).not.toHaveBeenCalled();
		const signature = `sha256=${createHmac('sha256', environment.TREESEED_GITHUB_REPOSITORY_APP_WEBHOOK_SECRET).update(body).digest('hex')}`;
		await expect(webhook('repository', {}, body, { 'content-type': 'application/json', 'x-github-delivery': 'delivery-1',
			'x-github-event': 'ping', 'x-hub-signature-256': signature })).resolves.toEqual({ code: 'webhook_replay_ignored' });
		expect(store.run).not.toHaveBeenCalled();
	});

	it('rejects modified callback state', () => {
		const state = createConnectorState({ authorizationId: 'authorization-1' }, 'secret-1');
		expect(readConnectorState<any>(state, 'secret-1')?.authorizationId).toBe('authorization-1');
		expect(readConnectorState(`${state}x`, 'secret-1')).toBeNull();
		expect(connectorStateHash(state)).toMatch(/^[a-f0-9]{64}$/u);
	});
});
