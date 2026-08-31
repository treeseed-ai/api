import { describe, expect, it } from 'vitest';
import { normalizeStoredTimestamp } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';

describe('provider assignment timestamps', () => {
	it('normalizes database Date values before returning communication receipts', () => {
		expect(normalizeStoredTimestamp(new Date('2026-08-31T05:00:00.123Z'))).toBe('2026-08-31T05:00:00.123Z');
		expect(normalizeStoredTimestamp('2026-08-31 05:00:00.123+00')).toBe('2026-08-31T05:00:00.123Z');
		expect(normalizeStoredTimestamp(null)).toBe('');
	});
});
