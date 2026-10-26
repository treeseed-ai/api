import { afterEach, expect, it, vi } from 'vitest';
import { listReadyExecutionNodes } from '../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { ContextQueryCheckService } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import { agentProfileReference } from '../../../../../src/api/capacity/policy/execution/agent-profile-reference.ts';
import { canonicalOfferBuildInput, gitRef } from '../execution/fixtures/assignment-attempt-fixtures.ts';
const gateway = vi.hoisted(() => ({ readRepositoryFile: vi.fn() }));
vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'library', client: gateway })),
}));
afterEach(() => vi.restoreAllMocks());

it('resolves independent global and activity queries for an arbitrary configured identity before freezing its candidate context', async () => {
	const global = { id: 'repair-history', revision: 2 }, activity = { id: 'current-repair-context', revision: 3 };
	const definitionRef = 'a'.repeat(40), dataRef = 'b'.repeat(40), definitionPath = 'agents/context-owner.mdx';
	const permissions = { content: { read: ['proposal', 'agent', 'objective', 'knowledge'], write: [] }, tools: ['source.read'] };
	const definition = { schemaVersion: 'treeseed.agent/v1', id: 'configured/renamed-context-owner', name: 'Context owner', agentClass: 'maintenance',
		purpose: 'Repair accepted context delivery.', responsibilities: ['Retain prior repair evidence.'], capabilities: ['code-change'], context: { include: ['assignment-subject'] },
		contextQueryRefs: [global], activityProfiles: { acting: { handler: 'actor', contextQueryRefs: [activity], permissions,
			prompt: { system: 'Implement the accepted repair using exact context.' } } } };
	const { candidate, run } = canonicalOfferBuildInput(), node = candidate.node;
	const row = { id: node.id, team_id: node.teamId, project_id: node.projectId, work_item_id: node.workItemId,
		kind: node.kind, pair_role: node.pairRole, source_ref_json: node.sourceRef, authority_refs_json: [...node.authorityRefs!, agentProfileReference(definition as never)],
		rule_revision: 1, node_revision: 1, agent_class: definition.agentClass, status: 'ready', estimate_json: node.estimate,
		required_capabilities_json: node.requiredCapabilities, requested_permissions_json: permissions, workspace: 'git',
		acceptance_criteria_json: node.acceptanceCriteria, maximum_review_cycles: 2, graph_revision_created: 1, graph_revision_updated: 4, current_graph_revision: 4 };
	const ref = { store: 'treedx' as const, model: 'knowledge', id: 'earlier-repair', repository: 'library', commit: dataRef, path: 'knowledge/earlier-repair.mdx' };
	const resolved = { references: [ref], authorizedContext: [], selectors: [], checks: [] };
	const query = vi.spyOn(ContextQueryCheckService.prototype, 'resolveForAssignment').mockResolvedValue(resolved);
	gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: definitionRef, file: { path: definitionPath, frontmatter: definition } });
	const store = { getProjectByTeamAndSlug: async () => ({ id: 'team-library', slug: 'team' }),
		getProjectTreeDxLibrary: async () => ({ repositoryId: 'library', contentRepositoryRef: dataRef }),
		listHubRepositories: async () => [{ id: 'source-sdk', role: 'software', provider: 'github', owner: 'treeseed-ai', name: 'sdk', currentBranch: 'staging' }],
		all: vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([{ id: 'maintenance-class', status: 'active',
			handler_refs_json: { agents: [definition] }, metadata_json: { source: 'project-library', immutableRef: definitionRef, definitionPaths: [definitionPath] } }]).mockResolvedValueOnce([]) };
	const [ready] = await listReadyExecutionNodes(store, run, { id: 'project', slug: 'api' } as never, async () => [gitRef]);
	expect(query).toHaveBeenCalledWith({ teamId: 'team', projectId: 'project', definitionRef, dataRef, allowedModels: permissions.content.read,
		layers: { agent: { queryRefs: [global], querySetRefs: [] }, activity: { queryRefs: [activity], querySetRefs: [] } } });
	expect(ready.queryContext).toEqual(resolved); expect(ready.contextRefs).toContainEqual(ref);
});
