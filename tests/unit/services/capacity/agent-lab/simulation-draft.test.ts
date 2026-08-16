import { parse } from 'yaml';
import { describe,expect,it,vi } from 'vitest';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: async () => ({
		repositoryId: 'repository-1',
		baseRef: 'refs/heads/staging',
		authoringBranch: 'staging',
		contentPath: 'src/content',
		client: {
			listRepositoryRefs: async () => [{ name: 'refs/heads/staging', target: 'a'.repeat(40) }],
		},
	}),
}));

vi.mock('../../../../../src/api/capacity/routes/support/agent-lab/repository-definitions.ts', () => ({
	agentLabRepositoryDefinitions: async () => [
		{ kind: 'agent', data: { valid: true, definition: { slug: 'architect', enabled: true } } },
		{ kind: 'agent', data: { valid: true, definition: { slug: 'retired', enabled: false } } },
	],
	invalidateAgentLabRepositoryDefinitions: () => undefined,
	repositoryDefinitionSource: () => '',
	validateAgentDefinitionSource: () => ({ ok: true, diagnostics: [], references: [] }),
}));

import { agentClassProjectionIdempotencyKey,agentLabSimulationDraft } from '../../../../../src/api/capacity/routes/support/agent-lab/authoring.ts';
import { parseAgentLabSimulationDraftOptions } from '../../../../../src/api/capacity/routes/support/agent-lab/simulation-draft-options.ts';

const planningClassPage = {
	items: [{
		id: 'project-1:planning', teamId: 'team-1', projectId: 'project-1', slug: 'planning', name: 'Planning', status: 'active',
		allowedModes: ['planning'], requiredCapabilities: [], kernelProfile: {}, kernelPolicy: {}, outputContracts: {}, metadata: {},
		handlerRefs: { agents: [{ slug: 'architect', activities: { planning: { handler: 'writer', signals: { publishes: [], subscribesTo: [] } } } }], signalContracts: {}, proposalTypeContracts: {}, groupContracts: {}, groupEdgeContracts: {} },
	}],
	page: { limit: 200, hasMore: false, nextCursor: null },
};

