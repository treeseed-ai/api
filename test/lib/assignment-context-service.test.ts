import { describe, expect, it, vi } from 'vitest';
import { compileAssignmentProjectContext } from '../../src/api/capacity/services/assignment-context-service.ts';

function store(overrides: Record<string, unknown> = {}) {
	return {
		getProject: vi.fn(async () => ({ id: 'project-a', teamId: 'team-a', slug: 'project-a', metadata: {} })),
		getTeam: vi.fn(async () => ({ id: 'team-a', slug: 'team-a' })),
		listHubRepositories: vi.fn(async () => []),
		getProjectArchitecture: vi.fn(async () => ({ topology: 'single_repository_site' })),
		...overrides,
	};
}

describe('assignment project context', () => {
	it('propagates architecture storage failure instead of synthesizing fallback assignment context', async () => {
		const storageFailure = new Error('project architecture unavailable');
		const contextStore = store({ getProjectArchitecture: vi.fn(async () => { throw storageFailure; }) });
		await expect(compileAssignmentProjectContext(contextStore as never, 'project-a')).rejects.toBe(storageFailure);
	});

	it('fails closed when the project owning team is missing', async () => {
		const contextStore = store({ getTeam: vi.fn(async () => null) });
		await expect(compileAssignmentProjectContext(contextStore as never, 'project-a'))
			.rejects.toMatchObject({ code: 'capacity_project_team_not_found', details: { projectId: 'project-a', teamId: 'team-a' } });
	});
});
