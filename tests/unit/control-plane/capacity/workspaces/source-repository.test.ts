import { describe, expect, it } from 'vitest';
import { selectAssignmentSourceRepository } from '../../../../../src/api/capacity/services/capacity/assignments/context/source-repository.ts';
const source = { id: 'source', role: 'software', provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'staging' };
describe('assignment source identity', () => {
	it('selects software independently from the knowledge library', () => {
		expect(selectAssignmentSourceRepository([{ ...source, id: 'library', role: 'library', name: 'project-library' }, source]))
			.toEqual({ id: 'source', provider: 'github', owner: 'fixture', name: 'project', ref: 'staging', cloneUrl: 'https://github.com/fixture/project.git' });
	});
	it('rejects missing or ambiguous source instead of guessing a repository from names', () => {
		for (const entries of [[], [{ ...source, role: 'library' }], [source, { ...source, id: 'other' }]]) {
			expect(() => selectAssignmentSourceRepository(entries)).toThrow('exactly one');
		}
	});
	it('never adopts arbitrary clone URLs and rejects invalid refs or provider tuples', () => {
		expect(selectAssignmentSourceRepository([{ ...source, url: 'http://169.254.169.254/' }]).cloneUrl).toBe('https://github.com/fixture/project.git');
		for (const entry of [{ ...source, owner: '../other' }, { ...source, provider: 'unknown' },
			{ ...source, currentBranch: '--upload-pack=evil' }, { ...source, currentBranch: 'refs/../main' }]) {
			expect(() => selectAssignmentSourceRepository([entry])).toThrow('invalid');
		}
	});
});
