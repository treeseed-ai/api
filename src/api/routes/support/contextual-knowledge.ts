import {
	knowledgePageSummary,
	resolveKnowledgePage,
	type KnowledgePageDefinition,
	type KnowledgeNavigationEntry,
	type KnowledgeVisibility,
} from '@treeseed/sdk/knowledge';
import { createHash } from 'node:crypto';
import { loadFederatedKnowledgeCatalog, relatedFederatedKnowledge, searchFederatedKnowledgeCatalog, type FederatedKnowledgePage } from '../../knowledge/federated-catalog.ts';

function responsePage(page: FederatedKnowledgePage) {
	const { bodyMarkdown: _bodyMarkdown, ...safe } = page;
	return {
		...safe,
		canonicalPath: `/t/${encodeURIComponent(page.source.teamSlug)}/books/${encodeURIComponent(page.source.bookSlug ?? page.bookId)}/${page.slug.split('/').map(encodeURIComponent).join('/')}`,
	};
}

function catalogRevision(pages: KnowledgePageDefinition[]) {
	return createHash('sha256')
		.update(pages.map((page) => `${page.id}:${page.revision}`).sort().join('|'))
		.digest('hex');
}

function reportKnowledgeFailure(operation: string, error: unknown) {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	process.stderr.write(`[api] knowledge ${operation} failed: ${message}\n`);
}

function versionedResponse(c: any, revision: string | undefined, payload: Record<string, unknown>) {
	if (revision && c.req.query('revision') && c.req.query('revision') !== revision) {
		return c.json({ ok: false, code: 'knowledge_revision_stale', error: 'The knowledge runtime revision changed. Reload this page.' }, 409);
	}
	if (revision) {
		const etag = `"${revision}"`;
		c.header('etag', etag);
		c.header('cache-control', 'private, max-age=60, must-revalidate');
		if (c.req.header('if-none-match') === etag) return c.body(null, 304);
	}
	return c.json({ ok: true, payload });
}

async function canRead(context: any, c: any, page: Pick<FederatedKnowledgePage, 'status' | 'visibility' | 'source'>) {
	if (page.status !== 'published' || page.visibility === 'public') return page.status === 'published';
	const decisions: Map<string, Promise<boolean>> = c.get('knowledgeReadDecisions') ?? new Map();
	if (!c.get('knowledgeReadDecisions')) c.set('knowledgeReadDecisions', decisions);
	const owner = page.visibility === 'team' ? page.source.teamId : page.visibility === 'project' ? page.source.projectId : '';
	const key = `${page.visibility}:${owner}`;
	const existing = decisions.get(key);
	if (existing) return existing;
	const decision = (async () => {
		const auth = await context.ensurePrincipal(c);
		if (auth.response) return false;
		if (page.visibility === 'authenticated') return true;
		if (page.visibility === 'admin') return context.principalHasGlobalPlatformRole(auth.principal);
		if (page.visibility === 'team') {
			return !(await context.requireTeamAccess(c, context.store, page.source.teamId, 'knowledge:read')).response;
		}
		if (page.visibility === 'project') {
			return !(await context.requireProjectAccess(c, context.store, page.source.projectId, 'knowledge:read')).response;
		}
		return false;
	})();
	decisions.set(key, decision);
	return decision;
}

function navigationEntry(page: FederatedKnowledgePage): KnowledgeNavigationEntry {
	return {
		id: page.id, bookId: page.bookId, slug: page.slug, title: page.title, summary: page.summary,
		visibility: page.visibility, status: page.status, audiences: page.audiences, updatedAt: page.updatedAt,
		order: page.order, parentId: page.parentId, revision: page.revision,
		canonicalPath: `/t/${encodeURIComponent(page.source.teamSlug)}/books/${encodeURIComponent(page.source.bookSlug ?? page.bookId)}/${page.slug.split('/').map(encodeURIComponent).join('/')}`,
	};
}

async function readablePages(context: any, c: any, pages: FederatedKnowledgePage[]) {
	const decisions = await Promise.all(pages.map((page) => canRead(context, c, page)));
	return pages.filter((_page, index) => decisions[index]);
}

