import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoveryAssignment } from './cancellation-fixture.ts';
const connection = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('../../../../../../src/api/capacity/services/capacity/workdays/treedx/workday-treedx-connection.ts', () => ({
	resolveWorkdayTreeDxConnection: vi.fn(async () => ({ client: { closeWorkspace: connection.close } })),
}));
import { closeTerminalAssignmentWorkspace, terminalWorkspaceAlreadyAbsent } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-terminal-workspace.ts';
beforeEach(() => connection.close.mockReset());
const store = { config: {}, getProjectTreeDxLibrary: async () => null };
describe('terminal workspace cleanup requires exact resource closure authority', () => {
	it('does not treat denied or unidentified upstream 404 errors as confirmed workspace absence', () => {
		const absent = Object.assign(new Error('Workspace not found.'), { status: 404, code: 'not_found' });
		expect(terminalWorkspaceAlreadyAbsent(absent)).toBe(true);
		const errors = [Object.assign(new Error('denied'), { status: 403, code: 'permission_denied' }),
			Object.assign(new Error('denied'), { status: 404, code: 'permission_denied' }),
			Object.assign(new Error('unidentified route'), { status: 404 }), { status: 404, code: 'not_found' }, new Error('network')];
		expect(errors.map(terminalWorkspaceAlreadyAbsent)).toEqual(errors.map(() => false));
	});
	it('requires no remote closure for an assignment that owns no TreeDX workspace', async () => {
		const assignment = recoveryAssignment(false), before = structuredClone(assignment);
		expect(await closeTerminalAssignmentWorkspace(store, assignment)).toEqual({ required: false, closed: true, workspaceId: null });
		expect(connection.close).not.toHaveBeenCalled(); expect(assignment).toEqual(before);
	});
	it('rejects missing mismatched or still-open close responses while retaining exact closed replay authority', async () => {
		const assignment = { ...recoveryAssignment(false), workspaceContext: { workspaceId: 'ws_terminalfixture', repositoryId: 'repository' } };
		const before = structuredClone(assignment), admitted: number[] = [];
		const responses = [undefined, {}, { workspaceId: 'ws_otherfixture', status: 'closed' },
			{ workspaceId: 'ws_terminalfixture', status: 'open' }];
		for (const [index, response] of responses.entries()) {
			connection.close.mockResolvedValue(response);
			try { await closeTerminalAssignmentWorkspace(store, assignment); admitted.push(index); } catch { /* fail closed */ }
		}
		connection.close.mockResolvedValue({ workspaceId: 'ws_terminalfixture', status: 'closed' });
		expect(await closeTerminalAssignmentWorkspace(store, assignment)).toEqual({ required: true, closed: true, workspaceId: 'ws_terminalfixture' });
		expect(assignment).toEqual(before);
		expect(admitted).toEqual([]);
	});
});
