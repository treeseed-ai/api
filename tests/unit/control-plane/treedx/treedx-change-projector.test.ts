import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reconcileExecutionGraph, resolveKnowledgeGatewayConnection, snapshotAgentDefinitions } = vi.hoisted(() => ({
	reconcileExecutionGraph: vi.fn(), resolveKnowledgeGatewayConnection: vi.fn(), snapshotAgentDefinitions: vi.fn(),
}));
vi.mock('../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts', () => ({ reconcileExecutionGraph }));
vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({ resolveKnowledgeGatewayConnection }));
vi.mock('../../../../src/api/capacity/services/capacity/agents/agent-definition-snapshot.ts', () => ({ snapshotAgentDefinitions }));

import { projectTreeDxCommitSignals } from '../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts';

function database() {
	return {
		first: vi.fn(async (sql: string) => sql.includes('FROM projects') ? { team_id: 'team-1' } : { repository_id: 'repo-1' }),
		all: vi.fn(async () => [{ id: 'class-1', slug: 'reviewer', status: 'active', metadata_json: {} }]),
		run: vi.fn(async () => undefined),
	};
}

describe('TreeDX change projection', () => {
	beforeEach(() => {
		reconcileExecutionGraph.mockReset();
		resolveKnowledgeGatewayConnection.mockReset();
		snapshotAgentDefinitions.mockReset();
	});

	it('does not feed a terminal Reporter note back into the execution graph', async () => {
		await projectTreeDxCommitSignals(database() as never, {
			projectId: 'project-1', commitSha: 'a'.repeat(40), changedPaths: ['notes/workday-report.mdx'],
			changeSummary: 'Committed workday report.', assignmentId: 'assignment-1', activityType: 'reporting', actorType: 'capacity_provider',
		});
		expect(reconcileExecutionGraph).not.toHaveBeenCalled();
	});

	it('does not treat an unpublished estimating result as new execution intent', async () => {
		await projectTreeDxCommitSignals(database() as never, {
			projectId: 'project-1', commitSha: 'b'.repeat(40), changedPaths: ['proposals/change.mdx'],
			changeSummary: 'Committed estimate.', assignmentId: 'assignment-2', activityType: 'estimating', actorType: 'capacity_provider',
		});
		expect(reconcileExecutionGraph).not.toHaveBeenCalled();
	});

	it('continues to reconcile authoritative proposal changes outside assignments', async () => {
		await projectTreeDxCommitSignals(database() as never, {
			projectId: 'project-1', commitSha: 'c'.repeat(40), changedPaths: ['proposals/change.mdx'],
			changeSummary: 'Committed proposal.', actorType: 'user',
		});
		expect(reconcileExecutionGraph).toHaveBeenCalledOnce();
	});

	it('projects published governed agent definitions into executable classes', async () => {
		const store = database();
		resolveKnowledgeGatewayConnection.mockResolvedValue({ baseRef: 'refs/heads/staging' });
		snapshotAgentDefinitions.mockResolvedValue({ commit: 'd'.repeat(40), files: [{ path: 'agents/reviewer.mdx',
			sourceDigest: `sha256:${'e'.repeat(64)}`, definition: { schemaVersion: 'treeseed.agent/v1', id: 'sdk/reviewer',
				name: 'SDK Reviewer', agentClass: 'reviewer', purpose: 'Review.', responsibilities: ['Review.'], capabilities: ['review'],
				activityProfiles: { reviewing: { handler: 'writer', permissions: { content: { read: ['proposal'], write: ['decision'] }, tools: ['source.read'] },
					prompt: { system: 'Review comprehensively.' } } }, context: { include: ['assignment-subject'] } } }],
		});
		await projectTreeDxCommitSignals(store as never, { projectId: 'project-1', commitSha: 'd'.repeat(40),
			immutableRef: 'refs/heads/staging', changedPaths: ['agents/reviewer.mdx'], changeSummary: 'Update Reviewer.', actorType: 'user' });
		const [sql, values] = store.run.mock.calls[0]!;
		expect(sql).toContain('UPDATE project_agent_classes');
		expect(JSON.parse(String(values[0]))).toEqual({ agents: [expect.objectContaining({ id: 'sdk/reviewer' })] });
		expect(String(values[1])).toContain(`"immutableRef":"${'d'.repeat(40)}"`);
	});

	it('activates same-class profiles together with per-agent source custody', async () => {
		const store = database();
		resolveKnowledgeGatewayConnection.mockResolvedValue({ baseRef: 'refs/heads/staging' });
		const definition = (id: string, name: string) => ({ schemaVersion: 'treeseed.agent/v1', id, name,
			agentClass: 'engineer', purpose: 'Operate recovery.', responsibilities: ['Recover.'], capabilities: ['engineering'],
			activityProfiles: { acting: { handler: 'writer', permissions: { content: { read: ['objective'], write: ['proposal'] }, tools: ['source.read'] },
				prompt: { system: 'Work from the governed recovery plan.' } } }, context: { include: ['assignment-subject'] } });
		snapshotAgentDefinitions.mockResolvedValue({ commit: 'f'.repeat(40), files: [
			{ path: 'agents/operator-engineer.yaml', sourceDigest: `sha256:${'1'.repeat(64)}`, definition: definition('sdk/operator-engineer', 'Operator Engineer') },
			{ path: 'agents/engineer.mdx', sourceDigest: `sha256:${'2'.repeat(64)}`, definition: definition('sdk/engineer', 'SDK Engineer') },
		] });
		await projectTreeDxCommitSignals(store as never, { projectId: 'project-1', commitSha: 'f'.repeat(40),
			immutableRef: 'refs/heads/staging', changedPaths: ['agents/operator-engineer.yaml'], changeSummary: 'Add operator profile.', actorType: 'user' });
		expect(store.run).toHaveBeenCalledOnce();
		const [, values] = store.run.mock.calls[0]!;
		expect(JSON.parse(String(values[0])).agents.map((agent: { id: string }) => agent.id)).toEqual(['sdk/operator-engineer', 'sdk/engineer']);
		const metadata = JSON.parse(String(values[1]));
		expect(metadata.definitionSources).toEqual([
			{ agentId: 'sdk/operator-engineer', path: 'agents/operator-engineer.yaml', digest: `sha256:${'1'.repeat(64)}` },
			{ agentId: 'sdk/engineer', path: 'agents/engineer.mdx', digest: `sha256:${'2'.repeat(64)}` },
		]);
	});
});
