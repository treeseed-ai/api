/** Deliberately excludes response bodies, request headers, and query parameters. */
export function githubDiagnostic(response: Response, method: string, path: string): string {
	const details = [`${method} ${path.split('?')[0]}`, `HTTP ${response.status}`];
	for (const header of ['x-github-request-id', 'x-accepted-github-permissions', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
		const value = response.headers.get(header);
		if (value) details.push(`${header}=${value.replace(/[^a-zA-Z0-9_.:;=, /-]/gu, '').slice(0, 200)}`);
	}
	if (response.status === 403) details.push(response.headers.get('x-ratelimit-remaining') === '0'
		? 'GitHub rate limit exhausted; retry after the reported reset.'
		: method === 'POST' && /^\/orgs\/[^/]+\/repos$/u.test(path)
			? 'Creating an organization repository requires Administration write permission; check token and organization policy.'
			: 'Check authority permissions and organization policy for this operation.');
	return `GitHub library reconciliation failed (${details.join('; ')}).`;
}
