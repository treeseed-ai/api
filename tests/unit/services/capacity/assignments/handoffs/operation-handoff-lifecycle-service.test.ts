import { describe,expect,it,vi } from 'vitest';
import {
	approvedOperationHandoffForWorkUnit,
	bindOperationHandoffAssignment,
	markOperationHandoffRunning,
	terminalizeOperationHandoff,
} from '../../../../../../src/api/capacity/services/capacity/assignments/handoffs/operation-handoff-lifecycle-service.ts';

function database(rows: Record<string,unknown>[] = []) {
	return {
		all: vi.fn().mockResolvedValue(rows), first: vi.fn().mockResolvedValue(rows[0] ?? null),
		run: vi.fn().mockResolvedValue(undefined), batch: vi.fn(), ensureInitialized: vi.fn(),
	};
}

describe('operation handoff lifecycle', () => {
	it('matches only an exact approved decision work unit', async () => {
		const store=database([{id:'handoff-a',discussion_id:'discussion-a',proposal_id:'proposal-a',inputs_json:JSON.stringify({workGraphNodeId:'node-a'}),source_message_refs_json:JSON.stringify(['message-a'])}]);
		await expect(approvedOperationHandoffForWorkUnit(store as never,{teamId:'team-a',projectId:'project-a',decisionId:'decision-a',proposalId:'proposal-a',workUnitId:'unit-a',workGraphNodeId:'node-a'})).resolves.toEqual({id:'handoff-a',discussionId:'discussion-a',sourceMessageRefs:['message-a']});
		await expect(approvedOperationHandoffForWorkUnit(store as never,{teamId:'team-a',projectId:'project-a',decisionId:'decision-a',proposalId:'proposal-a',workUnitId:'unit-b',workGraphNodeId:'node-b'})).resolves.toBeNull();
	});

	it('rejects ambiguous approved handoffs instead of choosing ambient latest', async () => {
		const row={discussion_id:'discussion-a',proposal_id:'proposal-a',inputs_json:JSON.stringify({workUnitId:'unit-a'}),source_message_refs_json:'[]'};
		const store=database([{...row,id:'handoff-a'},{...row,id:'handoff-b'}]);
		await expect(approvedOperationHandoffForWorkUnit(store as never,{teamId:'team-a',projectId:'project-a',decisionId:'decision-a',proposalId:'proposal-a',workUnitId:'unit-a',workGraphNodeId:'node-a'})).rejects.toMatchObject({code:'operation_handoff_work_unit_ambiguous'});
	});

	it('binds and advances the same resulting assignment idempotently', async () => {
		const store=database([{id:'handoff-a',team_id:'team-a',project_id:'project-a',discussion_id:'discussion-a',target:'fixture',source_message_refs_json:'[]',resulting_assignment_id:null}]);
		await bindOperationHandoffAssignment(store as never,'handoff-a','assignment-a','decision-a','2026-08-15T00:00:00.000Z');
		await markOperationHandoffRunning(store as never,'handoff-a','assignment-a','2026-08-15T00:01:00.000Z');
		await terminalizeOperationHandoff(store as never,'handoff-a','assignment-a','completed','2026-08-15T00:02:00.000Z');
		expect(store.run.mock.calls.map(([query])=>String(query))).toEqual(expect.arrayContaining([
			expect.stringContaining("status='scheduled'"),expect.stringContaining("status='running'"),expect.stringContaining('SET status=?'),
		]));
	});

	it('rejects rebinding an approved handoff to another assignment', async () => {
		const store=database([{id:'handoff-a',resulting_assignment_id:'assignment-existing'}]);
		await expect(bindOperationHandoffAssignment(store as never,'handoff-a','assignment-new','decision-a','2026-08-15T00:00:00.000Z')).rejects.toMatchObject({code:'operation_handoff_assignment_conflict'});
	});
});
