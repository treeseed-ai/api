import { describe, expect, it } from 'vitest';
import { createTreeDxOperations } from '../../../../../../src/api/control-plane/catalog/treedx/index.ts';
import { createTreeDxProxyOperationService } from '../../../../../../src/api/control-plane/repositories/treedx/proxy-operation-service.ts';
import { CapacityRuntimeEvidenceRepository, type TreeDxProxyAuditWrite } from '../../../../../../src/api/capacity/repositories/runtime/runtime-evidence.ts';
import type { OperationInvocationContext } from '../../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { workspaceCleanupFixture, workspaceId } from '../../../providers/assignments/architecture/workspace-cleanup-fixture.ts';

// REAL owning catalog/service, official TreeDX client, native HTTP and original
// PGlite DDL. The resource and admin principal are isolated inputs, NOT an actual
// TreeDX server, authenticated operator, independent project policy or physical
// sandbox/provider-session closure. Read audit writes are expected; finance is not.
async function readbackFixture() {
	const fixture = await workspaceCleanupFixture('revoked');
	const evidence = new CapacityRuntimeEvidenceRepository(fixture.owner);
	const project = async (id: string) => {
		const row = await fixture.owner.first<{ project_id: string; team_id: string }>(
			'SELECT project_id,team_id FROM capacity_provider_assignments WHERE project_id=? LIMIT 1', [id]);
		return row ? { id: row.project_id, teamId: row.team_id } : null;
	};
	const store = { ...fixture.owner,
		getProjectDetails: async (id: string) => { const value = await project(id); return value ? { project: value } : null; },
		getProject: project,
		recordTreeDxProxyAudit: (input: TreeDxProxyAuditWrite) => evidence.recordProxyAudit(input) };
	const service = createTreeDxProxyOperationService(store, { env: { TREESEED_ENVIRONMENT: 'test', TREESEED_TREEDX_URL: fixture.baseUrl } });
	const operations = createTreeDxOperations({ treeDxProxy: service }).filter(value => value.binding.descriptor.operationId === 'treedx.workspaces.show');
	if (operations.length !== 1) { await fixture.close(); throw new Error('Missing exact owning workspace read operation'); }
	const input = { path: { projectId: 'project', workspaceId }, query: {}, body: undefined };
	const context: OperationInvocationContext = { interface: 'cli', requestId: 'isolated-workspace-read', principal: { id: 'isolated-operator', roles: ['admin'] } };
	return { ...fixture, input, context, read: (authority = context) => operations[0]!.handler(input, authority) };
}

describe('public workspace resource readback through the owning SQL and native transport', () => {
	it('denies a changed native workspace identity after successful verification before any success audit or receipt and admits only the unchanged exact retry', async () => {
		const fixture = await readbackFixture();
		try {
			const before = await fixture.snapshot(), input = structuredClone(fixture.input);
			const valid = { workspaceId, repoId: 'repository', status: 'open' };
			for (const changed of [{ ...valid, workspaceId: 'ws_foreignresource' }, { repoId: 'repository', status: 'open' },
				{ ...valid, repoId: 'foreign' }]) {
				const sequence = [valid, changed], preserved = structuredClone(sequence);
				fixture.setReadSequence(sequence);
				await expect(fixture.read()).rejects.toMatchObject({ status: changed.repoId === 'foreign' ? 403 : 409,
					code: changed.repoId === 'foreign' ? 'treedx_workspace_project_mismatch' : 'treedx_workspace_identity_mismatch' });
				expect(await fixture.snapshot()).toEqual(before); expect(await fixture.owner.all('SELECT id FROM treedx_project_proxy_audit')).toEqual([]);
				expect(fixture.input).toEqual(input); expect(sequence).toEqual(preserved);
			}
			expect(fixture.requests).toHaveLength(6);
			fixture.setReadSequence([valid, valid]);
			await expect(fixture.read()).resolves.toMatchObject({ result: valid, receipt: { projectId: 'project' } });
			expect(await fixture.snapshot()).toEqual(before); expect(fixture.input).toEqual(input);
			expect(await fixture.owner.all('SELECT result_status FROM treedx_project_proxy_audit')).toEqual([{ result_status: 'proxied' }]);
		} finally { await fixture.close(); }
	});
	it('reads exact open and closed resources repeatedly and concurrently without changing assignment finance', async () => {
		const fixture = await readbackFixture();
		try {
			const before = await fixture.snapshot(), input = structuredClone(fixture.input);
			for (const status of ['open', 'closed']) {
				fixture.setReadResponse({ workspaceId, repoId: 'repository', status });
				const values = [await fixture.read(), ...await Promise.all([fixture.read(), fixture.read()])];
				for (const value of values) expect(value).toMatchObject({ result: { workspaceId, repoId: 'repository', status }, receipt: { projectId: 'project' } });
			}
			expect(await fixture.snapshot()).toEqual(before); expect(fixture.input).toEqual(input);
			const audit = await fixture.owner.all('SELECT project_id,actor_id,result_status FROM treedx_project_proxy_audit');
			expect(audit).toHaveLength(6);
			for (const row of audit) expect(row).toMatchObject({ project_id: 'project', actor_id: 'isolated-operator', result_status: 'proxied' });
			expect(fixture.requests).toHaveLength(12);
			expect(fixture.requests.every(route => route === `GET /api/v1/workspaces/${workspaceId}`)).toBe(true);
		} finally { await fixture.close(); }
	});
	it('denies foreign and missing workspace identities rather than returning foreign authority with a success receipt', async () => {
		const fixture = await readbackFixture();
		try {
			const before = await fixture.snapshot(), input = structuredClone(fixture.input), admitted: unknown[] = [];
			for (const id of ['ws_foreignresource', undefined, null, 1, '']) {
				fixture.setReadResponse({ workspaceId: id, repoId: 'repository', status: 'closed' });
				await expect(fixture.read()).rejects.toMatchObject({ status: 409, code: 'treedx_workspace_identity_mismatch' });
				try { admitted.push(await fixture.read()); } catch { /* exact resource authority denied */ }
			}
			expect(await fixture.snapshot()).toEqual(before); expect(fixture.input).toEqual(input);
			expect(admitted).toEqual([]);
			expect(await fixture.owner.all('SELECT id FROM treedx_project_proxy_audit')).toEqual([]);
		} finally { await fixture.close(); }
	});
	it('denies missing principal binding and foreign repository before publishing a successful workspace receipt', async () => {
		const fixture = await readbackFixture();
		try {
			const before = await fixture.snapshot();
			await expect(fixture.read({ ...fixture.context, principal: undefined })).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
			expect(fixture.requests).toHaveLength(0);
			fixture.setBound(false);
			await expect(fixture.read()).rejects.toMatchObject({ status: 503, code: 'treedx_binding_unavailable' });
			expect(fixture.requests).toHaveLength(0);
			fixture.setBound(true); fixture.setReadResponse({ workspaceId, repoId: 'foreign', status: 'closed' });
			await expect(fixture.read()).rejects.toMatchObject({ status: 403, code: 'treedx_workspace_project_mismatch' });
			expect(await fixture.snapshot()).toEqual(before);
			expect(await fixture.owner.all('SELECT id FROM treedx_project_proxy_audit')).toEqual([]);
		} finally { await fixture.close(); }
	});
});
