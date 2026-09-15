import { describe, expect, it } from 'vitest';
import { resolveAssignmentContentBaseRef } from '../../../../../src/api/capacity/services/capacity/assignments/planning/content-base-ref.ts';
import { actingArtifactKinds } from '../../../../../src/api/capacity/services/support/acting-demand-source.ts';

describe('acting assignment content base ref', () => {
	it('keeps the TreeDX content workspace on its frozen library commit', () => {
		const contentBaseRef = '71cae536e1e7248a2a24e1f20b0c1cc451d816f3';
		expect(resolveAssignmentContentBaseRef({
			contentBaseRef,
			decisionInput: { input: { exactBaseRef: '0b70da01bbac7492ca783054861dbbe5690ea36f' } },
		})).toBe(contentBaseRef);
	});

	it('does not confuse the source repository commit with TreeDX content identity', () => {
		expect(resolveAssignmentContentBaseRef({
			decisionInput: { input: { exactBaseRef: '0b70da01bbac7492ca783054861dbbe5690ea36f' } },
		})).toBe('refs/heads/main');
	});
});

describe('acting source publication', () => {
	it('authorizes a durable source candidate alongside the governed stage output', () => {
		expect(actingArtifactKinds([{ outputType: 'failing_test_proof' }])).toEqual(['source-candidate', 'failing_test_proof']);
	});
});
