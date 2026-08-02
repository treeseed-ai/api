import { describe, expect, it } from 'vitest';
import { localPublicationRemote } from '../../../../src/operations-runner/knowledge/publication-executor.ts';

describe('knowledge publication credential custody', () => {
	it('permits isolated local acceptance remotes', () => {
		expect(localPublicationRemote('/tmp/knowledge.git')).toBe(true);
		expect(localPublicationRemote('file:///tmp/knowledge.git')).toBe(true);
		expect(localPublicationRemote('../fixtures/knowledge.git')).toBe(true);
	});

	it('rejects external remotes until an operation-scoped credential lease is integrated', () => {
		expect(localPublicationRemote('https://github.com/treeseed-ai/admin.git')).toBe(false);
		expect(localPublicationRemote('git@github.com:treeseed-ai/admin.git')).toBe(false);
		expect(localPublicationRemote('ssh://git@github.com/treeseed-ai/admin.git')).toBe(false);
		expect(localPublicationRemote(null)).toBe(false);
	});
});
