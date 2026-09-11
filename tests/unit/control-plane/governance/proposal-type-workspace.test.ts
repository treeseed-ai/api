import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeWorkspaceService } from '../../../../src/api/control-plane/knowledge/knowledge-workspace-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async (original) => ({
	...await original<typeof import('../../../../src/api/knowledge/gateway-treedx-connection.ts')>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));

function fixture() {
	const workspace = { id: 'workspace', projectId: 'project', actorUserId: 'author', status: 'draft', version: 1,
		treeDxWorkspaceId: 'remote', baseCommitSha: 'a'.repeat(40), baseRef: 'staging', branchName: 'refs/heads/knowledge/workspace', allowedPaths: ['.treeseed/governance/proposal-types/**'] };
	const store = { getKnowledgeWorkspace: vi.fn(async () => workspace), getProjectDetails: vi.fn(async () => ({ project: { id: 'project', teamId: 'team' } })),
		principalCanAccessTeam: vi.fn(async () => true), getTeamAccessSummary: vi.fn(async () => ({ permissions: ['knowledge:author', 'projects:manage:team'] })),
		updateKnowledgeWorkspace: vi.fn(async () => ({ ok: true, workspace: { ...workspace, version: 2 } })), recordAuditEvent: vi.fn(async () => undefined) };
	const client = { readFile: vi.fn(async () => ({ sha: 'existing-sha', content: 'old content\n' })), applyChangeset: vi.fn(async () => ({ applied: true })) };
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.' } as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>);
	const service = createKnowledgeWorkspaceService(store, { projectCatalog: vi.fn(async () => ({})) });
	const input = { kind: 'proposal-type', version: 1, create: true, sourcePath: '.treeseed/governance/proposal-types/implementation.yaml',
		content: JSON.stringify({ schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'A bounded project change.' }) };
	return { workspace, store, client, input, write: (values: Record<string, unknown> = {}, principal = { id: 'author' }) => service.updateContent(principal, workspace.id, { ...input, ...values }) };
}

describe('proposal type workspace authority', () => {
	beforeEach(() => vi.clearAllMocks());
	it('creates through a base-bound changeset and records an audit event', async () => {
		const f = fixture();
		expect(await f.write()).toMatchObject({ workspace: { version: 2 } });
		expect(f.client.applyChangeset).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'remote',
			baseCommitSha: 'a'.repeat(40), expectedDestinationRefHead: 'a'.repeat(40), patch: expect.stringContaining('--- /dev/null') }));
		expect(f.store.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'knowledge.proposal_type.updated', actorId: 'author' }));
	});
	it('updates only after matching the observed file SHA', async () => {
		const f = fixture();
		await f.write({ create: false, expectedSha: 'existing-sha' });
		expect(f.client.applyChangeset).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.stringContaining('-old content') }));
	});
	it.each(['wrong', ''])('rejects stale or absent file SHA: %s', async (expectedSha) => {
		const f = fixture();
		await expect(f.write({ create: false, expectedSha })).rejects.toMatchObject({ code: 'stale_workspace_file' });
		expect(f.client.applyChangeset).not.toHaveBeenCalled();
	});
	it('rejects creation collisions without advancing or auditing the workspace', async () => {
		const f = fixture();
		f.client.applyChangeset.mockRejectedValueOnce(Object.assign(new Error('Destination exists.'), { status: 409 }));
		await expect(f.write()).rejects.toMatchObject({ status: 409 });
		expect(f.store.updateKnowledgeWorkspace).not.toHaveBeenCalled();
		expect(f.store.recordAuditEvent).not.toHaveBeenCalled();
	});
	it.each(['outsider', 'other-author', 'knowledge-only', 'stale-version', 'path-scope'])('rejects unauthorized or stale mutation: %s', async (mode) => {
		const f = fixture();
		if (mode === 'outsider') f.store.principalCanAccessTeam.mockResolvedValue(false);
		if (mode === 'other-author') f.workspace.actorUserId = 'someone-else';
		if (mode === 'knowledge-only') f.store.getTeamAccessSummary.mockResolvedValue({ permissions: ['knowledge:author'] });
		if (mode === 'path-scope') f.workspace.allowedPaths = ['books/**'];
		await expect(f.write(mode === 'stale-version' ? { version: 2 } : {})).rejects.toBeDefined();
		expect(f.client.applyChangeset).not.toHaveBeenCalled();
		expect(f.store.updateKnowledgeWorkspace).not.toHaveBeenCalled();
	});
});
