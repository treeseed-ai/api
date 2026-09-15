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

	it('rejects a primary-repository content path without a TreeDX library binding', () => {
		expect(() => capacityWorkdayContentRoot({
			id: 'project-primary-content',
			architecture: { contentPath: 'src/content' },
		})).toThrowError(/has no TreeDX library binding/u);
	});

	it('fails closed when neither a library nor content path is configured', () => {
		expect(() => capacityWorkdayContentRoot({ id: 'project-missing', slug: 'missing' }))
			.toThrowError(/has no TreeDX library binding/u);
	});
});
