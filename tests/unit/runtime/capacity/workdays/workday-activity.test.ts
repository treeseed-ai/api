import { describe, expect, it } from 'vitest';
import { filterWorkdayActivity, projectWorkdayActivity, redactTranscriptValue } from '../../../../../src/api/capacity/routes/support/workday-activity.ts';
import { modeRunActivityEvent } from '../../../../../src/api/capacity/services/capacity/workdays/content/mode-run-activity-event.ts';

const event = {
	id: 'activity:mode-a', runId: 'workday-a', teamId: 'team-a', projectId: 'project-a', workdayId: 'workday-a',
	assignmentId: 'assignment-a', modeRunId: 'mode-a', eventIndex: 4, eventType: 'item.completed', status: 'recorded' as const,
	title: 'agent_message', message: 'Draft complete.', parameters: {},
	context: { agentId: 'writer', agentClassId: 'guide-writing', handlerId: 'writer', executionRunId: 'run-a' },
	refs: { transcriptRef: 'mode-run://mode-a', artifacts: [{ kind: 'knowledge-page' }] },
	metadata: { severity: 'info', sourceEventId: 'codex:item-a', redactionStatus: 'sanitized', payloadDigest: 'digest-a' },
	createdAt: '2026-08-02T12:00:00.000Z',
};

describe('workday activity projection', () => {
	it('projects stable compact events and applies durable cursor filters', () => {
		expect(projectWorkdayActivity(event)).toMatchObject({ sequence: 4, agentId: 'writer', summary: 'Draft complete.', transcriptRef: 'mode-run://mode-a' });
		expect(filterWorkdayActivity([event], { after: 3, agent: 'writer' })).toHaveLength(1);
		expect(filterWorkdayActivity([event], { after: 4 })).toHaveLength(0);
	});

	it('normalizes absent URL query values before Zod validation', () => {
		expect(filterWorkdayActivity([event], {
			after: 3,
			agent: null,
			agentClass: null,
			type: null,
			severity: null,
		})).toHaveLength(1);
	});

	it('redacts nested forensic JSON before returning transcripts', () => {
		const value = redactTranscriptValue({ outputs_json: JSON.stringify({ accessToken: 'secret', safe: 'visible' }) });
		expect(value).toEqual({ outputs_json: { accessToken: '<redacted>', safe: 'visible' } });
	});

	it('binds append-only telemetry identity to runner-specific durable evidence', () => {
		const assignment = { id: 'assignment-a', projectId: 'project-a', workDayId: 'workday-a', runnerId: 'runner-a' };
		const modeRun = {
			id: 'telemetry:assignment-a:leased', status: 'running', createdAt: '2026-08-15T12:00:00.000Z',
			outputs: { status: 'preparing', summary: 'Assignment leased.' },
			metadata: { telemetryEventId: 'leased:preparing', runnerId: 'runner-a' },
		};
		const first = modeRunActivityEvent({ assignment, modeRun });
		const replay = modeRunActivityEvent({ assignment, modeRun });
		const recovered = modeRunActivityEvent({ assignment, modeRun: { ...modeRun, metadata: { ...modeRun.metadata, runnerId: 'runner-b' } } });
		expect(replay.id).toBe(first.id);
		expect(recovered.id).not.toBe(first.id);
	});
});
