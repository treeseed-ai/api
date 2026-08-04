import { describe,expect,it } from 'vitest';
import { workdayPlanningStageReady,workdayProfileStageReady,workdayReportingStageReady } from '../../../../../src/api/capacity/services/build/demand-compiler.ts';

describe('workday activity-profile stage policy', () => {
	it('opens configured profiles only after the nearest prior profile completes', () => {
		const configured = ['planning', 'estimating', 'reviewing', 'reporting'];
		expect(workdayProfileStageReady('planning', configured, [])).toBe(true);
		expect(workdayProfileStageReady('estimating', configured, [])).toBe(false);
		expect(workdayProfileStageReady('estimating', configured, ['planning'])).toBe(true);
		expect(workdayProfileStageReady('reviewing', configured, ['planning'])).toBe(false);
		expect(workdayProfileStageReady('reviewing', configured, ['planning', 'estimating'])).toBe(true);
		expect(workdayProfileStageReady('reporting', configured, ['planning', 'estimating'])).toBe(false);
	});

	it('skips profiles an agent does not configure', () => {
		expect(workdayProfileStageReady('reviewing', ['planning', 'reviewing'], [])).toBe(false);
		expect(workdayProfileStageReady('reviewing', ['planning', 'reviewing'], ['planning'])).toBe(true);
		expect(workdayProfileStageReady('reporting', ['reporting'], [])).toBe(true);
	});

	it('finishes discovery and synthesis before evaluation work begins', () => {
		const entries = [
			{ status: 'completed', metadata: { agentId: 'researcher', activityType: 'planning', planningStage: 'discovery' } },
			{ status: 'pending', metadata: { agentId: 'writer', activityType: 'planning', planningStage: 'discovery' } },
			{ status: 'pending', metadata: { agentId: 'steward', activityType: 'planning', planningStage: 'synthesis' } },
			{ status: 'pending', metadata: { agentId: 'steward', activityType: 'estimating', planningStage: 'evaluation' } },
		];
		expect(workdayPlanningStageReady('discovery', entries)).toBe(true);
		expect(workdayPlanningStageReady('synthesis', entries)).toBe(false);
		expect(workdayPlanningStageReady('evaluation', entries.map((entry) => ({ ...entry, status: ['discovery','synthesis'].includes(entry.metadata.planningStage) ? 'completed' : entry.status })))).toBe(true);
	});

	it('holds reporting until every earlier profile and acting demand is terminal', () => {
		const entries = [
			{ status: 'completed', metadata: { activityType: 'planning' } },
			{ status: 'completed', metadata: { activityType: 'reviewing' } },
			{ status: 'pending', metadata: { activityType: 'reporting' } },
		];
		expect(workdayReportingStageReady('reporting', entries, true)).toBe(false);
		expect(workdayReportingStageReady('reporting', entries, false)).toBe(true);
		expect(workdayReportingStageReady('reporting', [{ ...entries[1]!, status: 'assigned' }, entries[2]!], false)).toBe(false);
	});
});
