import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '../../../../../src/api/content/frontmatter.ts';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';

const { resolveConnection, snapshot, applyChanges, projectSignals, recordState } = vi.hoisted(() => ({
	resolveConnection: vi.fn(), snapshot: vi.fn(), applyChanges: vi.fn(), projectSignals: vi.fn(), recordState: vi.fn(),
}));
vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection: resolveConnection,
}));
vi.mock('../../../../../src/api/capacity/services/capacity/agents/agent-definition-snapshot.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../src/api/capacity/services/capacity/agents/agent-definition-snapshot.ts')>(),
	snapshotAgentDefinitions: snapshot,
}));
vi.mock('../../../../../src/api/knowledge/changesets/apply-text-changeset.ts', () => ({ applyTextChangeset: applyChanges }));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({ projectTreeDxCommitSignals: projectSignals }));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts', () => ({ recordTreeDxAuthoringState: recordState }));

import { AgentTeamCloneService } from '../../../../../src/api/capacity/services/capacity/agents/team-clone/agent-team-clone-service.ts';

const sourceCommit = 'a'.repeat(40);
const initialTargetCommit = 'b'.repeat(40);
const clonedCommit = 'c'.repeat(40);
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const definition = (id: string, name: string, prompt: string) => ({
	schemaVersion: 'treeseed.agent/v1', id, name, agentClass: 'engineer', purpose: `${name} purpose.`,
	responsibilities: [`Support ${name}.`], capabilities: ['reasoning'], context: { include: ['project-objectives'] },
	groups: ['project-api'], activityProfiles: { chat: { handler: 'writer', permissions: {
		content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'],
	}, prompt: { system: prompt } } },
});

describe('team clone with shared-class profiles', () => {
	it('preserves distinct profile identities and paths, activates the whole class, and replays as noop', async () => {
		const sourceFiles = [
			{ path: 'agents/operator-engineer.yaml', value: definition('sdk/operator-engineer', 'SDK Operator', 'Keep operator instructions intact.') },
			{ path: 'agents/engineer.mdx', value: definition('sdk/engineer', 'SDK Engineer', 'Keep engineer instructions intact.') },
		].map(({ path, value }) => {
			const content = serializeFrontmatterDocument(value);
			return { path, content, definition: value, sourceDigest: digest(content) };
		});
		const targetFiles = new Map<string, string>();
		let targetHead = initialTargetCommit;
		let classes: Array<Record<string, unknown>> = [];
		const sourceClient = {};
		const targetClient = {
			listRepositoryRefs: vi.fn(async () => [{ name: 'refs/heads/main', target: targetHead }]),
			readRepositoryFiles: vi.fn(async ({ ref, paths }: { ref: string; paths: string[] }) => ({
				resolvedRef: ref, files: paths.flatMap((path) => targetFiles.has(path) ? [{ path, content: targetFiles.get(path) }] : []),
			})),
			createWorkspace: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, baseCommitSha: targetHead })),
			commit: vi.fn(async () => ({ commitSha: clonedCommit, branchName: 'refs/heads/main', changedPaths: [...targetFiles.keys()] })),
			closeWorkspace: vi.fn(),
		};
		resolveConnection.mockImplementation(async (_store: unknown, { projectId }: { projectId: string }) => ({
			repositoryId: `${projectId}-repo`, baseRef: 'refs/heads/main', authoringBranch: 'main', contentPath: '.', allowedPaths: ['agents/**'],
			client: projectId === 'source-id' ? sourceClient : targetClient,
		}));
		snapshot.mockImplementation(async (_connection: unknown, ref: string) => {
			if (ref === sourceCommit) return { commit: sourceCommit, files: sourceFiles };
			const files = [...targetFiles].map(([path, content]) => {
				const value = parseFrontmatterDocument(content).frontmatter;
				return { path, content, definition: validateAgentDefinitionModel(value).data, sourceDigest: digest(content) };
			});
			return { commit: ref, files };
		});
		applyChanges.mockImplementation(async ({ changes }: { changes: Array<{ path: string; after: string }> }) => {
			for (const change of changes) targetFiles.set(change.path, change.after);
			targetHead = clonedCommit;
		});
		const store = {
			listTeamProjects: vi.fn(async () => [
				{ id: 'source-id', slug: 'sdk', name: 'SDK' }, { id: 'target-id', slug: 'target', name: 'Target' },
			]),
			listProjectAgentClassesPage: vi.fn(async (projectId: string) => ({ items: projectId === 'source-id'
				? [{ status: 'active', metadata: { immutableRef: sourceCommit } }] : classes })),
			createProjectAgentClass: vi.fn(async (_projectId: string, input: Record<string, unknown>) => { classes.push(input); }),
			updateProjectAgentClass: vi.fn(async (_projectId: string, _id: string, input: Record<string, unknown>) => {
				classes = classes.map((entry) => entry.id === _id ? input : entry);
			}),
		};
		const service = new AgentTeamCloneService(store);
		const principal = { id: 'admin', roles: ['admin'] };
		const plan = await service.plan(principal, 'team-id', { sourceProject: 'sdk', targetProjects: ['target'] });
		expect(plan.targets[0]).toMatchObject({ commit: initialTargetCommit, action: 'create', definitions: [
			{ path: 'agents/engineer.mdx', agentClass: 'engineer' },
			{ path: 'agents/operator-engineer.yaml', agentClass: 'engineer' },
		] });
		const receipt = await service.apply(principal, 'team-id', plan);
		expect(receipt.targets[0]).toMatchObject({ action: 'created', commit: clonedCommit, definitionCount: 2 });
		expect(targetFiles.size).toBe(2);
		const activeClass = classes[0]!;
		expect(activeClass).toMatchObject({ slug: 'engineer', status: 'active', metadata: {
			immutableRef: clonedCommit, definitionPaths: ['agents/operator-engineer.yaml', 'agents/engineer.mdx'],
		} });
		expect((activeClass.handlerRefs as { agents: Array<Record<string, unknown>> }).agents.map((agent) => agent.id))
			.toEqual(['target/operator-engineer', 'target/engineer']);
		expect((activeClass.handlerRefs as { agents: Array<Record<string, unknown>> }).agents.map((agent) =>
			((agent.activityProfiles as Record<string, { prompt: { system: string } }>).chat.prompt.system)))
			.toEqual(['Keep operator instructions intact.', 'Keep engineer instructions intact.']);
		const replay = await service.plan(principal, 'team-id', { sourceProject: 'sdk', targetProjects: ['target'] });
		expect(replay.targets[0]).toMatchObject({ commit: clonedCommit, action: 'noop' });
		expect(projectSignals).toHaveBeenCalledOnce();
	});
});
