import { expect, it } from 'vitest';
import { workdayStartDatabase } from '../../../../workdays/scheduling/architecture/workday-start-fixture.ts';
import { closedEstimationFixtureInput } from '../../../../../governance/proposals/architecture/recovery/accepted-unissued-authority-native.ts';
import { recordExecutionNodeObservations } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-node-observations.ts';

it('retains a real closed Workday parent for the native unissued Decision handoff and its public observation', async () => {
	const f = await workdayStartDatabase();
	try {
		const id = await closedEstimationFixtureInput(f.store, 'team', 'project', 'proposal');
		const node = { id: 'unissued-node', teamId: 'team', projectId: 'project', workdayId: id,
			status: 'stale' as const, nodeRevision: 2, graphRevisionUpdated: 1 };
		const next = { ...node, nodeRevision: 3, graphRevisionUpdated: 2 }, now = new Date().toISOString();
		await recordExecutionNodeObservations(f.store, [node], [next], 'controlled-native-handoff', now);
		const rows = await f.all('SELECT * FROM capacity_workday_events WHERE run_id=?', [id]);
		expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ run_id: id, workday_id: id,
			team_id: 'team', project_id: 'project', event_type: 'execution.node.state', status: 'recorded' });
		expect(JSON.parse(String(rows[0]!.context_json))).toEqual({ nodeId: node.id, nodeRevision: 3,
			graphRevision: 2, status: 'stale', previousStatus: 'stale' });
		await recordExecutionNodeObservations(f.store, [node], [next], 'controlled-native-handoff', now);
		expect(await f.all('SELECT * FROM capacity_workday_events WHERE run_id=?', [id])).toEqual(rows);
		expect(await f.first('SELECT status,execution_mode,completed_at FROM capacity_workday_runs WHERE id=?', [id]))
			.toMatchObject({ status: 'failed', execution_mode: 'simulation', completed_at: expect.any(String) });
	} finally { await f.close(); }
});
