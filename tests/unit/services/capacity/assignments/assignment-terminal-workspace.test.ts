import { describe,expect,it } from 'vitest';
import { TreeDxApiError } from '@treeseed/sdk/treedx';
import { terminalWorkspaceAlreadyAbsent } from '../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-terminal-workspace.ts';

describe('terminal assignment workspace cleanup',()=>{
	it('treats an already absent TreeDX workspace as an idempotent close',()=>{
		expect(terminalWorkspaceAlreadyAbsent(new TreeDxApiError('Workspace not found.',{ status:404 }))).toBe(true);
		expect(terminalWorkspaceAlreadyAbsent(new TreeDxApiError('Permission denied.',{ status:403 }))).toBe(false);
	});
});
