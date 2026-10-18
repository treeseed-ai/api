import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TreeDxClient } from '@treeseed/treedx/treedx/client';
import { createTreeDxOperations } from '../../../../../../src/api/control-plane/catalog/treedx/index.ts';
import { createTreeDxProxyOperationService } from '../../../../../../src/api/control-plane/repositories/treedx/proxy-operation-service.ts';
import { TreeDxDelegationAuthority } from '../../../../../../src/api/control-plane/treedx/delegation-authority.ts';
import { requireTreeDxOperation } from '../../../../../../src/api/control-plane/treedx/upstream-operation.ts';
import { CapacityRuntimeEvidenceRepository, type TreeDxProxyAuditWrite } from '../../../../../../src/api/capacity/repositories/runtime/runtime-evidence.ts';
import { cancellationDatabase } from '../../../providers/assignments/architecture/cancellation-fixture.ts';

const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native object response required.');
	return value as Record<string, unknown>;
};

// Real signed TreeDX engine, owning API catalog/service, original SQL audit and
// native Git CAS. Operator/project policy is a controlled input, not a claim of
// production authentication, reviewed content semantics, or assignment settlement.
describe('reviewed authoring ref promotion through public API and native TreeDX', () => {
	it('promotes only the exact two signed branch refs and preserves native denial stale concurrency and replay custody', async () => {
		const baseUrl = process.env.TREEDX_BASE_URL, token = process.env.TREEDX_TOKEN;
		if (!baseUrl || !token || !process.env.API_NATIVE_TREEDX_ROOT || !process.env.TREESEED_TREEDX_DELEGATION_PRIVATE_KEY) {
			throw new Error('The original disposable signed native TreeDX prerequisite is required.');
		}
		const native = new TreeDxClient({ baseUrl, token });
		const created = object(await native.repositories.create({ repositoryName: `reviewed-promotion-${randomUUID()}`, source: { type: 'empty' } }));
		const repoId = object(created.repo).repoId;
		if (typeof repoId !== 'string' || !repoId) throw new Error('Allocated native repository required.');
		const promotion = requireTreeDxOperation('promoteRepositoryRef');
		const promote = (client: TreeDxClient, body: Record<string, unknown>) => client.operation(promotion.method, promotion.path,
			{ pathParams: { repo_id: repoId }, body });
		const refs = async () => object(await native.repositories.refs(repoId)).refs as Array<{ name: string; target: string }>;
		const base = (await refs()).find(ref => ref.name === 'refs/heads/main')?.target;
		if (!base || !/^[a-f0-9]{40}$/u.test(base)) throw new Error('Exact initialized base required.');
		let workspaceId: string | undefined;
		const f = await cancellationDatabase();
		try {
			await promote(native, { sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/staging', expectedDestinationHead: base });
			const sourceRef = 'refs/heads/knowledge/reviewed', destinationRef = 'refs/heads/staging';
			const workspace = object(await native.workspaces.create(repoId, { mode: 'writable', baseRef: 'refs/heads/main', branchName: sourceRef, allowedPaths: ['docs/**'] }));
			if (typeof workspace.workspaceId !== 'string') throw new Error('Exact allocated authoring workspace required.');
			workspaceId = workspace.workspaceId;
			await native.files.write(workspaceId, { path: 'docs/proof.md', content: 'Reviewed native candidate\n', encoding: 'utf8' });
			const committed = object(await native.files.commit(workspaceId, { message: 'Retain exact reviewed fixture candidate', author: { name: 'Native fixture', email: 'native@example.invalid' } }));
			const candidate = committed.commitSha;
			if (typeof candidate !== 'string' || !/^[a-f0-9]{40}$/u.test(candidate)) throw new Error('Native committed candidate required.');
			await native.workspaces.close(workspaceId);
			const authority = new TreeDxDelegationAuthority(process.env);
			const evidence = new CapacityRuntimeEvidenceRepository(f.owner);
			const store = { ...f.owner,
				getProjectDetails: async (id: string) => id === 'project' ? { project: { id, teamId: 'team' } } : null,
				getProject: async (id: string) => ({ id, teamId: 'team' }),
				getProjectTreeDxLibrary: async () => ({ repositoryId: repoId, instanceId: 'isolated-native-connection' }),
				principalCanAccessTeam: async () => false, principalCanManageTeam: async () => false,
				recordTreeDxProxyAudit: (input: TreeDxProxyAuditWrite) => evidence.recordProxyAudit(input) };
			const service = createTreeDxProxyOperationService(store as never, { treeDxDelegationAuthority: authority,
				env: { ...process.env, TREESEED_ENVIRONMENT: 'test', TREESEED_TREEDX_URL: baseUrl,
					TREESEED_TREEDX_PROXY_ACTOR_ID: 'treeseed-api', TREESEED_TREEDX_PROXY_TENANT_ID: 'treeseed-control-plane' } });
			const operation = createTreeDxOperations({ treeDxProxy: service }).find(value => value.binding.descriptor.operationId === 'treedx.repositories.refs.promote');
			if (!operation) throw new Error('Original public promotion catalog entry required.');
			const input = { path: { projectId: 'project', repoId }, query: {}, body: { sourceRef, destinationRef, expectedDestinationHead: base } };
			const original = structuredClone(input), before = await f.snapshot();
			const context = { interface: 'rest' as const, requestId: 'native-reviewed-promotion', idempotencyKey: randomUUID(), principal: { id: 'isolated-operator', roles: ['admin'] } };
			const invoke = (value = input) => operation.handler(value, context);
			const narrowed = new TreeDxClient({ baseUrl, token: authority.mint({ actorId: 'treeseed-api', tenantId: 'treeseed-control-plane',
				projectId: 'project', connectionId: 'isolated-native-connection', scope: { repositoryIds: [repoId], capabilities: ['git:push'], refs: [sourceRef], paths: ['**'] } }).token });
			await expect(promote(narrowed, input.body)).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
			expect((await refs()).find(ref => ref.name === destinationRef)?.target).toBe(base);
			await expect(operation.handler(input, { ...context, principal: undefined })).rejects.toMatchObject({ status: 401 });
			await expect(invoke({ ...input, path: { ...input.path, repoId: 'foreign' } })).rejects.toMatchObject({ status: 403 });
			await expect(invoke({ ...input, body: { ...input.body, expectedDestinationHead: 'f'.repeat(40) } })).rejects.toMatchObject({ status: 409 });
			for (const result of [await invoke(), ...await Promise.all([invoke(), invoke()])]) {
				expect(result).toMatchObject({ result: { promotion: { afterHead: candidate, sourceRef, destinationRef } }, receipt: { projectId: 'project' } });
			}
			expect((await refs()).find(ref => ref.name === destinationRef)?.target).toBe(candidate);
			expect((await refs()).find(ref => ref.name === 'refs/heads/main')?.target).toBe(base);
			expect((await refs()).find(ref => ref.name === destinationRef)?.target).toBe(candidate);
			expect(await f.snapshot()).toEqual(before); expect(input).toEqual(original);
			const audit = await f.owner.all('SELECT project_id,actor_id,result_status FROM treedx_project_proxy_audit');
			expect(audit).toHaveLength(3);
			for (const row of audit) expect(row).toMatchObject({ project_id: 'project', actor_id: 'isolated-operator', result_status: 'proxied' });
		} finally {
			try { if (workspaceId) { await native.workspaces.close(workspaceId); expect(object(await native.workspaces.get(workspaceId)).status).toBe('closed'); } }
			finally { try { await native.repositories.retire(repoId); } finally { await f.db.close(); } }
		}
	});
});
