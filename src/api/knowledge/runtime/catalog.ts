import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatterDocument } from '../../content/frontmatter.ts';
import { assertPortableContentData } from '@treeseed/sdk/content-validation';
import {
	BOOK_SCHEMA_VERSION, KNOWLEDGE_PAGE_SCHEMA_VERSION, KNOWLEDGE_STATUSES, KNOWLEDGE_VISIBILITIES,
	type BookDefinition, type KnowledgeContextRequest, type KnowledgePageDefinition, type KnowledgePageSummary,
} from '@treeseed/sdk/knowledge';
import { renderKnowledgeMarkdown, validateKnowledgeMarkdown } from './markdown.ts';

const list = (value: unknown) => Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
const identifier = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const slugPattern = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/u;
const text = (record: Record<string, unknown>, key: string, path: string) => {
	const value = String(record[key] ?? '').trim();
	if (!value) throw new Error(`Knowledge entry ${path} is missing ${key}.`);
	return value;
};

function authoritativeUrls(value: unknown, path: string) {
	const urls = list(value);
	for (const url of urls) {
		let parsed: URL;
		try { parsed = new URL(url); } catch { throw new Error(`Knowledge entry ${path} has an invalid documentation URL.`); }
		if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Knowledge entry ${path} has an unsafe documentation URL.`);
	}
	return urls;
}

export function markdownFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() ? markdownFiles(path) : entry.isFile() && /\.mdx?$/u.test(entry.name) ? [path] : [];
	}).sort();
}

export function parseBook(input: { path: string; raw: string }): BookDefinition {
	const data = parseFrontmatterDocument(input.raw).frontmatter;
	assertPortableContentData('book', data, { path: input.path });
	if (data.schemaVersion !== BOOK_SCHEMA_VERSION) throw new Error(`Book ${input.path} must use ${BOOK_SCHEMA_VERSION}.`);
	const visibility = String(data.visibility ?? 'public');
	const status = String(data.status ?? 'draft');
	if (!KNOWLEDGE_VISIBILITIES.includes(visibility as never)) throw new Error(`Book ${input.path} has invalid visibility.`);
	if (!KNOWLEDGE_STATUSES.includes(status as never)) throw new Error(`Book ${input.path} has invalid status.`);
	const book = {
		schemaVersion: BOOK_SCHEMA_VERSION,
		id: text(data, 'id', input.path), slug: text(data, 'slug', input.path), title: text(data, 'title', input.path),
		summary: text(data, 'summary', input.path), description: String(data.description ?? data.summary ?? '').trim(),
		status: status as BookDefinition['status'], visibility: visibility as BookDefinition['visibility'],
		order: Number(data.order ?? 0), groupIds: list(data.groupIds), audience: list(data.audience),
		relatedBookIds: list(data.relatedBookIds ?? data.relatedBooks),
		packPolicy: ['allowed', 'restricted', 'disabled'].includes(String(data.packPolicy)) ? data.packPolicy as BookDefinition['packPolicy'] : 'allowed',
		editorialCoreNoteId: data.editorialCoreNoteId ? String(data.editorialCoreNoteId).trim() : undefined,
		cover: data.cover && typeof data.cover === 'object' ? data.cover as BookDefinition['cover'] : undefined,
	};
	if (!identifier.test(book.id)) throw new Error(`Book ${input.path} has invalid id.`);
	if (!slugPattern.test(book.slug)) throw new Error(`Book ${input.path} has invalid slug.`);
	if (book.editorialCoreNoteId && !identifier.test(book.editorialCoreNoteId.replace(/^note:/u, '').replace(/:/gu, '.'))) {
		throw new Error(`Book ${input.path} has invalid editorialCoreNoteId.`);
	}
	return book;
}

export function parseKnowledgePage(input: { path: string; raw: string; updatedAt?: string; sourcePackage?: string }): KnowledgePageDefinition {
	const parsed = parseFrontmatterDocument(input.raw);
	const data = parsed.frontmatter;
	assertPortableContentData('knowledge', data, { path: input.path });
	if (data.schemaVersion !== KNOWLEDGE_PAGE_SCHEMA_VERSION) throw new Error(`Knowledge page ${input.path} must use ${KNOWLEDGE_PAGE_SCHEMA_VERSION}.`);
	const visibility = String(data.visibility ?? 'public');
	const status = String(data.status ?? 'published');
	if (!KNOWLEDGE_VISIBILITIES.includes(visibility as never)) throw new Error(`Knowledge page ${input.path} has invalid visibility.`);
	if (!KNOWLEDGE_STATUSES.includes(status as never)) throw new Error(`Knowledge page ${input.path} has invalid status.`);
	const bodyMarkdown = validateKnowledgeMarkdown(parsed.body);
	const page = {
		schemaVersion: KNOWLEDGE_PAGE_SCHEMA_VERSION,
		id: text(data, 'id', input.path), bookId: text(data, 'bookId', input.path), slug: text(data, 'slug', input.path),
		title: text(data, 'title', input.path), summary: text(data, 'summary', input.path),
		status: status as KnowledgePageDefinition['status'], visibility: visibility as KnowledgePageDefinition['visibility'],
		order: Number(data.order ?? 0), parentId: data.parentId ? String(data.parentId) : undefined,
		groupIds: list(data.groupIds), contributors: list(data.contributors), relatedBookIds: list(data.relatedBookIds ?? data.relatedBooks),
		relatedKnowledgeIds: list(data.relatedKnowledgeIds ?? data.relatedTopics), relatedNoteIds: list(data.relatedNoteIds),
		relatedQuestionIds: list(data.relatedQuestionIds), relatedObjectiveIds: list(data.relatedObjectiveIds),
		relatedProposalIds: list(data.relatedProposalIds), relatedDecisionIds: list(data.relatedDecisionIds),
		guaranteeIds: list(data.guaranteeIds),
		audiences: {
			primary: list((data.audiences as Record<string, unknown> | undefined)?.primary ?? data.audience),
			secondary: list((data.audiences as Record<string, unknown> | undefined)?.secondary),
			excluded: list((data.audiences as Record<string, unknown> | undefined)?.excluded),
		},
		context: {
			capabilityIds: list(data.capabilityIds), routePatterns: list(data.routePatterns), resourceTypes: list(data.resourceTypes),
			actionIds: list(data.actionIds), keywords: list(data.keywords), documentationUrls: authoritativeUrls(data.documentationUrls, input.path),
		},
		bodyMarkdown, bodyHtml: renderKnowledgeMarkdown(bodyMarkdown), updatedAt: input.updatedAt,
		revision: createHash('sha256').update(input.raw).digest('hex'), sourcePackage: input.sourcePackage,
	};
	if (!identifier.test(page.id)) throw new Error(`Knowledge page ${input.path} has invalid id.`);
	if (!identifier.test(page.bookId)) throw new Error(`Knowledge page ${input.path} has invalid bookId.`);
	if (!slugPattern.test(page.slug)) throw new Error(`Knowledge page ${input.path} has invalid slug.`);
	return page;
}

export function loadBookCatalog(root: string): BookDefinition[] {
	const books = markdownFiles(root).map((path) => parseBook({ path, raw: readFileSync(path, 'utf8') }));
	const ids = new Set<string>();
	const slugs = new Set<string>();
	for (const book of books) {
		if (ids.has(book.id)) throw new Error(`Duplicate book id "${book.id}".`);
		if (slugs.has(book.slug)) throw new Error(`Duplicate book slug "${book.slug}".`);
		ids.add(book.id); slugs.add(book.slug);
	}
	for (const book of books) {
		const missing = book.relatedBookIds.filter((id) => !ids.has(id));
		if (missing.length) throw new Error(`Book "${book.id}" references missing books: ${missing.join(', ')}.`);
	}
	return books.sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
}

export function loadKnowledgeCatalog(root: string, sourcePackage?: string): KnowledgePageDefinition[] {
	const pages = markdownFiles(root).map((path) => parseKnowledgePage({ path, raw: readFileSync(path, 'utf8'), updatedAt: statSync(path).mtime.toISOString(), sourcePackage }));
	const ids = new Set<string>();
	for (const page of pages) { if (ids.has(page.id)) throw new Error(`Duplicate knowledge page id "${page.id}".`); ids.add(page.id); }
	for (const page of pages) {
		const missing = page.relatedKnowledgeIds.filter((id) => !ids.has(id));
		if (missing.length) throw new Error(`Knowledge page "${page.id}" references missing pages: ${missing.join(', ')}.`);
	}
	return pages;
}

const visibilityRank: Record<KnowledgePageDefinition['visibility'], number> = {
	public: 0, authenticated: 1, team: 2, project: 3, admin: 4,
};

export function validateKnowledgeCatalog(books: BookDefinition[], pages: KnowledgePageDefinition[]) {
	const byId = new Map(books.map((book) => [book.id, book]));
	const pagesById = new Map(pages.map((page) => [page.id, page]));
	for (const page of pages) {
		const book = byId.get(page.bookId);
		if (!book) throw new Error(`Knowledge page "${page.id}" references missing book "${page.bookId}".`);
		if (visibilityRank[page.visibility] < visibilityRank[book.visibility]) {
			throw new Error(`Knowledge page "${page.id}" is more visible than book "${book.id}".`);
		}
		if (page.parentId) {
			const parent = pagesById.get(page.parentId);
			if (!parent) throw new Error(`Knowledge page "${page.id}" references missing parent "${page.parentId}".`);
			if (parent.bookId !== page.bookId) throw new Error(`Knowledge page "${page.id}" has a parent in another book.`);
		}
	}
	const diagnostics = validateKnowledgeHierarchy(pages);
	if (diagnostics.length) throw new Error(diagnostics[0].message);
	return { books, pages };
}

export interface KnowledgeHierarchyDiagnostic { code: string; pageId: string; message: string }
export interface KnowledgeHierarchyItem { id: string; parentId?: string; order: number; title: string }
export interface KnowledgeHierarchyNode<T extends KnowledgeHierarchyItem = KnowledgePageDefinition> {
	page: T;
	children: KnowledgeHierarchyNode<T>[];
}

const pageOrder = (left: KnowledgeHierarchyItem, right: KnowledgeHierarchyItem) =>
	left.order - right.order || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);

export function validateKnowledgeHierarchy(pages: KnowledgePageDefinition[]): KnowledgeHierarchyDiagnostic[] {
	const byId = new Map(pages.map((page) => [page.id, page]));
	const diagnostics: KnowledgeHierarchyDiagnostic[] = [];
	for (const page of pages) {
		const visited = new Set([page.id]);
		let parentId = page.parentId;
		while (parentId) {
			if (visited.has(parentId)) {
				diagnostics.push({ code: 'knowledge.parent_cycle', pageId: page.id,
					message: `Knowledge page "${page.id}" participates in a parent cycle.` });
				break;
			}
			visited.add(parentId);
			parentId = byId.get(parentId)?.parentId;
		}
	}
	return diagnostics;
}

export function buildKnowledgeHierarchy<T extends KnowledgeHierarchyItem>(pages: T[]): KnowledgeHierarchyNode<T>[] {
	const nodes = new Map(pages.map((page) => [page.id, { page, children: [] as KnowledgeHierarchyNode<T>[] }]));
	const roots: KnowledgeHierarchyNode<T>[] = [];
	for (const node of nodes.values()) {
		const parent = node.page.parentId ? nodes.get(node.page.parentId) : undefined;
		if (parent) parent.children.push(node); else roots.push(node);
	}
	const sort = (entries: KnowledgeHierarchyNode<T>[]) => {
		entries.sort((left, right) => pageOrder(left.page, right.page));
		entries.forEach((entry) => sort(entry.children));
	};
	sort(roots);
	return roots;
}

export const knowledgePageSummary = (page: KnowledgePageDefinition): KnowledgePageSummary => ({
	id: page.id, bookId: page.bookId, slug: page.slug, title: page.title, summary: page.summary,
	visibility: page.visibility, status: page.status, audiences: page.audiences, updatedAt: page.updatedAt,
});

export function resolveKnowledgePage(pages: KnowledgePageDefinition[], request: KnowledgeContextRequest) {
	return pages.find((page) => page.id === request.pageId)
		?? pages.find((page) => Boolean(request.capabilityId && page.context.capabilityIds.includes(request.capabilityId)))
		?? pages.find((page) => Boolean(request.routePattern && page.context.routePatterns.includes(request.routePattern)))
		?? null;
}

export function searchKnowledgePages(pages: KnowledgePageDefinition[], query: string) {
	const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
	if (!terms.length) return [];
	return pages.filter((page) => {
		const haystack = [page.title, page.summary, page.bodyMarkdown, ...page.groupIds, ...page.context.keywords].join(' ').toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}
