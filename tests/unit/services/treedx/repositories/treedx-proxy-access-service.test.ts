import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
import { authorizeTreeDxProxy } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-proxy-access-service.ts';
import { treeDxTokenScope } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-proxy-token-service.ts';
import type { CapacityProviderAccessEnv } from '../../../../../src/api/capacity/provider-access-middleware.ts';

function app(store: Record<string, unknown>) {
	const application = new Hono<CapacityProviderAccessEnv>();
	application.use('*', async (c, next) => {
		c.set('capacityProviderAccessAuth', { principal: { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a', scopes: ['provider:assignments:read'] } });
		await next();
	});
	application.onError((error, c) => c.json({ ok: false, error: error.message }, { status: 500 }));
	application.get('/v1/dx/projects/:projectId/workspaces/:workspaceId/files', async (c) => {
		try {
			await authorizeTreeDxProxy({ c, store: store as never, projectId: c.req.param('projectId'), permission: 'projects:read:team', scope: treeDxTokenScope({ repoId: 'repo-a', capabilities: ['files:read'], paths: ['docs/a.md'] }), requireProjectAccess: async () => ({}) });
			return c.json({ ok: true });
		} catch (error: any) {
			if (error?.status) return c.json({ ok: false, code: error.code }, { status: error.status as ContentfulStatusCode });
			throw error;
		}
	});
	return application;
}

describe('assignment-scoped TreeDX proxy access', () => {
	it('accepts an active provider-owned lease and durable scoped handle', async () => {
		const response = await app({
			async getProjectDetails() { return { project: { id: 'project-a', teamId: 'team-a' } }; },
			async getProviderAssignment() { return { id: 'assignment-a', projectId: 'project-a', capacityProviderId: 'provider-a', leaseState: 'leased', leaseExpiresAt: '2099-01-01T00:00:00.000Z' }; },
			async getTreeDxProxyHandle() { return { id: 'handle-a', teamId: 'team-a', projectId: 'project-a', assignmentId: 'assignment-a', repositoryId: 'repo-a', workspaceId: 'workspace-a', scopes: ['files:read'], allowedOperations: ['files:read'], allowedReadPaths: ['docs/**'], status: 'active' }; },
			async recordTreeDxProxyAudit() {},
		}).request('/v1/dx/projects/project-a/workspaces/workspace-a/files?path=docs/a.md&assignmentId=assignment-a&treeDxProxyHandleId=handle-a');
		expect(response.status).toBe(200);
	});

	it('denies and audits a missing durable handle without dereferencing null', async () => {
		const audits: Record<string, unknown>[] = [];
		const response = await app({
			async getProjectDetails() { return { project: { id: 'project-a', teamId: 'team-a' } }; },
			async getProviderAssignment() { return { id: 'assignment-a', projectId: 'project-a', capacityProviderId: 'provider-a', leaseState: 'leased', leaseExpiresAt: '2099-01-01T00:00:00.000Z' }; },
			async getTreeDxProxyHandle() { return null; },
			async recordTreeDxProxyAudit(input: Record<string, unknown>) { audits.push(input); },
		}).request('/v1/dx/projects/project-a/workspaces/workspace-a/files?path=docs/a.md&assignmentId=assignment-a&treeDxProxyHandleId=handle-a');
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: 'treedx_proxy_scope_mismatch' });
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ resultStatus: 'denied', reasonCode: 'treedx_proxy_scope_mismatch' });
	});

	it('fails closed when required denial evidence cannot be persisted', async () => {
		const response = await app({
			async getProjectDetails() { return { project: { id: 'project-a', teamId: 'team-a' } }; },
			async recordTreeDxProxyAudit() { throw new Error('audit unavailable'); },
		}).request('/v1/dx/projects/project-a/workspaces/workspace-a/files?path=docs/a.md');
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: 'audit unavailable' });
	});
});
