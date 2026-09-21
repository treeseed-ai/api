import { beforeEach, describe, expect, it, vi } from 'vitest';
import { additionalPublicationParentRefs, createKnowledgeWorkspaceService } from '../../../../../src/api/control-plane/knowledge/knowledge-workspace-service.ts';
import {
	projectKnowledgeAuthoringPaths,
	projectKnowledgeAuthoringBaseRef,
	resolveKnowledgeGatewayConnection,
} from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async (original) => ({
	...await original<typeof import('../../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection: vi.fn(),
}));

function fixture() {
	const workspace = {
		id: 'workspace', projectId: 'project', actorUserId: 'author', status: 'draft', version: 1,
		treeDxWorkspaceId: 'remote', baseCommitSha: 'a'.repeat(40), baseRef: 'staging',
		branchName: 'refs/heads/knowledge/workspace', allowedPaths: ['objectives/**'],
	};
	const store = {
		getKnowledgeWorkspace: vi.fn(async () => workspace),
		getProjectDetails: vi.fn(async () => ({ project: { id: 'project', teamId: 'team' } })),
		principalCanAccessTeam: vi.fn(async () => true),
		getTeamAccessSummary: vi.fn(async () => ({ permissions: ['knowledge:author'] })),
		updateKnowledgeWorkspace: vi.fn(async () => ({ ok: true, workspace: { ...workspace, version: 2 } })),
		recordAuditEvent: vi.fn(async () => undefined),
	};
	const client = {
		readFile: vi.fn(async () => ({ sha: 'existing-sha', content: 'old content\n' })),
		applyChangeset: vi.fn(async () => ({ applied: true })),
	};
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.' } as never);
	const service = createKnowledgeWorkspaceService(store, { projectCatalog: vi.fn(async () => ({})) });
	return { client, service, workspace };
}

describe('objective TreeDX workspace authority', () => {
	beforeEach(() => vi.clearAllMocks());

	it('includes objectives in the governed authoring scope', () => {
		expect(projectKnowledgeAuthoringPaths('.')).toContain('objectives/**');
		expect(projectKnowledgeAuthoringPaths('teams/example')).toContain('teams/example/objectives/**');
	});

	it('bases authoring on the TreeDX publication ref instead of its external mirror', () => {
		expect(projectKnowledgeAuthoringBaseRef({ publicationRef: 'refs/heads/staging' })).toBe('refs/heads/staging');
	});

	it('retains a divergent external mirror as a reviewed merge parent', async () => {
		const client = { listRepositoryRefs: vi.fn(async () => [
			{ name: 'refs/remotes/origin/staging', target: 'remote-commit' },
		]) };
		await expect(additionalPublicationParentRefs({
			baseRef: 'refs/remotes/origin/staging', publicationRef: 'refs/heads/staging',
			repositoryId: 'repo', client,
		}, { baseCommitSha: 'local-commit' })).resolves.toEqual(['refs/remotes/origin/staging']);
	});

	it('does not add a merge parent when the mirror and publication base agree', async () => {
		const client = { listRepositoryRefs: vi.fn(async () => [
			{ name: 'refs/remotes/origin/staging', target: 'same-commit' },
		]) };
		await expect(additionalPublicationParentRefs({
			baseRef: 'refs/remotes/origin/staging', publicationRef: 'refs/heads/staging',
			repositoryId: 'repo', client,
		}, { baseCommitSha: 'same-commit' })).resolves.toEqual([]);
	});

	it('validates and writes an objective through the existing workspace result contract', async () => {
		const { client, service, workspace } = fixture();
		const result = await service.updateContent({ id: 'author' }, workspace.id, {
			kind: 'operational-content', version: 1, create: true, sourcePath: 'objectives/core.md',
			content: '---\nschemaVersion: treeseed.objective/v1\nid: core\nprojectId: project\ntitle: Core objective\noutcome: Govern the project through TreeDX.\nstatus: active\n---\n',
		});
		expect(result).toMatchObject({ workspace: { version: 2 } });
		expect(client.applyChangeset).toHaveBeenCalledWith(expect.objectContaining({
			workspaceId: 'remote', patch: expect.stringContaining('objectives/core.md'),
		}));
	});

	it('rejects invalid objective content before writing', async () => {
		const { client, service, workspace } = fixture();
		await expect(service.updateContent({ id: 'author' }, workspace.id, {
			kind: 'operational-content', version: 1, create: true, sourcePath: 'objectives/core.md', content: '---\nstatus: live\n---\n',
		})).rejects.toMatchObject({ code: 'operational_content_invalid' });
		expect(client.applyChangeset).not.toHaveBeenCalled();
	});
});