describe('Agent Lab simulation draft', () => {
	it('defaults live agent assignments to a useful closeout-safe timebox', () => {
		expect(parseAgentLabSimulationDraftOptions(() => undefined).assignmentTimeboxSeconds).toBe(600);
		expect(parseAgentLabSimulationDraftOptions((name) => name === 'durationSeconds' ? '180' : undefined).assignmentTimeboxSeconds).toBe(180);
	});
	it('versions durable class projection replay independently from the immutable content ref', () => {
		const first = agentClassProjectionIdempotencyKey('a'.repeat(40), 'evidence-research', { handlerRefs: { agents: [] } }, { handlerRefs: {} });
		const replay = agentClassProjectionIdempotencyKey('a'.repeat(40), 'evidence-research', { handlerRefs: { agents: [] } }, { handlerRefs: {} });
		const repaired = agentClassProjectionIdempotencyKey('a'.repeat(40), 'evidence-research', { handlerRefs: { agents: [] } }, { handlerRefs: { agents: [] } });
		expect(first).toMatch(new RegExp(`^agent-lab-sync:v5:${'a'.repeat(40)}:evidence-research:[a-f0-9]{16}:[a-f0-9]{16}$`, 'u'));
		expect(replay).toBe(first);
		expect(repaired).not.toBe(first);
	});
	it('derives provider authority and an enabled project inventory test from durable state', async () => {
		const store = {
			listProjectAgentClassesPage: async () => planningClassPage,
			first: async (query: string) => query.includes('FROM teams')
				? { id: 'team-1', slug: 'treeseed', name: 'TreeSeed' }
				: query.includes('FROM capacity_grants') ? {
					id: 'provider-1',
					grant_metadata_json: JSON.stringify({ seedResourceKey: 'capacity-provider:treeseed/agents' }),
					execution_provider_ids_json: JSON.stringify(['codex-sub', 'codex-key']),
				} : null,
			all: async () => [{
				id: 'project-1', slug: 'market', name: 'Market', description: 'Market project',
				metadata_json: JSON.stringify({ kind: 'market_app', repository: {}, architecture: {} }),
			}],
		};

		const draft = await agentLabSimulationDraft({ store } as never, 'team-1', 'project-1');
		const seed = parse(draft.seedYaml);
		const scene = parse(draft.sceneYaml);
		const test = parse(draft.testMdx.split('---')[1] ?? '');

		expect(seed.references).toEqual(['capacity-provider:treeseed/agents']);
		expect(seed.runtime.capacityProviders).toBeUndefined();
		expect(scene.agentLab.scope.capacityProvider).toBe('capacity-provider:treeseed/agents');
		expect(scene.agentLab.executionProvider).toBe('codex-sub');
		expect(scene.agentLab.workdays[0].agentTests).toEqual(['agent-lab-project-inventory']);
		expect(test.trigger.agents).toEqual(['architect']);
		expect(draft.testPath).toBe('src/content/agent-tests/agent-lab-project-inventory.mdx');
		expect(draft.diagnostics).toEqual([]);
	});

	it('authors a bounded short workday for an explicitly selected enabled agent', async () => {
		const store = {
			listProjectAgentClassesPage: async () => planningClassPage,
			first: async (query: string) => query.includes('FROM teams')
				? { id: 'team-1', slug: 'treeseed', name: 'TreeSeed' }
				: query.includes('FROM capacity_grants') ? {
					grant_metadata_json: JSON.stringify({ seedResourceKey: 'capacity-provider:treeseed/agents' }),
					execution_provider_ids_json: JSON.stringify(['codex-sub']),
				} : null,
			all: async () => [{ id: 'project-1', slug: 'market', name: 'Market', metadata_json: '{}' }],
		};

		const draft = await agentLabSimulationDraft({ store } as never, 'team-1', 'project-1', {
			durationSeconds: 180,
			planningRounds: 1,
			assignmentTimeboxSeconds: 60,
			maxActiveAssignments: 1,
			agentSlugs: ['architect'],
			activityTypes: ['planning'],
		});
		const scene = parse(draft.sceneYaml);
		const test = parse(draft.testMdx.split('---')[1] ?? '');

		expect(scene.agentLab.workdays[0]).toMatchObject({
			durationSeconds: 180,
			maxActiveAssignments: 1,
			activityTypes: ['planning'],
			planningSession: { rounds: 1, assignmentTimeboxSeconds: 60 },
		});
		expect(test.trigger.agents).toEqual(['architect']);
		expect(draft.diagnostics).toEqual([]);
	});

	it('reports planning-budget infeasibility before authoring the scene', async () => {
		const expensivePage = structuredClone(planningClassPage);
		expensivePage.items[0]!.handlerRefs.agents[0]!.activities.planning.execution = { maxRuntimeSeconds: 180 };
		const store = {
			listProjectAgentClassesPage: async () => expensivePage,
			first: async (query: string) => query.includes('FROM teams')
				? { id: 'team-1', slug: 'treeseed', name: 'TreeSeed' }
				: query.includes('FROM capacity_grants') ? {
					grant_metadata_json: JSON.stringify({ seedResourceKey: 'capacity-provider:treeseed/agents' }),
					execution_provider_ids_json: JSON.stringify(['codex-sub']),
				} : null,
			all: async () => [{ id: 'project-1', slug: 'market', name: 'Market', metadata_json: '{}' }],
		};

		const draft = await agentLabSimulationDraft({ store } as never, 'team-1', 'project-1', {
			durationSeconds: 60,
			planningRounds: 2,
			assignmentTimeboxSeconds: 180,
			maxActiveAssignments: 1,
			agentSlugs: ['architect'],
			activityTypes: ['planning'],
		});

		expect(draft.diagnostics).toContainEqual(expect.objectContaining({
			severity: 'error',
			path: 'agents',
			message: 'The cooperative planning profiles do not fit within the allocated agent time. Required 180 planning seconds; this plan allocates 54.',
		}));
	});
});
