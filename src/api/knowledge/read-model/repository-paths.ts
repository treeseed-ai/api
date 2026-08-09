export async function listKnowledgeContentPaths(connection: any, ref = connection.baseRef) {
	const entries: any[] = [];
	let cursor: string | undefined;
	let resolvedRef: string | undefined;
	const seenCursors = new Set<string>();
	for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
		const response = await connection.client.listRepositoryPaths({
			repoId: connection.repositoryId, ref: resolvedRef ?? ref,
			paths: [`${connection.contentPath}/books/**`, `${connection.contentPath}/knowledge/**`],
			extensions: ['.md', '.mdx'], kinds: ['blob'], limit: 500, ...(cursor ? { cursor } : {}),
		});
		const observedRef = String(response.resolvedRef ?? response.ref ?? '');
		if (!observedRef) throw new Error('TreeDX did not resolve an exact knowledge source commit.');
		if (resolvedRef && observedRef !== resolvedRef) throw new Error('The knowledge source changed while paths were loading.');
		resolvedRef = observedRef;
		entries.push(...(response.entries ?? []));
		if (!response.page?.hasMore) return { entries, resolvedRef };
		const nextCursor = String(response.page.nextCursor ?? '');
		if (!nextCursor || seenCursors.has(nextCursor)) throw new Error('TreeDX returned an invalid knowledge path cursor.');
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
	throw new Error('Knowledge path pagination exceeded its safety bound.');
}
