import { describe, expect, it } from 'vitest';
import { capacityWorkdayContentRoot, resolveCapacityWorkdayProjects } from '../../../../src/api/capacity/services/capacity/workdays/policy/workday-project-policy.ts';

describe('capacity workday project library root', () => {
	const projects = [{ id: '8cbfb810-6da5-4da2-9ae9-cad53101253f', slug: 'sdk' }, { id: 'project-api', slug: 'api' }];

	it('resolves the canonical project identity supplied by the CLI', () => {
		expect(resolveCapacityWorkdayProjects([projects[0].id], projects)).toEqual([projects[0]]);
	});

	it('keeps a slug as a human-facing project selector', () => {
		expect(resolveCapacityWorkdayProjects(['api'], projects)).toEqual([projects[1]]);
	});

	it('rejects selecting one project through both its ID and slug', () => {
		expect(() => resolveCapacityWorkdayProjects([projects[0].id, 'sdk'], projects)).toThrowError(/same project more than once/u);
	});

	it('rejects a missing project rather than broadening scope', () => {
		expect(() => resolveCapacityWorkdayProjects(['unknown-project'], projects)).toThrowError(/no longer available/u);
	});

	it('rejects an identity collision with another project slug', () => {
		expect(() => resolveCapacityWorkdayProjects(['sdk'], [projects[0], { id: 'other', slug: projects[0].id }])).toThrowError(/ambiguous/u);
	});
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
