import { describe, expect, it } from 'vitest';
import { createProjectsListOperation } from '../../../../src/api/control-plane/catalog/project-operations.ts';

const projects = Array.from({ length: 3 }, (_, index) => ({
	id: `project-${index + 1}`, slug: `project-${index + 1}`, metadata: {},
}));

describe('project list operation', () => {
	it('returns the canonical paginated items shape used by slug resolution', async () => {
		const operation = createProjectsListOperation({
			store: { async listProjectsForPrincipal() { return projects; } },
		} as never);
		const first = await operation.handler({ path: {}, query: { limit: 2 }, body: undefined }, {
			principal: { id: 'user-1' },
		} as never);
		expect(first).toMatchObject({ items: projects.slice(0, 2), page: { limit: 2, hasMore: true } });
		const second = await operation.handler({ path: {}, query: { limit: 2, cursor: first.page.nextCursor! }, body: undefined }, {
			principal: { id: 'user-1' },
		} as never);
		expect(second).toEqual({ items: projects.slice(2), page: { limit: 2, hasMore: false, nextCursor: null } });
	});

	it('fails explicitly for malformed cursors', async () => {
		const operation = createProjectsListOperation({
			store: { async listProjectsForPrincipal() { return projects; } },
		} as never);
		await expect(operation.handler({ path: {}, query: { cursor: 'not-a-cursor' }, body: undefined }, {
			principal: { id: 'user-1' },
		} as never)).rejects.toMatchObject({ status: 400, code: 'project_cursor_invalid' });
	});
});
