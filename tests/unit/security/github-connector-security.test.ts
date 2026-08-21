import { createHmac, generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGitHubConnectorRoutes } from '../../../src/api/routes/providers/github-connectors.ts';
import { assertWorkflowWebhookScope, installGitHubWebhookRoutes,reconcileRepositoryCheckRun,reconcileRepositoryPush } from '../../../src/api/routes/providers/github-webhooks.ts';
import { verifyGitHubInstallation } from '../../../src/api/routes/providers/github-connector-api.ts';
import { connectorStateHash, createConnectorState, readConnectorState } from '../../../src/security/github-connector-config.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const connectorEnv = {
	TREESEED_GITHUB_REPOSITORY_APP_ID: '1234',
	TREESEED_GITHUB_REPOSITORY_APP_CLIENT_ID: 'Iv1.client',
	TREESEED_GITHUB_REPOSITORY_APP_CLIENT_SECRET: 'client-secret-long-enough',
	TREESEED_GITHUB_REPOSITORY_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
	TREESEED_GITHUB_REPOSITORY_APP_WEBHOOK_SECRET: 'webhook-secret-long-enough',
	TREESEED_GITHUB_REPOSITORY_APP_SLUG: 'repository-connector',
	TREESEED_PROVIDER_CONNECTOR_BASE_URL: 'https://connect.example.test',
	TREESEED_PROVIDER_CONNECTOR_STATE_SECRET: 'state-secret-that-is-at-least-thirty-two-bytes',
};

function setConnectorEnvironment() {
	for (const [key, value] of Object.entries(connectorEnv)) vi.stubEnv(key, value);
}

