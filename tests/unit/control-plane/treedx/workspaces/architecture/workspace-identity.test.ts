import { describe, expect, it } from 'vitest';
import { verifyTreeDxWorkspace } from '../../../../../../src/api/capacity/services/treedx/repositories/treedx-proxy-token-service.ts';

const workspaceId = 'ws_terminalfixture', library = { repositoryId: 'repository' };
const runtime = (body: unknown, status = 200) => ({ env: { TREESEED_ENVIRONMENT: 'test', TREESEED_TREEDX_URL: 'http://127.0.0.1:4000' },
	fetchImpl: async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) });
// UNIT: supplied fetch replies. Scope verification is not a closure assertion;
// legitimate OPEN workspace reads must remain available and report their status.
describe('exact workspace response identity at the owning proxy verifier', () => {
	it('retains exact open and closed resource reads without mutating the requested project binding', async () => {
		const before = structuredClone(library);
		for (const status of ['open', 'closed']) await expect(verifyTreeDxWorkspace({ runtime: runtime({ workspaceId,
			repoId: library.repositoryId, status }), projectId: 'project', library, workspaceId })).resolves.toBeUndefined();
		expect(library).toEqual(before);
	});
	it('denies missing foreign or malformed workspace identity even when the repository matches', async () => {
		const values = [undefined, 'ws_foreignresource', null, 1, ''];
		const admitted: number[] = [];
		for (const [index, id] of values.entries()) {
			try { await verifyTreeDxWorkspace({ runtime: runtime({ workspaceId: id, repoId: library.repositoryId, status: 'closed' }),
				projectId: 'project', library, workspaceId }); admitted.push(index); } catch { /* exact identity denied */ }
		}
		expect(admitted).toEqual([]);
	});
	it('retains foreign-repository and denied-upstream controls without exposing raw upstream text', async () => {
		await expect(verifyTreeDxWorkspace({ runtime: runtime({ workspaceId, repoId: 'foreign', status: 'closed' }),
			projectId: 'project', library, workspaceId })).rejects.toMatchObject({ status: 403, code: 'treedx_workspace_project_mismatch' });
		await expect(verifyTreeDxWorkspace({ runtime: runtime({ error: { code: 'permission_denied', message: 'private fixture detail' } }, 403),
			projectId: 'project', library, workspaceId })).rejects.toMatchObject({ status: 503, code: 'treedx_workspace_verification_failed',
			details: { upstream: { status: 403, code: 'permission_denied' } } });
	});
});
