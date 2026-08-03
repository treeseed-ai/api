import { describe, expect, it } from 'vitest';
import { resolveKnowledgeGatewayConnection } from '../../../src/api/knowledge/gateway-treedx-connection.ts';

function tokenPayload(token: string) {
	return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

describe('knowledge gateway scope', () => {
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
		expect(payload.treedx_refs).toEqual(['refs/heads/main', 'refs/heads/knowledge/run-specific']);
		expect(payload.treedx_refs).not.toContain('knowledge/*');
		expect(payload.treedx_refs).not.toContain('*');
		expect(payload.treedx_capabilities).toEqual(expect.arrayContaining([
			'workspace:create', 'files:write', 'files:delete', 'git:commit',
		]));
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
		expect(payload.treedx_capabilities).toEqual(expect.arrayContaining(['git:fetch', 'git:push']));
		expect(payload.treedx_capabilities).not.toContain('files:write');
	});
});
