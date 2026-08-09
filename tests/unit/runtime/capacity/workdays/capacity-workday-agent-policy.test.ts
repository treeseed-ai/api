import { describe,expect,it } from 'vitest';
import {
capacityWorkdayAgentsFromClasses,
compileCapacityWorkdayAssignmentIntent,
} from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-policy.ts';
import { compileWorkdayPlanningGraphSnapshot,decodeWorkdayPlanningGraphSnapshot } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-planning-graph-policy.ts';

describe('capacity workday agent policy', () => {
	it('uses configured planning profile refs without slug-based behavior', () => {
		const agents = capacityWorkdayAgentsFromClasses([{
			id: 'research',
			slug: 'research',
			handlerRefs: {
				agents: [{
					slug: 'custom-investigator',
					contentPath: 'src/content/agents/editorial/custom-investigator.mdx',
					activities: { planning: {
						handler: 'writer',
						branchPolicy: { kind: 'staging-content', base: 'staging' },
						contentAccess: { write: { paths: ['src/content/notes/editorial/books/guide/**'] } },
						prompt: { task: 'planning' },
						outputs: { modelMutations: ['linked_note:create'] },
						planningIntent: { objective: 'Investigate the highest-value unanswered project question.' },
						planningPriority: 20,
					} },
				}],
			},
		}]);
		expect(agents).toHaveLength(1);
		expect(agents[0].contentPath).toBe('src/content/agents/editorial/custom-investigator.mdx');
		expect(agents[0].branchPolicy).toEqual({ kind: 'staging-content', base: 'staging' });
		expect(agents[0].contentAccess).toEqual({ write: { paths: ['src/content/notes/editorial/books/guide/**'] } });
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

	it('normalizes serialized null proposal subjects for workday artifact handoff', () => {
		const intent = compileCapacityWorkdayAssignmentIntent({
			slug: 'steward', contentPath: null, handler: 'estimate', projectAgentClassId: 'class', projectAgentClassSlug: 'steward',
			purpose: 'Estimate the preceding proposal.', promptTask: 'estimating', outputContract: {},
			planningIntent: { subjectModel: 'proposal', subjectId: 'null', artifactKind: 'agent_estimate' },
			branchPolicy: {}, contentAccess: {}, planningPriority: null, planningAllocationPercent: null, activityType: 'estimating',
		});
		expect(intent.subjectId).toBeNull();
	});

	it('retains every enabled planning-compatible profile for one agent', () => {
		const agents = capacityWorkdayAgentsFromClasses([{
			id: 'review', slug: 'review', allowedModes: ['planning'], handlerRefs: { agents: [{ slug: 'reviewer', activities: {
				planning: { handler: 'writer' }, reviewing: { handler: 'writer' }, reporting: { handler: 'reporter' },
			} }] },
		}]);
		expect(agents.map((agent) => `${agent.slug}:${agent.activityType}`)).toEqual([
			'reviewer:planning', 'reviewer:reporting', 'reviewer:reviewing',
		]);
		expect(compileCapacityWorkdayAssignmentIntent(agents.find((agent) => agent.activityType === 'reviewing')!)).toMatchObject({
			includeWorkdayArtifacts: true,
		});
	});

	it('excludes inactive and acting-only classes from planning participation', () => {
		expect(capacityWorkdayAgentsFromClasses([
			{ id: 'acting', status: 'active', allowedModes: ['acting'], handlerRefs: { agents: [{ slug: 'engineer', activities: { acting: { handler: 'actor' } } }] } },
			{ id: 'paused', status: 'paused', allowedModes: ['planning'], handlerRefs: { agents: [{ slug: 'writer', activities: { planning: { handler: 'writer' } } }] } },
		])).toEqual([]);
	});

	it('applies pinned class and agent selectors after eligibility filtering', () => {
		const classes = [
			{ id: 'project:evidence-research', slug: 'evidence-research', handlerRefs: { agents: [{ slug: 'researcher', activities: { planning: { handler: 'writer' } } }] } },
			{ id: 'project:guide-writing', slug: 'guide-writing', handlerRefs: { agents: [{ slug: 'writer', activities: { planning: { handler: 'writer' } } }] } },
		];
		expect(capacityWorkdayAgentsFromClasses(classes, { classSlugs: ['guide-writing'] }).map((agent) => agent.slug)).toEqual(['writer']);
		expect(capacityWorkdayAgentsFromClasses(classes, { classIds: ['project:evidence-research'], agentSlugs: ['researcher'] }).map((agent) => agent.slug)).toEqual(['researcher']);
		expect(capacityWorkdayAgentsFromClasses(classes, { classSlugs: ['guide-writing'], agentSlugs: ['researcher'], mode: 'intersection' })).toEqual([]);
	});

	it('freezes the selected profile DAG and rejects changed snapshots', () => {
		const snapshot = compileWorkdayPlanningGraphSnapshot([
			{ id: 'research', slug: 'research', handlerRefs: { signalContracts: { 'evidence-ready': {
				schemaVersion: 'treeseed.agent-signal/v1', id: 'evidence-ready', label: 'Evidence ready', description: 'Evidence is ready for synthesis.',
				subjectKinds: ['objective'], allowedOrigins: ['agent-tool'], payloadSchema: {}, commitEvidence: 'required',
				idempotency: 'commit-subject', supersession: 'replace-subject', coalescing: 'latest-subject',
			} }, agents: [{ slug: 'researcher', activities: { planning: {
				handler: 'writer', outputs: { artifactContracts: ['planning-note'] }, signals: { publishes: ['evidence-ready'] },
			} } }] } },
			{ id: 'steward', slug: 'steward', handlerRefs: { agents: [{ slug: 'steward', activities: { planning: {
				handler: 'writer', signals: { subscribesTo: [{ contract: 'evidence-ready', producerPolicy: 'all' }] },
				outputs: { artifactContracts: ['planning-proposal'] },
			} } }] } },
		], {});
		expect(snapshot.graph.edges).toHaveLength(1);
		expect(decodeWorkdayPlanningGraphSnapshot(JSON.parse(JSON.stringify(snapshot)), 'project-a').revision).toBe(snapshot.revision);
		const changed = JSON.parse(JSON.stringify(snapshot));
		changed.agents[0].outputContract.artifactContracts = ['other'];
		expect(() => decodeWorkdayPlanningGraphSnapshot(changed, 'project-a')).toThrowError(expect.objectContaining({ code: 'capacity_workday_planning_graph_snapshot_invalid' }));
	});
});
