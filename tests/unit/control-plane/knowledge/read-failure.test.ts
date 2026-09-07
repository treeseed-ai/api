import { expect, it } from 'vitest';
import { knowledgeReadFailure } from '../../../../src/api/control-plane/knowledge/knowledge-operation-error.ts';

it('exposes fixed upstream diagnostics without private error material', () => {
	const error = knowledgeReadFailure('knowledge_graph_unavailable', 'Knowledge unavailable.', {
		code: 'graph_not_ready', message: 'private credential', payload: { token: 'private credential' },
	});
	expect(error.message).toBe('Knowledge unavailable. (TreeDX: graph_not_ready)');
	expect(JSON.stringify(error)).not.toContain('private credential');
	expect(knowledgeReadFailure('knowledge_graph_unavailable', 'Knowledge unavailable.', {
		code: 'private credential', message: 'private credential',
	}).message).toBe('Knowledge unavailable. (TreeDX: unexpected_response)');
});
