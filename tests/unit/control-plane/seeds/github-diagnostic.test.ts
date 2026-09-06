import { describe, expect, it } from 'vitest';
import { githubDiagnostic } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/github-diagnostic.ts';

describe('safe GitHub diagnostics', () => {
	it('identifies the failing operation without body, cookies, or query values', () => {
		const response = new Response('private-response-secret', { status: 403, headers: { 'x-github-request-id': 'ABCD:1234', 'set-cookie': 'private-cookie', 'x-accepted-github-permissions': 'administration=write' } });
		const message = githubDiagnostic(response, 'POST', '/orgs/example/repos');
		expect(message).toContain('POST /orgs/example/repos');
		expect(message).toContain('ABCD:1234');
		expect(message).toContain('Administration write');
		expect(message).not.toContain('private-');
		expect(githubDiagnostic(response, 'GET', '/repos/example/library?token=private-query')).not.toContain('private-query');
	});
	it('distinguishes rate limiting from permission advice', () => {
		const message = githubDiagnostic(new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1234' } }), 'POST', '/orgs/example/repos');
		expect(message).toContain('rate limit exhausted');
		expect(message).not.toContain('Administration write');
	});
});
