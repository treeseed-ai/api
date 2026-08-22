import { createHash } from 'node:crypto';
import type { KnowledgeNavigationEntry, KnowledgePageDefinition, KnowledgeVisibility } from '@treeseed/sdk/knowledge';
import { loadFederatedKnowledgeCatalog, relatedFederatedKnowledge, searchFederatedKnowledgeCatalog, type FederatedKnowledgePage } from '../../knowledge/federated-catalog.ts';
import { knowledgePageSummary, resolveKnowledgePage } from '../../knowledge/runtime/catalog.ts';

type Principal = { id: string; roles?: string[] } | undefined;

export class KnowledgeReaderError extends Error {
	constructor(readonly status: 401 | 403 | 404 | 503, readonly code: string, message: string) { super(message); }
}

export function createKnowledgeReaderService(context: any) {
	async function catalog(principal: Principal) {
		const result = await loadFederatedKnowledgeCatalog(context, { get: (key: string) => key === 'principal' ? principal : undefined }).catch(() => null);
		if (!result) throw new KnowledgeReaderError(503, 'knowledge_runtime_unavailable', 'Knowledge is unavailable.');
		return result;
	}

	async function readable(principal: Principal, pages: FederatedKnowledgePage[]) {
		const memberships = principal ? new Set((await context.store.listProjectsForPrincipal(principal)).map((project: any) => project.id)) : new Set();
		const admin = principal?.roles?.some((role) => ['admin', 'platform_admin'].includes(role)) ?? false;
		return pages.filter((page) => page.status === 'published' && (page.visibility === 'public'
			|| (page.visibility === 'authenticated' && principal)
			|| (page.visibility === 'admin' && admin)
			|| (['team', 'project'].includes(page.visibility) && memberships.has(page.source.projectId))));
	}

	return {
		async teamCatalog(principal: Principal, teamId: string) {
			const access = await knowledgeAccess(context.store, principal, teamId);
			const loaded = await catalog(principal);
			return catalogProjection(loaded.books.filter((book) => book.source.teamId === teamId),
				loaded.pages.filter((page) => page.source.teamId === teamId), access);
		},

		async projectCatalog(principal: Principal, projectId: string) {
			const details = await context.store.getProjectDetails(projectId);
			if (!details?.project) throw new KnowledgeReaderError(404, 'project_not_found', 'The project was not found.');
			const access = await knowledgeAccess(context.store, principal, details.project.teamId);
			const loaded = await loadFederatedKnowledgeCatalog(context, { get: (key: string) => key === 'principal' ? principal : undefined }, projectId)
				.catch(() => null);
			if (!loaded) throw new KnowledgeReaderError(503, 'knowledge_runtime_unavailable', 'The project knowledge catalog is unavailable.');
			return catalogProjection(loaded.books, loaded.pages, access);
		},

		async library(principal: Principal, query: Record<string, unknown>) {
			const loaded = await catalog(principal);
			const pages = await readable(principal, loaded.pages);
			const visibleBookIds = new Set(pages.map((page) => page.bookId));
			let books = loaded.books.filter((book) => visibleBookIds.has(book.id)).map((book) => ({
				...book, pageCount: pages.filter((page) => page.bookId === book.id).length,
			}));
			const teamId = text(query.teamId);
			if (teamId) books = books.filter((book) => book.source.teamId === teamId);
			const search = text(query.q).slice(0, 120);
			if (search.length >= 2) {
				const ranked = await searchFederatedKnowledgeCatalog(context, { ...loaded, pages }, search)
					.catch(() => { throw new KnowledgeReaderError(503, 'knowledge_search_unavailable', 'Knowledge search is unavailable.'); });
				const matching = new Set(ranked.map(({ page }) => page.bookId));
				books = books.filter((book) => matching.has(book.id));
			}
			return { books, revision: catalogRevision(pages) };
		},

		async reader(principal: Principal, query: Record<string, unknown>) {
			const loaded = await catalog(principal);
			const teamSlug = text(query.teamSlug), bookSlug = text(query.bookSlug);
			const pageSlug = text(query.pageSlug).replace(/^\/+|\/+$/gu, '');
			const book = loaded.books.find((candidate) => candidate.source.teamSlug === teamSlug && candidate.slug === bookSlug);
			if (!book) throw new KnowledgeReaderError(404, 'knowledge_book_not_found', 'Book not found.');
			const pages = (await readable(principal, loaded.pages.filter((page) => page.bookId === book.id)))
				.sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
			if (!pages.length) throw new KnowledgeReaderError(404, 'knowledge_book_not_found', 'Book not found.');
			const page = pageSlug ? pages.find((candidate) => candidate.slug === pageSlug) : undefined;
			if (pageSlug && !page) throw new KnowledgeReaderError(404, 'knowledge_page_not_found', 'Knowledge page not found.');
			return { book, navigation: pages.map(navigationEntry), page, revision: page?.revision ?? catalogRevision(pages) };
		},

		async context(principal: Principal, query: Record<string, unknown>) {
			const loaded = await catalog(principal);
			const pages = await readable(principal, loaded.pages);
			const page = resolveKnowledgePage(pages, {
				pageId: text(query.pageId), capabilityId: text(query.capabilityId), routePattern: text(query.routePattern),
				resourceType: text(query.resourceType), teamId: text(query.teamId), projectId: text(query.projectId), locale: text(query.locale) || 'en',
			});
			if (!page) throw new KnowledgeReaderError(404, 'knowledge_page_not_found', 'Knowledge page not found.');
			return relatedResponse(context, loaded, pages, page);
		},

		async page(principal: Principal, pageId: string) {
			const loaded = await catalog(principal);
			const pages = await readable(principal, loaded.pages);
			const page = pages.find((candidate) => candidate.id === pageId);
			if (!page) throw new KnowledgeReaderError(404, 'knowledge_page_not_found', 'Knowledge page not found.');
			return relatedResponse(context, loaded, pages, page);
		},

		async search(principal: Principal, query: Record<string, unknown>) {
			const loaded = await catalog(principal);
			const pages = await readable(principal, loaded.pages);
			const revision = catalogRevision(pages), value = text(query.q).slice(0, 120);
			if (value.length < 2) return { results: [], revision };
			const scope = text(query.scope, 'global') as KnowledgeVisibility | 'global';
			const ranked = await searchFederatedKnowledgeCatalog(context, { ...loaded, pages }, value)
				.catch(() => { throw new KnowledgeReaderError(503, 'knowledge_search_unavailable', 'Knowledge search is unavailable.'); });
			return { results: ranked.map(({ page }) => page).filter((page) => scope === 'global' || page.visibility === scope)
				.slice(0, 10).map(knowledgePageSummary), revision };
		},
	};
}

