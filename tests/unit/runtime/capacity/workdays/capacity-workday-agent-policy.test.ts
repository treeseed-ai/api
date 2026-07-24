import { describe, expect, it } from 'vitest';
import {
	capacityWorkdayAgentsFromClasses,
	compileCapacityWorkdayAssignmentIntent,
} from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-policy.ts';

describe('capacity workday agent policy', () => {
	it('uses configured planning profile refs without slug-based behavior', () => {
		const agents = capacityWorkdayAgentsFromClasses([{
			id: 'research',
			slug: 'research',
			handlerRefs: {
				agents: [{
					slug: 'custom-investigator',
					activities: { planning: {
						handler: 'writer',
						prompt: { task: 'planning' },
						outputs: { modelMutations: ['linked_note:create'] },
						planningIntent: { objective: 'Investigate the highest-value unanswered project question.' },
						planningPriority: 20,
					} },
				}],
			},
		}]);
		expect(agents).toHaveLength(1);
		expect(compileCapacityWorkdayAssignmentIntent(agents[0])).toEqual({
			objective: 'Investigate the highest-value unanswered project question.',
			artifactKind: 'planning_note',
			subjectModel: 'objective',
			subjectId: 'core',
			includeWorkdayArtifacts: false,
		});
	});

	it('rejects stale removed handler refs and honors explicit intent', () => {
		const agents = capacityWorkdayAgentsFromClasses([{
			id: 'planning',
			slug: 'planning',
			handlerRefs: {
				agents: [
					{ slug: 'legacy', activities: { planning: { handler: 'plan' } } },
					{
						slug: 'configured',
						activities: { planning: {
							handler: 'writer',
							purpose: 'Configured purpose.',
							outputs: { modelMutations: ['linked_note:create'] },
							planningIntent: {
								objective: 'Answer a configured research question.',
								artifactKind: 'question_answer',
								subjectModel: 'question',
								subjectId: 'question-1',
							},
						} },
					},
				],
			},
		}]);
		expect(agents.map((agent) => agent.slug)).toEqual(['configured']);
		expect(compileCapacityWorkdayAssignmentIntent(agents[0])).toMatchObject({
			objective: 'Answer a configured research question.',
			artifactKind: 'question_answer',
			subjectModel: 'question',
			subjectId: 'question-1',
		});
	});

	it('runs configured reporting activity under planning capacity with workday evidence', () => {
		const [reporter] = capacityWorkdayAgentsFromClasses([{
			id: 'reporting',
			slug: 'reporting',
			handlerRefs: {
				agents: [{
					slug: 'reporter',
					activities: { reporting: {
						handler: 'reporter',
						purpose: 'Summarize governed workday evidence.',
						outputs: { modelMutations: ['workday_report:create'] },
					} },
				}],
			},
		}]);
		expect(reporter.activityType).toBe('reporting');
		expect(compileCapacityWorkdayAssignmentIntent(reporter)).toMatchObject({
			artifactKind: 'workday_summary',
			includeWorkdayArtifacts: true,
		});
	});

	it('excludes inactive and acting-only classes from planning participation', () => {
		expect(capacityWorkdayAgentsFromClasses([
			{ id: 'acting', status: 'active', allowedModes: ['acting'], handlerRefs: { agents: [{ slug: 'engineer', activities: { acting: { handler: 'actor' } } }] } },
			{ id: 'paused', status: 'paused', allowedModes: ['planning'], handlerRefs: { agents: [{ slug: 'writer', activities: { planning: { handler: 'writer' } } }] } },
		])).toEqual([]);
	});
});
