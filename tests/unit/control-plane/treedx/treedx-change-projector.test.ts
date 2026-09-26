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
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE project_agent_classes'), expect.arrayContaining([
			'SDK Reviewer', expect.stringContaining('sdk/reviewer'), expect.stringContaining(`"immutableRef":"${'d'.repeat(40)}"`),
		]));
	});
});
