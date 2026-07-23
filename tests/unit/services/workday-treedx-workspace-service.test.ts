import { describe, expect, it, vi } from 'vitest';
import {
	createConfiguredWorkdayTreeDxWorkspace,
	createWorkdayTreeDxWorkspace,
	workdayTreeDxWorkspaceId,
} from '../../../src/api/capacity/services/workday-treedx-workspace-service.ts';

describe('workday TreeDX workspace service', () => {
	it('uses one deterministic workspace identity for assignment replays', async () => {
		const assignmentId = 'workday-run-project-cycle-1-architect';
		const workspaceId = workdayTreeDxWorkspaceId(assignmentId);
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ ...body, status: 'ready' }), { status: 200 });
		});
		const fetchImpl = fetchMock as unknown as typeof fetch;
		const input = {
			baseUrl: 'https://treedx.example.test',
			token: 'brokered-token',
			repositoryId: 'repo-1',
			assignmentId,
			baseRef: 'refs/heads/main',
			branchName: `refs/heads/${assignmentId}`,
			mode: 'writable' as const,
			allowedPaths: ['**'],
			ttlSeconds: 1800,
			fetchImpl,
		};

		await expect(createWorkdayTreeDxWorkspace(input)).resolves.toMatchObject({ workspaceId });
		await expect(createWorkdayTreeDxWorkspace(input)).resolves.toMatchObject({ workspaceId });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const call of fetchMock.mock.calls) {
			expect(JSON.parse(String(call[1]?.body))).toMatchObject({ workspaceId });
		}
	});

	it('owns configured repository resolution and mints assignment-workday-scoped access', async () => {
		const assignmentId = 'assignment-configured-1';
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const authorization = String(new Headers(init?.headers).get('authorization'));
			const payload = JSON.parse(Buffer.from(authorization.slice('Bearer '.length).split('.')[1], 'base64url').toString('utf8'));
			expect(payload).toMatchObject({
				treeseed_project_id: 'project-1',
				treeseed_capacity_workday_run_id: 'workday-run-1',
				treedx_repo_ids: ['repository-1'],
			});
			return new Response(JSON.stringify({ workspaceId: workdayTreeDxWorkspaceId(assignmentId) }), { status: 200 });
		}) as unknown as typeof fetch;
		await expect(createConfiguredWorkdayTreeDxWorkspace({
			config: {
				TREESEED_TREEDX_JWT_HS256_SECRET: 'configured-workspace-test-secret',
				TREESEED_TREEDX_URL: 'https://treedx.example.test',
				fetchImpl,
			},
			getProjectTreeDxLibrary: async () => ({ repositoryId: 'repository-1' }),
		}, { id: 'project-1' }, { id: 'workday-run-1' }, {
			assignmentId,
			branchName: 'refs/heads/assignment-configured-1',
			allowedPaths: ['src/**'],
			ttlSeconds: 1800,
		})).resolves.toMatchObject({ workspaceId: workdayTreeDxWorkspaceId(assignmentId) });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it('fails closed when TreeDX returns a different workspace', async () => {
		await expect(createWorkdayTreeDxWorkspace({
			baseUrl: 'https://treedx.example.test', token: 'brokered-token', repositoryId: 'repo-1',
			assignmentId: 'assignment-1', baseRef: 'refs/heads/main', branchName: 'refs/heads/assignment-1',
			mode: 'writable', allowedPaths: ['**'], ttlSeconds: 1800,
			fetchImpl: vi.fn(async () => new Response(JSON.stringify({ workspaceId: 'ws_wrong_workspace' }), { status: 200 })) as unknown as typeof fetch,
		})).rejects.toMatchObject({ code: 'capacity_workday_workspace_identity_mismatch' });
	});

	it('bounds and strictly decodes TreeDX workspace responses', async () => {
		const input = {
			baseUrl: 'https://treedx.example.test', token: 'brokered-token', repositoryId: 'repo-1',
			assignmentId: 'assignment-1', baseRef: 'refs/heads/main', branchName: 'refs/heads/assignment-1',
			mode: 'writable' as const, allowedPaths: ['**'], ttlSeconds: 1800,
		};
		await expect(createWorkdayTreeDxWorkspace({
			...input,
			fetchImpl: vi.fn(async () => new Response('{broken', { status: 200 })) as unknown as typeof fetch,
		})).rejects.toMatchObject({ code: 'capacity_workday_workspace_response_invalid' });
		await expect(createWorkdayTreeDxWorkspace({
			...input,
			fetchImpl: vi.fn(async () => new Response('x'.repeat(256 * 1024 + 1), { status: 200 })) as unknown as typeof fetch,
		})).rejects.toMatchObject({ code: 'capacity_workday_workspace_response_too_large' });
	});
});
