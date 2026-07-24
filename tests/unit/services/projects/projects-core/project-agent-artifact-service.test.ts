import { describe, expect, it, vi } from 'vitest';
import { collectProjectAgentArtifacts } from '../../../../../src/api/capacity/services/projects/projects-core/project-agent-artifact-service.ts';

describe('project agent artifact service', () => {
	it('projects only canonical mode-run and artifact-manifest TreeDX references', async () => {
		const listAgentModeRunsPage = vi.fn(async () => ({
			items: [{
				id: 'mode-run-1',
				status: 'completed',
				capacityEnvelope: { workDayId: 'workday-1' },
				outputs: {
					artifactManifest: {
						contentReferences: [{ model: 'note', contentPath: 'notes/research/result.mdx', subjectId: 'question-1' }],
					},
				},
				completedAt: '2026-07-18T12:00:00.000Z',
			}],
			page: { hasMore: false, nextCursor: null },
		}));
		await expect(collectProjectAgentArtifacts({ listAgentModeRunsPage }, 'project-1')).resolves.toEqual([expect.objectContaining({
			id: 'notes/research/result.mdx',
			modeRunId: 'mode-run-1',
			workDayId: 'workday-1',
			outputRef: 'treedx:notes/research/result.mdx',
		})]);
		expect(listAgentModeRunsPage).toHaveBeenCalledWith('project-1', { limit: 200 });
	});

	it('does not project caller-asserted or retired content reference fields', async () => {
		const runs = [{
			id: 'mode-run-legacy',
			outputs: {
				contentArtifactRefs: [{ model: 'note', contentPath: 'notes/fabricated.mdx' }],
				artifactManifest: { contentRefs: [{ model: 'note', contentPath: 'notes/legacy.mdx' }] },
			},
		}];
		await expect(collectProjectAgentArtifacts({
			listAgentModeRunsPage: async () => ({ items: runs, page: { hasMore: false } }),
		}, 'project-1')).resolves.toEqual([]);
	});

	it('fails instead of hiding storage uncertainty or truncating evidence', async () => {
		const failure = new Error('mode-run storage unavailable');
		await expect(collectProjectAgentArtifacts({
			listAgentModeRunsPage: async () => { throw failure; },
		}, 'project-1')).rejects.toBe(failure);
		await expect(collectProjectAgentArtifacts({
			listAgentModeRunsPage: async () => ({ items: [], page: { hasMore: true, nextCursor: 'next' } }),
		}, 'project-1')).rejects.toMatchObject({ code: 'project_agent_artifact_evidence_bound_exceeded' });
	});
});
