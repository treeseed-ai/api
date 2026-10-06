import { describe, expect, it } from 'vitest';
import { discussionInvocationProvenance } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';

describe('provider discussion response provenance', () => {
	it('resolves discussion identity from the authoritative invocation metadata', () => {
		expect(discussionInvocationProvenance({
			metadata_json: JSON.stringify({
				discussionId: 'discussion-1',
				sourceMessageId: 'message-1',
				communication: { sendId: 'send-1' },
			}),
		})).toEqual({
			metadata: {
				discussionId: 'discussion-1',
				sourceMessageId: 'message-1',
				communication: { sendId: 'send-1' },
			},
			discussionId: 'discussion-1',
			sourceMessageId: 'message-1',
		});
	});
});
