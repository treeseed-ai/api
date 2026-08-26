import { describe, expect, it } from 'vitest';
import { capacityWorkdayContentRoot } from '../../../../src/api/capacity/services/capacity/workdays/policy/workday-project-policy.ts';

describe('capacity workday project library root', () => {
	it('uses the repository root for a v3 library-backed project', () => {
		expect(capacityWorkdayContentRoot({
			id: 'project-sdk',
			slug: 'sdk',
			metadata: { library: { role: 'library', name: 'sdk-library' } },
		})).toBe('.');
	});

	it('preserves an explicitly configured architecture content path', () => {
		expect(capacityWorkdayContentRoot({
			id: 'project-legacy',
			architecture: { contentPath: 'src/content' },
		})).toBe('src/content');
	});

	it('fails closed when neither a library nor content path is configured', () => {
		expect(() => capacityWorkdayContentRoot({ id: 'project-missing', slug: 'missing' }))
			.toThrowError(/has no configured content path/u);
	});
});
