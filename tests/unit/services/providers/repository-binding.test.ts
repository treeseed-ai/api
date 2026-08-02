import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProjectsRepositoryTopologyRoutes } from '../../../../src/api/routes/projects/repositories/projects-repository-topology.ts';

const topology = {
	contentRepository: {
		accessMode: 'treedx', contentPath: 'docs/src/content',
		treeDx: { instanceId: 'node-1', libraryId: 'team/project', repositoryId: 'treedx-repository' },
		remote: {
			bindingId: 'binding-1', serviceConnectionId: 'connection-1', capabilityBindingId: 'capability-1',
			providerId: 'github', providerRepositoryId: 'spoofed', owner: 'example', name: 'knowledge',
			cloneUrl: 'https://credential@example.test/unsafe.git', defaultRef: 'refs/heads/main',
			publicationRef: 'refs/heads/staging', authorityId: 'authority-1', grantStatus: 'missing',
			drift: 'unknown', version: 1,
		},
	},
	siteRepository: { accessMode: 'filesystem', name: 'site' },
};

function appFor(store: any) {
	const app = new Hono();
	installProjectsRepositoryTopologyRoutes({ app, store,
		requireProjectAccess: async () => ({ principal: { id: 'user-1' }, details: { project: { id: 'project-1', teamId: 'team-1' } } }),
		jsonError: (c: any, status: number, message: string, detail: any = {}) => c.json({ ok: false, message, ...detail }, status),
	});
	return app;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('remote repository binding', () => {
	it('derives repository identity and remote head from the authorized provider read-back', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE', 'scoped-token');
		const store = {
			first: vi.fn(async () => ({ scheme: 'environment-reference', reference: 'TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE',
				capabilities_json: '["repository-hosting"]', credential_profile_id: 'github-repository-token' })),
			upsertProjectRepositoryTopology: vi.fn(async (_projectId: string, input: any) => input),
			recordAuditEvent: vi.fn(),
		};
		vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/git/ref/')
			? new Response(JSON.stringify({ object: { sha: 'a'.repeat(40) } }), { status: 200 })
			: new Response(JSON.stringify({ id: 987, name: 'knowledge', owner: { login: 'canonical-owner' },
				html_url: 'https://github.com/canonical-owner/knowledge', archived: false, disabled: false }), { status: 200 })));
		const response = await appFor(store).request('/v1/projects/project-1/repository-topology', {
			method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(topology),
		});
		expect(response.status).toBe(200);
		const saved = store.upsertProjectRepositoryTopology.mock.calls[0]?.[1].contentRepository.remote;
		expect(saved).toMatchObject({ providerRepositoryId: '987', owner: 'canonical-owner', name: 'knowledge',
			cloneUrl: 'https://github.com/canonical-owner/knowledge.git', expectedHead: 'a'.repeat(40),
			observedHead: 'a'.repeat(40), grantStatus: 'ready', drift: 'none' });
		expect(JSON.stringify(saved)).not.toContain('credential@');
	});

	it('does not persist a binding when provider verification fails', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE', 'scoped-token');
		const store = { first: vi.fn(async () => ({ scheme: 'environment-reference', reference: 'TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE',
			capabilities_json: '["repository-hosting"]' })), upsertProjectRepositoryTopology: vi.fn(), recordAuditEvent: vi.fn() };
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
		const response = await appFor(store).request('/v1/projects/project-1/repository-topology', {
			method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(topology),
		});
		expect(response.status).toBe(404);
		expect(store.upsertProjectRepositoryTopology).not.toHaveBeenCalled();
	});
});
