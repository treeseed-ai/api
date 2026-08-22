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
		const operations = createKnowledgeOperations({ knowledgeReader: service });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.knowledge.teamCatalog, CONTROL_PLANE_OPERATIONS.knowledge.projectCatalog,
			CONTROL_PLANE_OPERATIONS.knowledge.library, CONTROL_PLANE_OPERATIONS.knowledge.reader,
			CONTROL_PLANE_OPERATIONS.knowledge.context, CONTROL_PLANE_OPERATIONS.knowledge.page,
			CONTROL_PLANE_OPERATIONS.knowledge.search,
		]);
		const page = operations[5];
		await page.handler({ path: { pageId: 'page-1' }, query: {}, body: undefined }, {
			interface: 'rest', requestId: 'request-1', principal: { id: 'user-1' },
		});
		expect(service.page).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), 'page-1');
	});
});
