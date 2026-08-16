import { describe,expect,it,vi } from 'vitest';
import { terminalizeCapacityWorkdayEnvelopes } from '../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-envelope-terminalization-service.ts';
import { compileCooperativePlanningSession,currentCooperativePlanningWave,initializeCooperativePlanningSession } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/cooperative-planning-session-service.ts';
import { recordCapacityWorkdayScheduleFailure } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-scheduling-service.ts';

describe('workday scheduling recovery', () => {
	it('terminalizes envelopes by exact durable run ownership instead of id prefix', async () => {
		const all = vi.fn()
			.mockResolvedValueOnce([{ id: 'arbitrary-envelope-a' }, { id: 'arbitrary-envelope-b' }])
			.mockResolvedValueOnce([]);
		const updateWorkdayCapacityEnvelopeState = vi.fn(async (id: string, status: string) => ({ id, status }));
		await expect(terminalizeCapacityWorkdayEnvelopes({
			all, updateWorkdayCapacityEnvelopeState,
		} as never, 'team-a', 'run-a', 'failed')).resolves.toEqual({ terminalized: 2 });
		expect(all.mock.calls[0]?.[0]).toContain('workday_run_id = ?');
		expect(all.mock.calls[0]?.[1]?.slice(0, 2)).toEqual(['team-a', 'run-a']);
		expect(updateWorkdayCapacityEnvelopeState.mock.calls).toEqual([
			['arbitrary-envelope-a', 'failed'], ['arbitrary-envelope-b', 'failed'],
		]);
	});

	it('propagates envelope storage failure and rejects an unconfirmed transition', async () => {
		const storageFailure = new Error('envelope storage unavailable');
		await expect(terminalizeCapacityWorkdayEnvelopes({
			all: vi.fn(async () => { throw storageFailure; }),
		} as never, 'team-a', 'run-a', 'failed')).rejects.toBe(storageFailure);
		await expect(terminalizeCapacityWorkdayEnvelopes({
			all: vi.fn().mockResolvedValueOnce([{ id: 'envelope-a' }]),
			updateWorkdayCapacityEnvelopeState: vi.fn(async () => null),
		} as never, 'team-a', 'run-a', 'failed'))
			.rejects.toMatchObject({ code: 'capacity_workday_envelope_terminalization_failed' });
	});

	it('attempts every required recovery record and reports incomplete evidence', async () => {
		const createCapacityWorkdayEvent = vi.fn(async () => ({ id: 'event-a' }));
		const updateCapacityWorkdayRun = vi.fn(async () => ({ id: 'run-a', status: 'failed' }));
		await expect(recordCapacityWorkdayScheduleFailure({
			terminalizeCapacityWorkdayEnvelopes: vi.fn(async () => { throw new Error('envelope update failed'); }),
			createCapacityWorkdayEvent,
			updateCapacityWorkdayRun,
		} as never, { teamId: 'team-a', id: 'run-a' }, Object.assign(new Error('policy missing'), { code: 'policy_missing' })))
			.rejects.toMatchObject({
				code: 'capacity_workday_schedule_recovery_incomplete',
				details: { schedulingFailure: { code: 'policy_missing' }, recoveryFailures: [{ owner: 'envelopes' }] },
			});
		expect(createCapacityWorkdayEvent).toHaveBeenCalledOnce();
		expect(updateCapacityWorkdayRun).toHaveBeenCalledOnce();
	});

	it('rejects selected participants that compile into no executable wave', async () => {
		const run = vi.fn();
		await expect(initializeCooperativePlanningSession({
			database: { run } as never,
			teamId: 'team-a', runId: 'run-a', sessionId: 'session-a', rounds: 1,
			maxConcurrentAssignments: 1, allocatedSeconds: 900, now: '2026-08-12T00:00:00Z',
			snapshots: new Map([['project-a', {
				revision: 'revision-a',
				graph: { nodes: [], edges: [], externalRoots: [], diagnostics: [], ok: true },
				agents: [{ nodeId: 'writer:planning:discovery', slug: 'writer', activityType: 'planning',
					projectAgentClassId: 'writer', execution: { maxRuntimeSeconds: 300 } }],
			}]]),
		})).rejects.toMatchObject({
			code: 'capacity_planning_session_wave_empty',
			details: {
				participantNodeIds: ['project-a:writer:planning:discovery'],
				graphNodeIds: [],
			},
		});
		expect(run).not.toHaveBeenCalled();
	});

	it('preflights a cooperative graph without persisting participants or waves', () => {
		const result = compileCooperativePlanningSession({
			rounds: 1, maxConcurrentAssignments: 1, allocatedSeconds: 900,
			snapshots: new Map([['project-a', {
				revision: 'revision-a',
				graph: { nodes: [{ id: 'writer:planning', agentId: 'writer', activityType: 'planning', stage: null, produces: [], requires: [] }], edges: [], externalRoots: [], diagnostics: [], ok: true },
				agents: [{ nodeId: 'writer:planning', slug: 'writer', activityType: 'planning', projectAgentClassId: 'class-writer', execution: { maxRuntimeSeconds: 300 } }],
			}]]),
		});
		expect(result.participants).toEqual([expect.objectContaining({ nodeId: 'project-a:writer:planning', timeboxSeconds: 300 })]);
		expect(result.compiled).toMatchObject({ fits: true, requiredSeconds: 300 });
		expect(result.compiled.waves).toHaveLength(1);
	});

	it('does not terminalize a planning session before its atomic initialization fence', async () => {
		const run = vi.fn();
		const first = vi.fn()
			.mockResolvedValueOnce({ id: 'session-a', status: 'running', metadata_json: '{}' })
			.mockResolvedValueOnce(null);
		await expect(currentCooperativePlanningWave({ first, run } as never, 'run-a', '2026-08-12T00:00:01Z')).resolves.toBeNull();
		expect(run).not.toHaveBeenCalled();
	});

	it('reopens an interrupted completed session and admits its scheduled wave once', async () => {
		const session = { id: 'session-a', status: 'completed', metadata_json: JSON.stringify({
			planningInitialized: true,
			waves: [{ round: 1, wave: 1, participantNodeIds: ['project-a:writer:chat'] }],
		}) };
		const wave = { id: 'wave-a', session_id: 'session-a', status: 'scheduled', round: 1, wave: 1, snapshot_ref: 'unresolved', snapshot_json: '{}' };
		const first = vi.fn(async (query: string) => {
			if (query.includes('FROM workday_planning_sessions')) return session;
			if (query.includes("status IN ('running','scheduled')")) return wave;
			if (query.includes('snapshot_ref <>')) return null;
			return null;
		});
		const run = vi.fn();
		const result = await currentCooperativePlanningWave({ first, run, all: vi.fn(async () => []) } as never, 'run-a', '2026-08-12T00:00:02Z');
		expect(result).toMatchObject({ id: 'wave-a', round: 1, nodeIds: ['project-a:writer:chat'] });
		expect(run.mock.calls.filter(([query]) => String(query).includes("SET status = 'running',completed_at = NULL"))).toHaveLength(1);
		expect(run.mock.calls.filter(([query]) => String(query).includes("workday_planning_waves SET status = 'running'"))).toHaveLength(1);
	});
});
