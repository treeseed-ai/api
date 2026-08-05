const projectSlugs = ['market', 'admin', 'core', 'ui', 'sdk', 'api', 'cli', 'agent', 'treedx'];

export const seedTreeDxFetch: typeof fetch = async (input) => {
	const url = new URL(typeof input === 'string' ? input : input.url);
	if (url.pathname !== '/api/v1/repos') {
		return Response.json({ ok: false, error: 'Unexpected TreeDX seed request.' }, { status: 404 });
	}
	return Response.json({
		ok: true,
		repos: projectSlugs.map((slug) => ({
			repoId: `treeseed-${slug}`,
			name: `treeseed-${slug}`,
			defaultRef: 'refs/heads/main',
		})),
	});
};
