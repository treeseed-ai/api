type GitHub = (path: string, init?: RequestInit) => Promise<Record<string, any> | null>;
const checkpointPath = '.treeseed-template-initialization.json';
const write = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** GitHub's Git database endpoints reject writes until an empty repository has a commit. */
export async function initializeTemplate(input: {
	github: GitHub; base: string; files: Map<string, Buffer>; templateDigest: string; message: string;
}) {
	const { github, base, files, templateDigest, message } = input;
	const checkpoint = JSON.stringify({ schemaVersion: 'treeseed.template-initialization/v1', templateDigest });
	if (!files.size || files.has(checkpointPath)) throw new Error('Template is empty or uses the reserved initialization path.');
	const mainPath = `${base}/git/ref/heads/main`;
	let main: Record<string, any> | null;
	try { main = await github(mainPath); }
	catch (error) {
		if ((error as { code?: string }).code !== 'github_repository_empty') throw error;
		await github(`${base}/contents/${checkpointPath}`, write('PUT', {
			message: 'Initialize managed template checkpoint', branch: 'main', content: Buffer.from(checkpoint).toString('base64'),
		}));
		main = await github(mainPath);
	}
	if (!main?.object?.sha) throw new Error('Repository has no accepted main branch; refusing to overwrite another branch.');
	const parent = String(main.object.sha);
	const entries = [];
	for (const [path, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
		const blob = await github(`${base}/git/blobs`, write('POST', { content: content.toString('base64'), encoding: 'base64' }));
		if (!blob?.sha) throw new Error('GitHub did not return the template blob identity.');
		entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
	}
	const tree = await github(`${base}/git/trees`, write('POST', { tree: entries }));
	if (!tree?.sha) throw new Error('GitHub did not return the template tree identity.');
	const commit = await github(`${base}/git/commits/${parent}`);
	if (commit?.tree?.sha !== tree.sha) {
		const existingTree = commit?.tree?.sha ? await github(`${base}/git/trees/${commit.tree.sha}`) : null;
		const existing = existingTree?.tree;
		const onlyCheckpoint = !existingTree?.truncated && Array.isArray(existing) && existing.length === 1
			&& existing[0].path === checkpointPath && existing[0].type === 'blob' && existing[0].mode === '100644';
		const blob = onlyCheckpoint ? await github(`${base}/git/blobs/${existing[0].sha}`) : null;
		if (!Array.isArray(commit?.parents) || commit.parents.length !== 0 || !onlyCheckpoint
			|| blob?.encoding !== 'base64' || Buffer.from(blob.content, 'base64').toString('utf8') !== checkpoint) {
			throw new Error('Repository contains source that does not match the accepted template or initialization checkpoint.');
		}
		const next = await github(`${base}/git/commits`, write('POST', { message, tree: tree.sha, parents: [parent] }));
		if (!next?.sha) throw new Error('GitHub did not return the template commit identity.');
		const observed = await github(mainPath);
		if (observed?.object?.sha !== parent) throw new Error('Main moved during template initialization; refusing to overwrite concurrent work.');
		await github(`${base}/git/refs/heads/main`, write('PATCH', { sha: next.sha, force: false }));
		main = { object: { sha: next.sha } };
	}
	const accepted = String(main.object.sha);
	const readBack = await github(mainPath);
	if (readBack?.object?.sha !== accepted) throw new Error('Main changed before template acceptance.');
	const staging = await github(`${base}/git/ref/heads/staging`);
	if (staging && staging.object?.sha !== accepted) throw new Error('The adopted staging branch does not match the accepted template commit.');
	if (!staging) await github(`${base}/git/refs`, write('POST', { ref: 'refs/heads/staging', sha: accepted }));
	return accepted;
}
