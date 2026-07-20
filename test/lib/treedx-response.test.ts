import { describe, expect, it } from 'vitest';
import { verifyTreeDxWorkspace } from '../../src/api/capacity/services/treedx-proxy-token-service.ts';
import { MAX_TREEDX_RESPONSE_BYTES, readBoundedTreeDxJson } from '../../src/api/capacity/services/treedx-response.ts';

describe('bounded TreeDX responses', () => {
	it('rejects oversized declared responses before reading them', async () => {
		await expect(readBoundedTreeDxJson(new Response('{}', { headers: { 'content-length': String(MAX_TREEDX_RESPONSE_BYTES + 1) } }))).rejects.toMatchObject({ code: 'treedx_response_too_large' });
	});

	it('rejects malformed JSON with a stable error', async () => {
		await expect(readBoundedTreeDxJson(new Response('{'))).rejects.toMatchObject({ code: 'treedx_response_invalid' });
	});

	it('bounds workspace verification responses with a workspace-specific error', async () => {
		await expect(verifyTreeDxWorkspace({
			runtime: { env: {
				TREESEED_TREEDX_JWT_AUDIENCE: 'treedx-test',
				TREESEED_TREEDX_JWT_HS256_SECRET: 'test-secret-that-is-long-enough-for-hs256',
				TREESEED_TREEDX_JWT_ISSUER: 'https://api.treeseed.test/treedx',
			} },
			projectId: 'project-1',
			library: { repositoryId: 'repository-1' },
			workspaceId: 'workspace-1',
			fetchImpl: async () => new Response('{}', {
				headers: { 'content-length': String(MAX_TREEDX_RESPONSE_BYTES + 1) },
			}),
		})).rejects.toMatchObject({ code: 'treedx_workspace_response_too_large' });
	});
});
