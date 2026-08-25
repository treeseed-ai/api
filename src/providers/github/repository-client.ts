import { githubActionsHeaders, repositoryPath } from './actions-client.ts';

async function request(fetchImpl: typeof fetch, token: string, path: string) {
	const response = await fetchImpl(`https://api.github.com${path}`, { headers: githubActionsHeaders(token) });
	if (response.status === 404) return null;
	if (!response.ok) throw Object.assign(new Error(`GitHub repository observation failed (HTTP ${response.status}).`), {
		status: 503, code: 'provider_repository_unavailable',
	});
	return response.json() as Promise<any>;
}

export function githubRepositoryMetadata(fetchImpl: typeof fetch, token: string, owner: string, repository: string) {
	return request(fetchImpl, token, repositoryPath(owner, repository));
}

export async function githubRepositoryHead(fetchImpl: typeof fetch, token: string, owner: string,
	repository: string, ref: string) {
	const branch = ref.replace(/^refs\/heads\//u, '');
	if (!branch || branch === ref || branch.includes('..')) throw new Error('A safe branch ref is required.');
	const payload = await request(fetchImpl, token, `${repositoryPath(owner, repository)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
	const head = payload?.object?.sha;
	if (payload && typeof head !== 'string') throw new Error('GitHub remote head response did not contain a commit.');
	return typeof head === 'string' ? head : null;
}
