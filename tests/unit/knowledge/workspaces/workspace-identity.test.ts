import { describe, expect, it } from 'vitest';
import { treeDxWorkspaceId } from '../../../../src/api/knowledge/workspaces/identity.ts';

describe('knowledge workspace identity', () => {
	it('maps an API idempotency identifier into the TreeDX workspace namespace', () => {
		expect(treeDxWorkspaceId('5244394a-8390-4f45-a731-fefb380b1a8d'))
			.toBe('ws_5244394a-8390-4f45-a731-fefb380b1a8d');
	});
});
