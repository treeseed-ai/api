import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('library mirror runner release closure', () => {
	it('declares both non-secret site storage references in the immutable component contract', () => {
		const source = readFileSync('scripts/release/create-component-release.ts', 'utf8');
		const configuration = source.slice(source.indexOf('configuration: {'), source.indexOf('secretEnvironment: ['));
		for (const key of ['TREESEED_LIBRARY_STORAGE_OWNER_TEAM_ID', 'TREESEED_LIBRARY_STORAGE_CONNECTION_ID']) expect(configuration).toContain(`'${key}'`);
	});
	it.each(['Dockerfile', 'Dockerfile.operations-runner'])('%s runs Node directly so SIGTERM reaches graceful drain', file => {
		const source = readFileSync(file, 'utf8');
		expect(source).toContain('CMD ["node", "./dist/operations-runner/entrypoint.js", "run"]');
		expect(source).not.toContain('CMD ["npm", "run", "start:runner"]');
	});
	it.each(['compose.yml', 'deploy/compose.template.yml'])('%s retains the same direct runner command', file => {
		expect(parse(readFileSync(file, 'utf8')).services['operations-runner'].command).toEqual(['node', './dist/operations-runner/entrypoint.js', 'run']);
	});
});
