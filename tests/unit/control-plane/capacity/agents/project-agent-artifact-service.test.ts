import { describe, expect, it, vi } from 'vitest';
import { collectProjectAgentArtifacts } from '../../../../../src/api/capacity/services/projects/projects-core/project-agent-artifact-service.ts';

describe('project agent artifact evidence', () => {
	it('projects only committed, authorized TreeDX references from assignment results', async () => {
		const store = {
			getProjectDetails: vi.fn(async () => ({ id: 'project', teamId: 'team' })),
			listProviderAssignmentsPage: vi.fn(async () => ({ items: [{
				id: 'assignment', taskId: 'task', workDayId: 'workday', status: 'completed',
				assignmentAttempt: { grant: { contentWrite: [{ store: 'treedx', repository: 'library',
					path: 'knowledge/accepted.mdx', model: 'knowledge' }] } },
				assignmentResult: { completedAt: '2026-09-20T10:00:00.000Z', references: [
					{ kind: 'treedx', repository: 'library', path: 'knowledge/accepted.mdx', commit: 'a'.repeat(40) },
					{ kind: 'treedx', repository: 'library', path: 'knowledge/ungranted.mdx', commit: 'b'.repeat(40) },
				] },
			}], page: { hasMore: false } })),
		};
		const artifacts = await collectProjectAgentArtifacts(store, 'project');
		expect(store.listProviderAssignmentsPage).toHaveBeenCalledWith('team', { projectId: 'project', limit: 200 });
		expect(artifacts).toEqual([expect.objectContaining({
			assignmentId: 'assignment', model: 'knowledge', contentPath: 'knowledge/accepted.mdx',
			outputRef: `treedx:library:${'a'.repeat(40)}:knowledge/accepted.mdx`,
		})]);
		expect(JSON.stringify(artifacts)).not.toContain('modeRunId');
	});

	it('rejects a truncated assignment projection instead of hiding artifacts', async () => {
		const store = { getProjectDetails: vi.fn(async () => ({ teamId: 'team' })),
			listProviderAssignmentsPage: vi.fn(async () => ({ items: [], page: { hasMore: true, nextCursor: 'next' } })) };
		await expect(collectProjectAgentArtifacts(store, 'project')).rejects.toMatchObject({
			code: 'project_agent_artifact_evidence_bound_exceeded', details: { nextCursor: 'next' },
		});
	});
});
