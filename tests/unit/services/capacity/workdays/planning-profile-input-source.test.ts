import { describe,expect,it } from 'vitest';
import { resolvePlanningDemandSource } from '../../../../../src/api/capacity/services/support/planning-demand-source.ts';

describe('planning profile input source', () => {
	it('routes a scoped input only to its requested activity profile', async () => {
		const row = { id: 'request-1', decision_id: 'decision-1', prompt: 'Review the page.', scope_hash: 'scope-1', metadata_json: JSON.stringify({ agentId: 'reviewer', activityType: 'reviewing', assignmentInput: { chapter: 'foundation', subjectModel: 'knowledge', subjectId: 'guide.foundation.purpose' } }) };
		const store = { async all(sql: string) { return sql.includes('planning_input_requests') ? [row] : []; }, async first() { return null; } } as never;
		const run = { id: 'run-1', teamId: 'team-1' } as never;
		const project = { id: 'project-1' } as never;
		const base = { slug: 'reviewer', projectAgentClassId: 'class-1', handler: 'writer' } as never;
		const intent = { objective: 'Review.', artifactKind: 'planning_note', subjectModel: 'objective', subjectId: 'core', includeWorkdayArtifacts: true };
		await expect(resolvePlanningDemandSource(store, run, project, { ...base, activityType: 'reviewing' }, intent)).resolves.toMatchObject({
			sourceType: 'planning-input', payload: { chapter: 'foundation', intent: { chapter: 'foundation', subjectModel: 'knowledge', subjectId: 'guide.foundation.purpose' } },
		});
		await expect(resolvePlanningDemandSource(store, run, project, { ...base, activityType: 'planning' }, intent)).resolves.toMatchObject({ sourceType: 'idle-intent' });
	});
});
