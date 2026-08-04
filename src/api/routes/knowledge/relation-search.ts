const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export const relationKinds = new Set(['knowledge', 'notes', 'questions', 'objectives', 'proposals', 'decisions', 'agents', 'people']);

export function reviewPathsMatch(recorded: unknown, current: unknown) {
	const normalize = (value: unknown) => (Array.isArray(value) ? value.map(String).sort() : []);
	const expected = normalize(recorded);
	return expected.length > 0 && JSON.stringify(expected) === JSON.stringify(normalize(current));
}

export async function searchRelations(connection: any, query: string, requested: Set<string>) {
	const paths = [...requested].map((kind) => `${connection.contentPath}/${kind}/**`);
	const response = await connection.client.searchRepositoryFiles({ repoId: connection.repositoryId, ref: connection.baseRef,
		paths: paths.length ? paths : connection.allowedPaths, query, limit: 60, includeFrontmatter: true, includeBody: false });
	const results = (response.results ?? []).flatMap((entry: any) => {
		const path = String(entry.path ?? '');
		const kind = [...relationKinds].find((candidate) => path.includes(`/${candidate}/`)
			|| entry.sourceModel === candidate || entry.entityType === candidate.replace(/s$/u, '')
			|| (candidate === 'knowledge' && ['knowledge-page', 'knowledge_page'].includes(entry.entityType)));
		if (!kind || (requested.size && !requested.has(kind))) return [];
		const id = text(entry.frontmatter?.id) || text(entry.entityId) || text(entry.canonicalId);
		if (!id) return [];
		return [{ id, title: text(entry.frontmatter?.title) || text(entry.title) || id,
			summary: text(entry.frontmatter?.summary) || text(entry.snippet).slice(0, 180), kind, score: Number(entry.score ?? 0), path,
			author: text(entry.frontmatter?.author, entry.frontmatter?.createdBy, entry.frontmatter?.created_by),
			occurredAt: text(entry.frontmatter?.createdAt, entry.frontmatter?.created_at, entry.frontmatter?.date, entry.updatedAt) }];
	});
	return [...new Map(results.map((item: any) => [item.id, item])).values()].slice(0, 20);
}
