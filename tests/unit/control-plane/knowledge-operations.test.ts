import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createKnowledgeOperations } from '../../../src/api/control-plane/catalog/knowledge-operations.ts';

describe('knowledge catalog operations', () => {
	it('maps each contextual reader operation to one API service call', async () => {
		const service = {
			teamCatalog: vi.fn(async () => ({ books: [], pages: [] })),
			projectCatalog: vi.fn(async () => ({ books: [], pages: [] })),
			library: vi.fn(async () => ({ books: [], revision: 'r1' })),
			reader: vi.fn(async () => ({ navigation: [], revision: 'r1' })),
			context: vi.fn(async () => ({ page: { id: 'page-1' }, relatedPages: [], revision: 'r1' })),
			page: vi.fn(async () => ({ page: { id: 'page-1' }, relatedPages: [], revision: 'r1' })),
			search: vi.fn(async () => ({ results: [], revision: 'r1' })),
		};
		const workspaces = {
			create: vi.fn(async () => ({ id: 'workspace-1' })), show: vi.fn(async () => ({ id: 'workspace-1', presence: [] })),
			readContent: vi.fn(async () => ({ kind: 'page', path: 'knowledge/page.md' })),
			updateContent: vi.fn(async () => ({ workspace: { id: 'workspace-1' } })),
			diff: vi.fn(async () => ({ changedPaths: [] })), abandon: vi.fn(async () => ({ id: 'workspace-1', status: 'abandoned' })),
			submit: vi.fn(async () => ({ review: { id: 'review-1' }, commit: { commitSha: 'abc' } })),
		};
		const operations = createKnowledgeOperations({ knowledgeReader: service, knowledgeWorkspaces: workspaces });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.knowledge.teamCatalog, CONTROL_PLANE_OPERATIONS.knowledge.projectCatalog,
			CONTROL_PLANE_OPERATIONS.knowledge.library, CONTROL_PLANE_OPERATIONS.knowledge.reader,
			CONTROL_PLANE_OPERATIONS.knowledge.context, CONTROL_PLANE_OPERATIONS.knowledge.page,
			CONTROL_PLANE_OPERATIONS.knowledge.search,
			CONTROL_PLANE_OPERATIONS.knowledge.createWorkspace, CONTROL_PLANE_OPERATIONS.knowledge.workspace,
			CONTROL_PLANE_OPERATIONS.knowledge.workspaceContent, CONTROL_PLANE_OPERATIONS.knowledge.updateWorkspaceContent,
			CONTROL_PLANE_OPERATIONS.knowledge.workspaceDiff, CONTROL_PLANE_OPERATIONS.knowledge.abandonWorkspace,
			CONTROL_PLANE_OPERATIONS.knowledge.submitWorkspace,
		]);
		const page = operations[5];
		await page.handler({ path: { pageId: 'page-1' }, query: {}, body: undefined }, {
			interface: 'rest', requestId: 'request-1', principal: { id: 'user-1' },
		});
		expect(service.page).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), 'page-1');
		await operations[12].handler({ path: { workspaceId: 'workspace-1' }, query: {}, body: { version: 1 } }, {
			interface: 'rest', requestId: 'request-2', principal: { id: 'user-1' },
		});
		expect(workspaces.abandon).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), 'workspace-1', { version: 1 });
	});
});