function relatedPages(pages: FederatedKnowledgePage[], page: FederatedKnowledgePage) {
	const explicit = page.relatedKnowledgeIds
		.map((id) => pages.find((candidate) => candidate.id === id))
		.filter((candidate): candidate is KnowledgePageDefinition => Boolean(candidate));
	const backlinks = pages.filter((candidate) => candidate.relatedKnowledgeIds.includes(page.id));
	return [...new Map([...explicit, ...backlinks].map((candidate) => [candidate.id, candidate])).values()];
}

export function installContextualKnowledgeRoutes(context: any) {
	const { app, jsonError } = context;

	app.get('/v1/knowledge/library', async (c: any) => {
		const catalog = await loadFederatedKnowledgeCatalog(context, c).catch(() => null);
		if (!catalog) return jsonError(c, 503, 'Knowledge is unavailable.', { code: 'knowledge_runtime_unavailable' });
		if (catalog.response) return catalog.response;
		const readableBooks = await Promise.all(catalog.books.map((book: any) => canRead(context, c, book)));
		const visiblePages = await readablePages(context, c, catalog.pages);
		let books = catalog.books.filter((_book: any, index: number) => readableBooks[index]).map((book: any) => ({
			...book, pageCount: visiblePages.filter((page: any) => page.bookId === book.id).length,
		}));
		const teamId = String(c.req.query('teamId') ?? '').trim();
		if (teamId) books = books.filter((book: any) => book.source.teamId === teamId);
		const query = String(c.req.query('q') ?? '').trim().slice(0, 120);
		if (query.length >= 2) {
			let ranked;
			try { ranked = await searchFederatedKnowledgeCatalog(context, { ...catalog, pages: visiblePages }, query); }
			catch { return jsonError(c, 503, 'Knowledge search is unavailable.', { code: 'knowledge_search_unavailable' }); }
			const matchingBookIds = new Set(ranked.map(({ page }: any) => page.bookId));
			const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
			books = books.filter((book: any) => matchingBookIds.has(book.id)
				|| words.every((word) => [book.title, book.summary, ...(book.topics ?? []), ...(book.audience ?? [])]
					.join(' ').toLowerCase().includes(word)));
		}
		const revision = catalogRevision(visiblePages);
		return versionedResponse(c, revision, { books, revision });
	});

	app.get('/v1/knowledge/reader', async (c: any) => {
		const startedAt = performance.now();
		const catalog = await loadFederatedKnowledgeCatalog(context, c).catch(() => null);
		const catalogLoadedAt = performance.now();
		if (!catalog) return jsonError(c, 503, 'Knowledge is unavailable.', { code: 'knowledge_runtime_unavailable' });
		if (catalog.response) return catalog.response;
		const teamSlug = String(c.req.query('teamSlug') ?? '');
		const bookSlug = String(c.req.query('bookSlug') ?? '');
		const pageSlug = String(c.req.query('pageSlug') ?? '').replace(/^\/+|\/+$/gu, '');
		const book = catalog.books.find((candidate: any) => candidate.source.teamSlug === teamSlug && candidate.slug === bookSlug);
		if (!book || !(await canRead(context, c, book))) return jsonError(c, 404, 'Book not found.', { code: 'knowledge_book_not_found' });
		const candidates = catalog.pages.filter((page: any) => page.bookId === book.id);
		const decisions = await Promise.all(candidates.map((page: any) => canRead(context, c, page)));
		const pages = candidates.filter((_page: any, index: number) => decisions[index])
			.sort((left: any, right: any) => left.order - right.order || left.title.localeCompare(right.title));
		const page = pageSlug ? pages.find((candidate: any) => candidate.slug === pageSlug) : undefined;
		if (pageSlug && !page) return jsonError(c, 404, 'Knowledge page not found.', { code: 'knowledge_page_not_found' });
		c.header('server-timing', `catalog;dur=${(catalogLoadedAt - startedAt).toFixed(1)}, authorize;dur=${(performance.now() - catalogLoadedAt).toFixed(1)}`);
		return versionedResponse(c, page?.revision ?? catalogRevision(pages), { book,
			navigation: pages.map(navigationEntry), page,
			revision: page?.revision ?? catalogRevision(pages) });
	});

	app.get('/v1/knowledge/context', async (c: any) => {
		const catalog = await loadFederatedKnowledgeCatalog(context, c).catch(() => null);
		if (!catalog) return jsonError(c, 503, 'Knowledge is unavailable.', { code: 'knowledge_runtime_unavailable' });
		if (catalog.response) return catalog.response;
		const pages = catalog.pages;
		const requested = resolveKnowledgePage(pages, {
			pageId: c.req.query('pageId'), capabilityId: c.req.query('capabilityId'),
			routePattern: c.req.query('routePattern'), resourceType: c.req.query('resourceType'),
			teamId: c.req.query('teamId'), projectId: c.req.query('projectId'), locale: c.req.query('locale') || 'en',
		});
		if (!requested || !(await canRead(context, c, requested))) {
			return jsonError(c, 404, 'Knowledge page not found.', { code: 'knowledge_page_not_found' });
		}
		let graphRelated: FederatedKnowledgePage[];
		try { graphRelated = await relatedFederatedKnowledge(context, catalog, requested); }
		catch (error) {
			reportKnowledgeFailure('relationships', error);
			return jsonError(c, 503, 'Knowledge relationships are unavailable.', { code: 'knowledge_graph_unavailable' });
		}
		const related = await readablePages(context, c, [...new Map([...relatedPages(pages, requested), ...graphRelated].map((page) => [page.id, page])).values()]);
		return versionedResponse(c, requested.revision, {
			page: responsePage(requested), relatedPages: related.map(knowledgePageSummary),
			searchScope: requested.visibility, revision: requested.revision,
		});
	});

	app.get('/v1/knowledge/pages/:pageId', async (c: any) => {
		const catalog = await loadFederatedKnowledgeCatalog(context, c).catch(() => null);
		if (!catalog) return jsonError(c, 503, 'Knowledge is unavailable.', { code: 'knowledge_runtime_unavailable' });
		if (catalog.response) return catalog.response;
		const pages = catalog.pages;
		const page = pages.find((candidate) => candidate.id === c.req.param('pageId'));
		if (!page || !(await canRead(context, c, page))) {
			return jsonError(c, 404, 'Knowledge page not found.', { code: 'knowledge_page_not_found' });
		}
		let graphRelated: FederatedKnowledgePage[];
		try { graphRelated = await relatedFederatedKnowledge(context, catalog, page); }
		catch (error) {
			reportKnowledgeFailure('relationships', error);
			return jsonError(c, 503, 'Knowledge relationships are unavailable.', { code: 'knowledge_graph_unavailable' });
		}
		const related = await readablePages(context, c, [...new Map([...relatedPages(pages, page), ...graphRelated].map((item) => [item.id, item])).values()]);
		return versionedResponse(c, page.revision, {
			page: responsePage(page), relatedPages: related.map(knowledgePageSummary),
			searchScope: page.visibility, revision: page.revision,
		});
	});

	app.get('/v1/knowledge/search', async (c: any) => {
		const catalog = await loadFederatedKnowledgeCatalog(context, c).catch(() => null);
		if (!catalog) return jsonError(c, 503, 'Knowledge is unavailable.', { code: 'knowledge_runtime_unavailable' });
		if (catalog.response) return catalog.response;
		const pages = await readablePages(context, c, catalog.pages);
		const query = String(c.req.query('q') ?? '').trim().slice(0, 120);
		const revision = catalogRevision(pages);
		if (query.length < 2) return versionedResponse(c, revision, { results: [], revision });
		const requestedScope = String(c.req.query('scope') ?? 'global') as KnowledgeVisibility | 'global';
		let ranked: Array<{ page: FederatedKnowledgePage; score: number }>;
		try { ranked = await searchFederatedKnowledgeCatalog(context, { ...catalog, pages }, query); }
		catch { return jsonError(c, 503, 'Knowledge search is unavailable.', { code: 'knowledge_search_unavailable' }); }
		const matches = ranked.map(({ page }) => page)
			.filter((page) => requestedScope === 'global' || page.visibility === requestedScope).slice(0, 30);
		return versionedResponse(c, revision, { results: matches.slice(0, 10).map(knowledgePageSummary), revision });
	});
}
