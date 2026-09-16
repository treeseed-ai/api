import { describe, expect, it } from 'vitest';
import { executionNodeRunScope } from '../../../../../../src/api/capacity/services/build/ready-execution-node.ts';

describe('living execution run scope', () => {
	it('keeps communication nodes on their exact hidden conversation run', () => {
		const conversation = { id: 'conversation-1', executionKind: 'conversation' } as const;
		expect(executionNodeRunScope(conversation as never)).toEqual({
			sql: `node.kind='communication' AND node.workday_id=?`, parameters: ['conversation-1'],
		});
	});

	it('keeps ordinary work and run-owned planning off conversation runs', () => {
		const workday = { id: 'workday-1', executionKind: 'workday', parameters: {} } as const;
		expect(executionNodeRunScope(workday as never)).toEqual({
			sql: `node.kind<>'communication' AND (node.workday_id IS NULL OR node.workday_id=?)`, parameters: ['workday-1'],
		});
	});

	it('limits planning-only runs to their own cooperative planning and reporting nodes', () => {
		const workday = { id: 'workday-1', executionKind: 'workday', parameters: { planningOnly: true } } as const;
		expect(executionNodeRunScope(workday as never)).toEqual({
			sql: `node.workday_id=? AND node.kind IN ('planning','estimating','reporting')`, parameters: ['workday-1'],
		});
	});
});