async function knowledgeAccess(store: any, principal: Principal, teamId: string) {
	if (!principal) throw new KnowledgeReaderError(401, 'authentication_required', 'Authentication is required.');
	const administrator = principal.roles?.some((role) => ['admin', 'platform_admin'].includes(role)) ?? false;
	if (!administrator && !await store.principalCanAccessTeam(principal, teamId)) {
		throw new KnowledgeReaderError(403, 'knowledge_access_denied', 'The principal cannot access this knowledge catalog.');
	}
	const summary = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(teamId, principal);
	if (!administrator && !summary.permissions.includes('knowledge:read')) {
		throw new KnowledgeReaderError(403, 'knowledge_permission_denied', 'Knowledge read authority is required.');
	}
	return { administrator, permissions: new Set<string>(summary.permissions) };
}

function catalogProjection(books: any[], pages: FederatedKnowledgePage[], access: { administrator: boolean; permissions: Set<string> }) {
	const mayReadDrafts = access.administrator || ['knowledge:author', 'knowledge:review', 'knowledge:manage-books']
		.some((permission) => access.permissions.has(permission));
	const visibleBooks = books.filter((book) => (book.status === 'published' || mayReadDrafts)
		&& (book.visibility !== 'admin' || access.administrator));
	const bookIds = new Set(visibleBooks.map((book) => book.id));
	const visiblePages = pages.filter((page) => bookIds.has(page.bookId) && (page.status === 'published' || mayReadDrafts)
		&& (page.visibility !== 'admin' || access.administrator));
	return { books: visibleBooks, pages: visiblePages.map(({ bodyMarkdown: _body, bodyHtml: _html, ...page }: any) => page) };
}

const text = (value: unknown, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const catalogRevision = (pages: KnowledgePageDefinition[]) => createHash('sha256').update(pages.map((page) => `${page.id}:${page.revision}`).sort().join('|')).digest('hex');

function navigationEntry(page: FederatedKnowledgePage): KnowledgeNavigationEntry {
	return { id: page.id, bookId: page.bookId, slug: page.slug, title: page.title, summary: page.summary, visibility: page.visibility,
		status: page.status, audiences: page.audiences, updatedAt: page.updatedAt, order: page.order, parentId: page.parentId,
		revision: page.revision, canonicalPath: canonicalPath(page) };
}

function responsePage(page: FederatedKnowledgePage) {
	const { bodyMarkdown: _bodyMarkdown, ...safe } = page;
	return { ...safe, canonicalPath: canonicalPath(page) };
}

function canonicalPath(page: FederatedKnowledgePage) {
	return `/t/${encodeURIComponent(page.source.teamSlug)}/books/${encodeURIComponent(page.source.bookSlug ?? page.bookId)}/${page.slug.split('/').map(encodeURIComponent).join('/')}`;
}

async function relatedResponse(context: any, catalog: any, readable: FederatedKnowledgePage[], page: FederatedKnowledgePage) {
	const graph = await relatedFederatedKnowledge(context, catalog, page)
		.catch(() => { throw new KnowledgeReaderError(503, 'knowledge_graph_unavailable', 'Knowledge relationships are unavailable.'); });
	const explicit = readable.filter((candidate) => page.relatedKnowledgeIds.includes(candidate.id) || candidate.relatedKnowledgeIds.includes(page.id));
	const related = [...new Map([...explicit, ...graph.filter((candidate) => readable.some((item) => item.id === candidate.id))]
		.map((candidate) => [candidate.id, candidate])).values()];
	return { page: responsePage(page), relatedPages: related.map(knowledgePageSummary), searchScope: page.visibility, revision: page.revision };
}
