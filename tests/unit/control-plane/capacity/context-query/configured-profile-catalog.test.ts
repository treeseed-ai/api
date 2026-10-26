import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ContextQueryCheckService } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { agentDefinitionSchema } from '@treeseed/sdk/agent-capacity';
import { effectiveProfile } from '../../../../../src/api/capacity/services/build/execution-node-profile.ts';
import { agentProfileReference } from '../../../../../src/api/capacity/policy/execution/agent-profile-reference.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<object>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.each(['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat'] as const)(
	'inherits global and activity query selectors in exact canonical %s context', async activity => {
		const global = { id: 'portfolio/objectives', revision: 2 }, local = { id: 'portfolio/work-history', revision: 3 };
		const globalSet = { id: 'portfolio/foundation', revision: 4 }, localSet = { id: 'portfolio/experience', revision: 5 };
		const commit = 'a'.repeat(40), path = 'agents/renamed-contributor.mdx';
		const definition = agentDefinitionSchema.parse({ schemaVersion: 'treeseed.agent/v1', id: 'project/renamed-contributor',
			name: 'Renamed contributor', agentClass: 'maintenance', purpose: 'Advance accepted work with relevant experience.',
			responsibilities: ['Use exact context.'], capabilities: ['source.read'], context: { include: ['project-objectives'] },
			contextQueryRefs: [global], contextQuerySetRefs: [globalSet], activityProfiles: { [activity]: {
				handler: 'configured/workload', prompt: { system: 'Use governed context.' },
				permissions: { content: { read: ['agent', 'objective', 'discussion'], write: [] }, tools: [] },
				contextQueryRefs: [local], contextQuerySetRefs: [localSet],
			} } });
		const before = structuredClone(definition);
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ repositoryId: 'library', client: {
			readRepositoryFile: vi.fn().mockResolvedValue({ resolvedRef: commit, file: { path, frontmatter: definition } }),
		} } as never);
		const store = { all: vi.fn().mockResolvedValue([{ id: 'class', status: 'active', handler_refs_json: { agents: [definition] },
			metadata_json: { source: 'project-library', immutableRef: commit, definitionPaths: [path] } }]) };
		const result = await effectiveProfile(store, { id: 'node', projectId: 'project',
			kind: activity === 'chat' ? 'communication' : activity, agentClass: definition.agentClass,
			authorityRefs: [agentProfileReference(definition)] } as never);
		expect(result.profile.contextQueryRefs).toEqual([global, local]);
		expect(result.profile.contextQuerySetRefs).toEqual([globalSet, localSet]);
		expect(result.profile.permissionCeiling).toEqual(definition.activityProfiles[activity]!.permissions);
		expect(definition).toEqual(before);
	});

it('catalogs exact global and configured activity query refs without an unsupported enabled flag', async () => {
	const activities = ['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat'];
	const query = { id: 'portfolio/related-objectives', revision: 2 }, set = { id: 'portfolio/history', revision: 3 };
	const own = { id: 'portfolio/work-context', revision: 4 }, commit = 'a'.repeat(40), path = 'agents/contributor.mdx';
	const definition = { schemaVersion: 'treeseed.agent/v1', id: 'portfolio/renamed-contributor', name: 'Portfolio Contributor',
		agentClass: 'contributor', purpose: 'Advance the project using the exact governed context.', responsibilities: ['Use prior experience.'],
		capabilities: ['implementation'], context: { include: ['project-objectives'] }, contextQueryRefs: [query], contextQuerySetRefs: [set],
		activityProfiles: Object.fromEntries(activities.map(activity => [activity, { handler: 'configured/workload',
			permissions: { content: { read: ['agent', 'objective', 'note'], write: [] }, tools: [] },
			prompt: { system: 'Use the full authorized context and relevant prior experience.' }, contextQueryRefs: [own] }])) };
	const content = `---\n${stringify(definition)}---\n`, before = structuredClone(definition);
	const read = vi.fn().mockResolvedValue({ resolvedRef: commit, files: [{ path, content }] });
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ repositoryId: 'library', contentPath: '.', client: {
		listRepositoryPaths: vi.fn().mockResolvedValue({ resolvedRef: commit, entries: [{ path }] }), readRepositoryFiles: read,
	} } as never);
	const result = await new ContextQueryCheckService({} as CapacityGovernanceDatabase).catalog('project', commit);
	expect(result.commit).toBe(commit); expect(result.agentReferences).toHaveLength(activities.length * 3);
	for (const profileId of activities) for (const [kind, reference] of [['query', query], ['query', own], ['query-set', set]] as const) {
		expect(result.agentReferences).toContainEqual({ entryType: 'agent-reference', agentId: definition.id, profileId, kind, ...reference });
	}
	expect(read).toHaveBeenCalledWith(expect.objectContaining({ ref: commit, paths: [path] }));
	expect(definition).toEqual(before);
});
