import { describe, expect, it, vi } from 'vitest';
import { verifyAssignmentContent, recordAssignmentContentIntegration } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({ resolveKnowledgeGatewayConnection: vi.fn() }));

const scope = { id: 'assignment', teamId: 'team', projectId: 'project' };
const reference = { kind: 'treedx' as const, projectId: 'project', repository: 'repo', workspaceId: 'workspace',
	commit: 'a'.repeat(40), path: 'discussion-messages/topic/response.mdx' };
const result = { schemaVersion: 'treeseed.assignment-result/v1' as const, id: 'result', assignmentId: 'assignment',
	status: 'completed' as const, summary: 'Done', references: [reference], verification: [], usage: { elapsedSeconds: 1 },
	diagnostics: [], completedAt: '2026-09-26T19:08:00.000Z' };

describe('canonical result content read-back', () => {
	it('delegates the exact validated Note commit and path without collection-wide authoring access', async () => {
		const note = { ...reference, path: 'notes/planning/sdk-architect.mdx' };
		const readRepositoryFiles = vi.fn(async () => ({ resolvedRef: note.commit,
			files: [{ path: note.path, content: 'Planning contribution' }] }));
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ repositoryId: note.repository,
			client: { readRepositoryFiles } } as never);
		await verifyAssignmentContent({ run: vi.fn(), all: vi.fn() }, scope, { ...result, references: [note] });
		expect(resolveKnowledgeGatewayConnection).toHaveBeenCalledWith(expect.anything(), {
			projectId: scope.projectId, write: false, readRefs: [note.commit], workspacePaths: [note.path] });
		expect(readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: note.commit, paths: [note.path] }));
	});
	it('produces the integration receipt only from exact readable result content', async () => {
		const store = { run: vi.fn(), all: vi.fn() };
		const read = vi.fn(async () => ({ resolvedRef: reference.commit, files: [{ path: reference.path, content: 'Response' }] }));
		const references = await verifyAssignmentContent(store, scope, result, read);
		await recordAssignmentContentIntegration(store, scope, result, references);
		expect(read).toHaveBeenCalledWith(reference);
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining("status='completed'"), expect.arrayContaining([
			'assignment-content-integrated:assignment:result', scope.id, scope.teamId, scope.projectId, result.id]));
		expect(JSON.parse(store.run.mock.calls[0]![1]![2] as string)).toMatchObject({ resultId: 'result', publication: false, references: [reference] });
	});
	it('rejects wrong commit, absent path, and unreadable content without a receipt', async () => {
		const store = { run: vi.fn(), all: vi.fn() };
		for (const observed of [{ resolvedRef: 'b'.repeat(40), files: [{ path: reference.path, content: 'Response' }] },
			{ resolvedRef: reference.commit, files: [] }, { resolvedRef: reference.commit, files: [{ path: reference.path }] }]) {
			await expect(verifyAssignmentContent(store, scope, result, async () => observed)).rejects.toMatchObject({ code: 'assignment_content_readback_failed' });
		}
		expect(store.run).not.toHaveBeenCalled();
	});
	it('rejects cross-project and cross-assignment content before contacting TreeDX', async () => {
		const store = { run: vi.fn(), all: vi.fn() }, read = vi.fn();
		await expect(verifyAssignmentContent(store, scope, { ...result, assignmentId: 'other' }, read)).rejects.toMatchObject({ code: 'assignment_content_result_invalid' });
		await expect(verifyAssignmentContent(store, scope, { ...result, references: [{ ...reference, projectId: 'other' }] }, read)).rejects.toMatchObject({ code: 'assignment_content_project_mismatch' });
		expect(read).not.toHaveBeenCalled();
	});
});
