import { describe,expect,it } from 'vitest';
import { listCapacityWorkdayContentArtifactRefs } from '../../../../../src/api/capacity/services/capacity/workdays/assignments/workday-assignment-context-service.ts';

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
});
