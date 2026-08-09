import { describe,expect,it } from 'vitest';
import { listCapacityWorkdayContentArtifactRefs,resolveCapacityWorkdayAssignmentIntent } from '../../../../../src/api/capacity/services/capacity/workdays/assignments/workday-assignment-context-service.ts';

describe('workday assignment artifact handoff', () => {
	it('discovers canonical content from the completed assignment lifecycle', async () => {
		const lifecycle = { artifactManifest: { contentReferences: [{ model: 'proposal', contentPath: 'src/content/proposals/cohort.mdx', artifactKind: 'planning_proposal', subjectId: 'core', producedByAgent: 'guide-steward', commitSha: 'abc123' }] } };
		const store = { all: async (query: string) => {
			expect(query).toContain('assignment.lifecycle_output_json');
			expect(query).toContain("assignment.status = 'completed'");
			return [{ id: 'assignment-1', outputs_json: JSON.stringify(lifecycle) }];
		} };
		const refs = await listCapacityWorkdayContentArtifactRefs(store as never, { id: 'run-1', teamId: 'team-1' } as never, 'project-1');
		expect(refs).toEqual([expect.objectContaining({ model: 'proposal', contentPath: 'src/content/proposals/cohort.mdx', artifactKind: 'planning_proposal' })]);
	});

	it('delivers required upstream artifacts and immutable refs to the next planning profile', async () => {
		const lifecycle = { artifactManifest: { contentReferences: [{
			model: 'note', contentPath: 'src/content/notes/editorial/evidence.mdx', artifactKind: 'planning_note',
			subjectId: 'guide-objective', producedByAgent: 'evidence-researcher', commitSha: 'evidence-commit',
		}] } };
		const store = { all: async () => [{ id: 'assignment-1', outputs_json: JSON.stringify(lifecycle) }] };
		const intent = await resolveCapacityWorkdayAssignmentIntent(
			store as never,
			{ id: 'run-1', teamId: 'team-1', scenarioId: 'editorial synthesis', parameters: { objectiveRefs: ['objective:guide-objective'] } } as never,
			{ id: 'project-1' } as never,
			{
				slug: 'guide-steward', activityType: 'planning', handler: 'writer', projectAgentClassId: 'class-1',
				projectAgentClassSlug: 'editorial', purpose: 'Author a proposal.', promptTask: 'proposal', planningIntent: { includeWorkdayArtifacts: true },
				branchPolicy: {}, contentAccess: {}, outputContract: {}, inputContract: { artifactContracts: ['planning-note'] },
				planningPriority: 1, planningAllocationPercent: null, contentPath: null,
			},
		);
		expect(intent).toMatchObject({
			subjectId: 'guide-objective',
			relatedArtifacts: [{ contentPath: 'src/content/notes/editorial/evidence.mdx', commitSha: 'evidence-commit', artifactKind: 'planning_note' }],
		});
	});
});
