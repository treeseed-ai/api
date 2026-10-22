import { describe, expect, it, vi } from 'vitest';
import { createAgentQueryService } from '../../../../../src/api/control-plane/repositories/capacity/agent-query-service.ts';

const definition = (id: string, name: string) => ({
	schemaVersion: 'treeseed.agent/v1', id, name, agentClass: 'engineer',
	purpose: 'Work on recovery.', responsibilities: ['Complete bounded recovery work.'], capabilities: ['engineering'],
	context: { include: ['assignment-subject'] },
	activityProfiles: { acting: { handler: 'writer', permissions: {
		content: { read: ['objective'], write: ['proposal'] }, tools: ['source.read'],
	}, prompt: { system: 'Work from the accepted plan.' } } },
});

describe('agent queries for shared allocation classes', () => {
	it('returns every profile with its allocation class and exact per-agent source custody', async () => {
		const store = {
			getProjectDetails: vi.fn(async () => ({ project: { teamId: 'team' } })),
			listProjectAgentClassesPage: vi.fn(async () => ({ items: [{ id: 'project:engineer', slug: 'engineer', status: 'active',
				handlerRefs: { agents: [definition('sdk/engineer', 'SDK Engineer'), definition('sdk/operator-engineer', 'Operator Engineer')] },
				metadata: { immutableRef: 'a'.repeat(40), definitionSources: [
					{ agentId: 'sdk/engineer', path: 'agents/engineer.mdx', digest: `sha256:${'1'.repeat(64)}` },
					{ agentId: 'sdk/operator-engineer', path: 'agents/operator-engineer.yaml', digest: `sha256:${'2'.repeat(64)}` },
				] },
			}], page: { hasMore: false, nextCursor: null } })),
			getProjectAgentsSummary: vi.fn(async () => ({ agents: [] })),
		};
		const result = await createAgentQueryService(store).list({ id: 'admin', roles: ['admin'] }, 'project');
		expect(result.agents.map((agent: any) => [agent.agentSlug, agent.allocationClass, agent.definitionSource])).toEqual([
			['engineer', 'engineer', { path: 'agents/engineer.mdx', digest: `sha256:${'1'.repeat(64)}` }],
			['operator-engineer', 'engineer', { path: 'agents/operator-engineer.yaml', digest: `sha256:${'2'.repeat(64)}` }],
		]);
	});
});
