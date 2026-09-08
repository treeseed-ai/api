import { describe, expect, it } from 'vitest';
import { acceptedLibraryRevision } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-scheduling-service.ts';

describe('chat and workday frozen library revision', () => {
	it('uses the seed-accepted exact commit rather than the moving remote tracking ref', () => {
		expect(acceptedLibraryRevision({ contentRepositoryRef: 'refs/remotes/origin/staging', metadata: { resolvedRef: 'a'.repeat(40) } }, 'sdk')).toBe('a'.repeat(40));
	});
	it('accepts an explicitly pinned binding', () => {
		expect(acceptedLibraryRevision({ contentRepositoryRef: 'b'.repeat(40) }, 'sdk')).toBe('b'.repeat(40));
	});
	it.each(['staging', 'refs/remotes/origin/staging', 'repo-sdk', ''])('rejects unresolved %j before delegation', (contentRepositoryRef) => {
		expect(() => acceptedLibraryRevision({ contentRepositoryRef }, 'sdk')).toThrow('exact commit');
	});
});
