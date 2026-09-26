import { describe, expect, it } from 'vitest';
import { executionNodeRunScope } from '../../../../../../src/api/capacity/services/build/ready-execution-node.ts';

describe('living execution run scope', () => {
	it('loads only its Reporter during closing, before resolving any other node context', () => {
		const workday = { id: 'workday-1', executionKind: 'workday', parameters: {
			appliedPlan: { state: 'closing' }, planningOnly: true, proposalIds: ['proposal-1'],
		} } as const;
		expect(executionNodeRunScope(workday as never)).toEqual({
			sql: `node.kind='reporting' AND node.workday_id=?`, parameters: ['workday-1'],
		});
	});
	it('keeps communication nodes on their exact hidden conversation run', () => {
		const conversation = { id: 'conversation-1', executionKind: 'conversation' } as const;
		expect(executionNodeRunScope(conversation as never)).toEqual({
			sql: `node.kind='communication' AND node.workday_id=?`, parameters: ['conversation-1'],
		});
	});

	it('admits workday-owned communication without adopting unrelated conversations or proposal reviews', () => {
		const workday = { id: 'workday-1', executionKind: 'workday', parameters: {} } as const;
		expect(executionNodeRunScope(workday as never)).toEqual({
			sql: `(node.workday_id=? OR (node.workday_id IS NULL AND node.kind<>'communication'
		AND NOT (node.kind='reviewing' AND node.pair_role IS NULL AND node.source_ref_json::jsonb->>'model'='proposal')))`,
			parameters: ['workday-1'],
		});
	});

	it('allows addressed communication during planning-only execution', () => {
		const workday = { id: 'workday-1', executionKind: 'workday', parameters: { planningOnly: true } } as const;
		expect(executionNodeRunScope(workday as never)).toEqual({
			sql: `node.workday_id=? AND node.kind IN ('planning','estimating','communication','reporting')`, parameters: ['workday-1'],
		});
	});

	it('admits only the selected proposal governance review during planning-only execution', () => {
		const workday = { id: 'workday-1', executionKind: 'workday', parameters: {
			planningOnly: true, proposalIds: ['proposal-1'],
		} } as const;
		const scope = executionNodeRunScope(workday as never);
		expect(scope.parameters).toEqual(['workday-1', 'proposal-1']);
		expect(scope.sql).toContain("node.kind='reviewing'");
		expect(scope.sql).toContain("node.source_ref_json::jsonb->>'id' IN (?)");
	});
});
