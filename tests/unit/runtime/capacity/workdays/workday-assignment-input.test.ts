import { describe,expect,it } from 'vitest';
import { compilePlanningAssignmentInput,resolveAssignmentContentBaseRef } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-function.ts';

describe('workday assignment input', () => {
	it('projects the complete resolved intent into the handler payload', () => {
		const relatedArtifacts = [{
			model: 'note', contentPath: 'src/content/notes/editorial/plan.mdx',
			commitSha: 'commit-a', artifactKind: 'planning_note',
		}];
		expect(compilePlanningAssignmentInput({
			intent: { stale: 'nested copy remains forensic' }, planningSource: 'configured-idle-intent',
		}, {
			objective: 'Review the preceding planning artifact.', artifactKind: 'review_note',
			subjectModel: 'objective', subjectId: 'core', subjectPath: 'src/content/objectives/core.md',
			includeWorkdayArtifacts: true, relatedArtifacts,
		}, 'reviewing')).toMatchObject({
			activityType: 'reviewing', objective: 'Review the preceding planning artifact.', artifactKind: 'review_note',
			subjectModel: 'objective', subjectId: 'core', subjectPath: 'src/content/objectives/core.md',
			includeWorkdayArtifacts: true, relatedArtifacts,
		});
	});

	it('advances sequential workday assignments from the newest durable artifact commit', () => {
		expect(resolveAssignmentContentBaseRef({
			contentBaseRef: 'refs/heads/main',
			intent: { relatedArtifacts: [
				{ contentPath: 'src/content/notes/latest.mdx', commitSha: 'commit-latest' },
				{ contentPath: 'src/content/notes/older.mdx', commitSha: 'commit-older' },
			] },
		})).toBe('commit-latest');
	});
});