function jsonError(c: any, status: number, message: string, detail: any = {}) {
	return c.json({ ok: false, message, ...detail }, status);
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('GitHub Connector security boundary', () => {
	it('signs callback state and rejects mutation or the wrong secret', () => {
		const state = createConnectorState({ authorizationId: 'auth-a', nonce: 'nonce-a' }, 'secret-a');
		expect(readConnectorState<any>(state, 'secret-a')?.authorizationId).toBe('auth-a');
		expect(readConnectorState(`${state}x`, 'secret-a')).toBeNull();
		expect(readConnectorState(state, 'secret-b')).toBeNull();
		expect(connectorStateHash(state)).toMatch(/^[a-f0-9]{64}$/u);
	});

	it('fails closed when an installation lacks a Connector minimum permission', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
			id: 42, app_id: 1234, suspended_at: null, repository_selection: 'selected',
			account: { id: 9, login: 'example' }, permissions: { contents: 'read' },
		}), { status: 200, headers: { 'content-type': 'application/json' } }));
		await expect(verifyGitHubInstallation({ appId: '1234', privateKey: connectorEnv.TREESEED_GITHUB_REPOSITORY_APP_PRIVATE_KEY,
			installationId: '42', requiredPermissions: { contents: 'write' }, fetchImpl: fetchImpl as typeof fetch }))
			.rejects.toThrow(/contents:write/u);
	});

	it('accepts workflow webhooks only for the exact repository, workflow, and source commit', () => {
		const run = { source_sha: 'a'.repeat(40) };
		const operation = { workflow_id: '.github/workflows/verify.yml' };
		const repository = { provider_repository_id: '77', owner: 'example', name: 'project' };
		const payload = { repository: { id: 77, full_name: 'example/project' }, workflow_run: {
			event: 'workflow_dispatch', head_sha: run.source_sha, path: '.github/workflows/verify.yml@refs/heads/main',
		} };
		expect(() => assertWorkflowWebhookScope(payload, run, operation, repository)).not.toThrow();
		expect(() => assertWorkflowWebhookScope({ ...payload, workflow_run: {
			...payload.workflow_run, head_sha: 'b'.repeat(40),
		} }, run, operation, repository)).toThrow(/authorized run scope/u);
		expect(() => assertWorkflowWebhookScope({ ...payload, repository: { id: 78, full_name: 'other/project' } },
			run, operation, repository)).toThrow(/authorized run scope/u);
	});

	it('waits for and re-reads a successful exact staging check before fetching a repository profile',async()=>{
		vi.stubEnv('TREESEED_GITHUB_TOKEN_PROFILE_TEST','token-not-exposed');
		const exactCommit='c'.repeat(40);
		const fetchImpl=vi.fn(async(url:string|URL|Request)=>{
			const href=String(url);
			if(href.includes('/check-runs/')) return Response.json({id:91,name:'verify',status:'completed',conclusion:'success',head_sha:exactCommit,check_suite:{head_branch:'staging'},app:{slug:'github-actions'}});
			if(href.includes('/git/ref/heads/staging')) return Response.json({ref:'refs/heads/staging',object:{sha:exactCommit}});
			return new Response('',{status:404});
		});
		vi.stubGlobal('fetch',fetchImpl);
		const store={first:vi.fn(async(query:string)=>query.includes('LOWER(owner)')
			?{id:'binding-a',team_id:'team-a',project_id:'project-sdk',provider_repository_id:'77',owner:'treeseed-ai',name:'sdk',publication_ref:'staging',authority_id:'authority-a'}
			:{id:'authority-a',team_id:'team-a',connection_id:'connection-a',provider_id:'github',authority_id:'authority-a',credential_profile_id:'github-repository-token',scheme:'environment-reference',reference:'TREESEED_GITHUB_TOKEN_PROFILE_TEST',capabilities_json:'["repository-hosting"]',non_secret_config_json:'{}'})};
		await expect(reconcileRepositoryPush(store,{ref:'refs/heads/staging',after:exactCommit,repository:{id:77,full_name:'treeseed-ai/sdk'}})).resolves.toEqual({repository:'treeseed-ai/sdk',observedCommit:exactCommit,status:'awaiting-required-check'});
		expect(fetchImpl).not.toHaveBeenCalled();
		await expect(reconcileRepositoryPush(store,{ref:'refs/heads/main',after:exactCommit,repository:{id:77,full_name:'treeseed-ai/sdk'}})).resolves.toBeNull();
		await expect(reconcileRepositoryCheckRun(store,{repository:{id:77,full_name:'treeseed-ai/sdk'},check_run:{id:91}})).resolves.toEqual({repository:'treeseed-ai/sdk',observedCommit:exactCommit,status:'no-profile'});
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(fetchImpl).toHaveBeenNthCalledWith(3,expect.stringContaining(`ref=${exactCommit}`),expect.objectContaining({headers:expect.objectContaining({authorization:'Bearer token-not-exposed'})}));

		fetchImpl.mockImplementation(async(url:string|URL|Request)=>String(url).includes('/check-runs/')
			?Response.json({id:91,name:'verify',status:'completed',conclusion:'success',head_sha:exactCommit,check_suite:{head_branch:'staging'},app:{slug:'github-actions'}})
			:Response.json({ref:'refs/heads/staging',object:{sha:'d'.repeat(40)}}));
		await expect(reconcileRepositoryCheckRun(store,{repository:{id:77,full_name:'treeseed-ai/sdk'},check_run:{id:91}})).resolves.toEqual({repository:'treeseed-ai/sdk',observedCommit:exactCommit,status:'stale-required-check'});
	});

	it('starts setup only for an authorized GitHub service connection and persists no secret', async () => {
		setConnectorEnvironment();
		const statements: Array<{ sql: string; params: unknown[] }> = [];
		const app = new Hono();
		installGitHubConnectorRoutes({ app, jsonError,
			requireTeamAccess: async () => ({ principal: { id: 'user-a' } }),
			store: {
				getTeamServiceConnection: async () => ({ id: 'connection-a', providerId: 'github' }),
				run: async (sql: string, params: unknown[]) => { statements.push({ sql, params }); },
			},
		});
		const response = await app.request('/v1/provider-connectors/github/repository/setup', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ teamId: 'team-a', connectionId: 'connection-a' }),
		});
		expect(response.status).toBe(200);
		const payload: any = await response.json();
		expect(payload.payload.redirect).toContain('github.com/apps/repository-connector/installations/new');
		expect(statements).toHaveLength(1);
		const persisted = JSON.stringify(statements);
		expect(persisted).not.toContain(connectorEnv.TREESEED_PROVIDER_CONNECTOR_STATE_SECRET);
		expect(persisted).not.toContain(connectorEnv.TREESEED_GITHUB_REPOSITORY_APP_PRIVATE_KEY.slice(30, 80));
	});

	it('rejects unsigned webhooks before parsing or persistence and ignores an authenticated replay', async () => {
		setConnectorEnvironment();
		const app = new Hono();
		const store = { first: vi.fn(async () => ({ id: 'existing-delivery' })), run: vi.fn() };
		installGitHubWebhookRoutes({ app, store, jsonError });
		const headers = { 'content-type': 'application/json', 'x-github-delivery': 'delivery-a',
			'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=deadbeef' };
		const invalid = await app.request('/v1/provider-webhooks/github/repository', { method: 'POST', headers, body: '{}' });
		expect(invalid.status).toBe(401);
		expect(store.first).not.toHaveBeenCalled();
		const signed = `sha256=${createHmac('sha256', connectorEnv.TREESEED_GITHUB_REPOSITORY_APP_WEBHOOK_SECRET).update('{}').digest('hex')}`;
		const replay = await app.request('/v1/provider-webhooks/github/repository', {
			method: 'POST', headers: { ...headers, 'x-hub-signature-256': signed }, body: '{}',
		});
		expect(replay.status).toBe(200);
		expect((await replay.json() as any).code).toBe('webhook_replay_ignored');
		expect(store.run).not.toHaveBeenCalled();
	});

	it.each(['suspend', 'deleted'])('immediately invalidates a %s installation without trusting a provider read-back', async (action) => {
		setConnectorEnvironment();
		const body = JSON.stringify({ action, installation: { id: 42 } });
		const signature = `sha256=${createHmac('sha256', connectorEnv.TREESEED_GITHUB_REPOSITORY_APP_WEBHOOK_SECRET).update(body).digest('hex')}`;
		const statements: Array<{ sql: string; params: unknown[] }> = [];
		const store = {
			first: vi.fn(async () => null),
			all: vi.fn(async () => [{ id: 'authority-a', connection_id: 'connection-a', team_id: 'team-a',
				non_secret_config_json: JSON.stringify({ githubConnectors: { repository: { installationId: '42' } } }) }]),
			run: vi.fn(async (sql: string, params: unknown[]) => { statements.push({ sql, params }); }),
			recordAuditEvent: vi.fn(async () => undefined),
		};
		const app = new Hono();
		installGitHubWebhookRoutes({ app, store, jsonError });
		const response = await app.request('/v1/provider-webhooks/github/repository', { method: 'POST', body,
			headers: { 'content-type': 'application/json', 'x-github-delivery': `delivery-${action}`,
				'x-github-event': 'installation', 'x-hub-signature-256': signature } });
		expect(response.status).toBe(200);
		expect(statements.some((entry) => entry.sql.includes("status = 'reauthorization-required'")
			&& entry.sql.includes('provider_credential_authorities'))).toBe(true);
		expect(statements.some((entry) => entry.sql.includes("grant_status = 'reauthorization-required'")
			&& entry.sql.includes('project_remote_repository_bindings'))).toBe(true);
		expect(store.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
			eventType: 'provider.connector.authorization_lost', targetId: 'connection-a',
		}));
	});
});
