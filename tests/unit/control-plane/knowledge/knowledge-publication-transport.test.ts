import { describe, expect, it } from 'vitest';
import { knowledgePublicationTransport } from '../../../../src/operations-runner/knowledge/publication-executor.ts';

describe('knowledge publication transport', () => {
	it('prefers a ready external publication binding over local managed storage', () => {
		expect(knowledgePublicationTransport(
			{ storageKind: 'managed', remoteUrl: null },
			'local',
			{ grant_status: 'ready', clone_url: 'https://github.com/treeseed-ai/api-library.git' },
		)).toBe('external');
	});

	it('keeps managed-only repositories local when no external binding is ready', () => {
		expect(knowledgePublicationTransport(
			{ storageKind: 'managed', remoteUrl: null },
			'local',
			null,
		)).toBe('managed-local');
	});
});
