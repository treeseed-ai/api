import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createAgentOperations } from '../../../../src/api/control-plane/catalog/capacity/agents.ts';
import { createAgentQueryService } from '../../../../src/api/control-plane/repositories/capacity/agent-query-service.ts';

const principal = { id: 'user-1' };

describe('agent catalog operations', () => {
	it('binds only inspection operations', () => {
		const agents = Object.fromEntries(['list', 'show', 'classes', 'classShow', 'artifacts', 'artifact'].map((name) => [name, vi.fn()])) as any;
		expect(createAgentOperations({ agents }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.agents.list, CONTROL_PLANE_OPERATIONS.agents.show,
			CONTROL_PLANE_OPERATIONS.agents.classes, CONTROL_PLANE_OPERATIONS.agents.classShow,
			CONTROL_PLANE_OPERATIONS.agents.artifacts, CONTROL_PLANE_OPERATIONS.agents.artifact,
		]);
	});

	it('reads accepted definitions without exposing class mutation', async () => {
		const store = {
			getProjectDetails: vi.fn(async () => ({ project: { id: 'project-1', teamId: 'team-1' } })),
			principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['projects:read:team'] })),
			getProjectAgentsSummary: vi.fn(async () => ({ agents: [{ slug: 'engineer' }] })),
			listProjectAgentClassesPage: vi.fn(async () => ({ items: [{ id: 'class-1', slug: 'engineering', status: 'active', updatedAt: '2026-08-23T00:00:00.000Z', metadata: { immutableRef: 'ref-1' }, handlerRefs: { agents: [{ slug: 'engineer', name: 'Engineer', activities: { chat: { enabled: true, handler: 'chat' } } }] } }] })),
		};
		await expect(createAgentQueryService(store).show(principal, 'project-1', 'engineer')).resolves.toMatchObject({
			projectId: 'project-1', agent: { agentSlug: 'engineer', allocationClass: 'engineering', chatEnabled: true },
		});
	});
});
