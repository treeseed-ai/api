import { serializeFrontmatterDocument } from '../../content/frontmatter.ts';
import {
	BOOK_SCHEMA_VERSION, KNOWLEDGE_PAGE_SCHEMA_VERSION, type BookDefinition, type KnowledgePageDefinition,
} from '@treeseed/sdk/knowledge';
import { parseBook, parseKnowledgePage } from './catalog.ts';
import { validateKnowledgeMarkdown } from './markdown.ts';

const safeSlug = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/u;

function pageFrontmatter(input: Omit<KnowledgePageDefinition, 'schemaVersion' | 'bodyHtml' | 'revision' | 'sourcePackage'>) {
	return {
		schemaVersion: KNOWLEDGE_PAGE_SCHEMA_VERSION, id: input.id, bookId: input.bookId, slug: input.slug,
		title: input.title, summary: input.summary, status: input.status, visibility: input.visibility,
		order: input.order, ...(input.parentId ? { parentId: input.parentId } : {}), groupIds: input.groupIds,
		contributors: input.contributors, relatedBookIds: input.relatedBookIds,
		relatedKnowledgeIds: input.relatedKnowledgeIds, relatedNoteIds: input.relatedNoteIds,
		relatedQuestionIds: input.relatedQuestionIds, relatedObjectiveIds: input.relatedObjectiveIds,
		relatedProposalIds: input.relatedProposalIds, relatedDecisionIds: input.relatedDecisionIds,
		guaranteeIds: input.guaranteeIds,
		audiences: input.audiences,
		capabilityIds: input.context.capabilityIds, routePatterns: input.context.routePatterns,
		resourceTypes: input.context.resourceTypes, actionIds: input.context.actionIds,
		keywords: input.context.keywords, documentationUrls: input.context.documentationUrls,
	};
}

export function serializeKnowledgePageDraft(input: Omit<KnowledgePageDefinition,
	'schemaVersion' | 'bodyHtml' | 'revision' | 'sourcePackage'>): string {
	if (!safeSlug.test(input.slug)) throw new Error('The knowledge page slug is invalid.');
	const raw = serializeFrontmatterDocument(pageFrontmatter(input), `\n${validateKnowledgeMarkdown(input.bodyMarkdown)}\n`);
	parseKnowledgePage({ path: `${input.slug}.md`, raw });
	return raw;
}

export function serializeBookDraft(input: Omit<BookDefinition, 'schemaVersion'>): string {
	if (!safeSlug.test(input.slug)) throw new Error('The book slug is invalid.');
	const coverImage = input.cover?.image?.trim();
	if (coverImage && (!coverImage.startsWith('/') || coverImage.includes('..') || /[?#]/u.test(coverImage))) {
		throw new Error('Book covers must use a safe root-relative project asset path.');
	}
	const raw = serializeFrontmatterDocument({ schemaVersion: BOOK_SCHEMA_VERSION, ...input }, '\n');
	parseBook({ path: `${input.slug}.md`, raw });
	return raw;
}
