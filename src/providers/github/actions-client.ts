export function githubActionsHeaders(token: string) {
	return { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
		'content-type': 'application/json', 'user-agent': 'treeseed-workflow-provider', 'x-github-api-version': '2022-11-28' };
}

export async function githubActionsRequest(fetchImpl: typeof fetch, token: string, path: string, init: RequestInit = {}) {
	const response = await fetchImpl(`https://api.github.com${path}`, {
		...init, headers: { ...githubActionsHeaders(token), ...(init.headers ?? {}) },
	});
	if (!response.ok) throw new Error(`GitHub Actions request failed (HTTP ${response.status}).`);
	return response.status === 204 ? null : response.json();
}

export function workflowRunStatus(status: string, conclusion?: string | null) {
	if (status === 'completed') return conclusion === 'success' ? 'completed' : conclusion === 'cancelled' ? 'cancelled' : 'failed';
	if (['queued', 'requested', 'waiting', 'pending'].includes(status)) return 'queued';
	if (status === 'in_progress') return 'running';
	return 'unknown';
}

export function reconciledWorkflowRunStatus(current: string, status: string, conclusion?: string | null) {
	const observed = workflowRunStatus(status, conclusion);
	return current === 'cancelling' && ['queued', 'running'].includes(observed) ? 'cancelling' : observed;
}

export function repositoryPath(owner: string, repository: string) {
	return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}
