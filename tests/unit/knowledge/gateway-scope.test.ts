import { describe, expect, it } from 'vitest';
import { resolveKnowledgeGatewayConnection } from '../../../src/api/knowledge/gateway-treedx-connection.ts';

function tokenPayload(token: string) {
	return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

describe('knowledge gateway scope', () => {
	it('uses the configured content root and never substitutes a legacy directory', async () => {
		const base = {
			config: { TREESEED_TREEDX_JWT_HS256_SECRET: 'test-secret-at-least-thirty-two-bytes' },
			async getProjectTreeDxLibrary() {
				return {
					repositoryId: 'repo-one', contentPath: 'knowledge-models', contentRepositoryRef: 'refs/heads/main',
					topology: { contentRepository: { treeDx: { baseUrl: 'http://127.0.0.1:4000' } } },
				};
			},
		};
		const connection = await resolveKnowledgeGatewayConnection(base, { projectId: 'project-one', write: false, relationPaths: true });
		expect(connection?.contentPath).toBe('knowledge-models');
		expect(connection?.allowedPaths).toContain('knowledge-models/agents/**');
		expect(connection?.allowedPaths.join(' ')).not.toContain('src/content');

		await expect(resolveKnowledgeGatewayConnection({
			...base,
			async getProjectTreeDxLibrary() { return { ...(await base.getProjectTreeDxLibrary()), contentPath: '' }; },
		}, { projectId: 'project-one', write: false })).rejects.toThrow('content path is missing');
	});

	it('grants read-only graph access to an explicitly pinned source commit', async () => {
		const store = {
			config: { TREESEED_TREEDX_JWT_HS256_SECRET: 'test-secret-at-least-thirty-two-bytes' },
			async getProjectTreeDxLibrary() {
				return {
					repositoryId: 'repo-one', contentPath: 'docs/src/content', contentRepositoryRef: 'refs/heads/main',
					topology: { contentRepository: { treeDx: { baseUrl: 'http://127.0.0.1:4000' } } },
				};
			},
		};
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: 'project-one', write: false, readRefs: ['commit-exact'],
		});
		expect(connection).not.toBeNull();
		const payload = tokenPayload((connection?.client as any).options.token);
		expect(payload.treedx_refs).toEqual(expect.arrayContaining(['refs/heads/main', 'commit-exact']));
		expect(payload.treedx_capabilities).toEqual(expect.arrayContaining(['files:read', 'files:search', 'graph:query']));
		expect(payload.treedx_capabilities).not.toEqual(expect.arrayContaining(['files:write', 'graph:refresh', 'git:push']));
	});

	it('scopes writable authoring to the publication ref and exact workspace branch', async () => {
		const store = {
			config: { TREESEED_TREEDX_JWT_HS256_SECRET: 'test-secret-at-least-thirty-two-bytes' },
			async getProjectTreeDxLibrary() {
				return {
					repositoryId: 'repo-one', contentPath: 'docs/src/content', contentRepositoryRef: 'refs/heads/main',
					topology: { contentRepository: { treeDx: { baseUrl: 'http://127.0.0.1:4000' } } },
				};
			},
		};
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: 'project-one', write: true, workspaceRefs: ['refs/heads/knowledge/run-specific'],
		});
		const payload = tokenPayload((connection?.client as any).options.token);
		expect(payload.treedx_refs).toEqual(['refs/heads/main', 'refs/heads/staging', 'refs/heads/knowledge/run-specific']);
		expect(payload.treedx_refs).not.toContain('knowledge/*');
		expect(payload.treedx_refs).not.toContain('*');
		expect(payload.treedx_capabilities).toEqual(expect.arrayContaining([
			'workspace:create', 'files:search', 'files:write', 'files:delete', 'git:commit', 'graph:refresh',
		]));
	});

	it('authorizes every portable definition path queried by Agent Lab', async () => {
		const store = {
			config: { TREESEED_TREEDX_JWT_HS256_SECRET: 'test-secret-at-least-thirty-two-bytes' },
			async getProjectTreeDxLibrary() {
				return {
					repositoryId: 'repo-one', contentPath: 'docs/src/content', contentRepositoryRef: 'refs/heads/main',
					topology: { contentRepository: { treeDx: { baseUrl: 'http://127.0.0.1:4000' } } },
				};
			},
		};
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: 'project-one', write: true, authoringPaths: true,
		});
		const payload = tokenPayload((connection?.client as any).options.token);
		expect(connection?.allowedPaths).toEqual(expect.arrayContaining([
			'docs/src/content/agents/**', 'docs/src/content/agent-tests/**', '.treeseed/agents/**',
			'docs/src/content/agent-context-queries/**','docs/src/content/agent-context-query-sets/**',
			'docs/src/content/agent-instruction-templates/**','docs/src/content/agent-evaluations/**',
			'.treeseed/governance/proposal-types/**', 'seeds/**', 'scenes/**',
		]));
		expect(payload.treedx_refs).toEqual(expect.arrayContaining([
			'refs/heads/main', 'refs/heads/staging',
		]));
		const readOnly = await resolveKnowledgeGatewayConnection(store, {
			projectId: 'project-one', write: false, authoringPaths: true,
		});
		expect(tokenPayload((readOnly?.client as any).options.token).treedx_refs)
			.toEqual(expect.arrayContaining(['refs/heads/main','refs/heads/staging']));
	});

	it('grants communication work only the dedicated Discussion collections', async () => {
		const store = {
			config: { TREESEED_TREEDX_JWT_HS256_SECRET: 'test-secret-at-least-thirty-two-bytes' },
			async getProjectTreeDxLibrary() {
				return {
					repositoryId: 'repo-one', contentPath: 'docs/src/content', contentRepositoryRef: 'refs/heads/main',
					topology: { contentRepository: { treeDx: { baseUrl: 'http://127.0.0.1:4000' } } },
				};
			},
		};
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: 'project-one', write: true, communicationPaths: true,
		});
		expect(connection?.allowedPaths).toEqual(expect.arrayContaining([
			'docs/src/content/discussions/**',
			'docs/src/content/discussion-messages/**',
			'docs/src/content/discussion-events/**',
		]));
		expect(connection?.allowedPaths).not.toContain('docs/src/content/proposals/**');
	});

	it('grants fetch only to exact refs used by the publication runner', async () => {
		const store = {
			config: { TREESEED_TREEDX_JWT_HS256_SECRET: 'test-secret-at-least-thirty-two-bytes' },
			async getProjectTreeDxLibrary() {
				return {
					repositoryId: 'repo-one', contentPath: 'docs/src/content', contentRepositoryRef: 'refs/heads/main',
					topology: { contentRepository: { treeDx: { baseUrl: 'http://127.0.0.1:4000' } } },
				};
			},
		};
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: 'project-one', write: false, publishRefs: ['refs/heads/staging'],
		});
		const payload = tokenPayload((connection?.client as any).options.token);
		expect(payload.treedx_refs).toEqual(['refs/heads/main', 'refs/heads/staging']);
		expect(payload.treedx_capabilities).toEqual(expect.arrayContaining(['git:fetch', 'git:push', 'registry:read']));
		expect(payload.treedx_capabilities).not.toContain('files:write');
	});
});
