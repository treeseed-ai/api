import { createHash } from 'node:crypto';
import { KNOWLEDGE_PACK_SCHEMA_VERSION, type KnowledgePackManifest, type KnowledgeVisibility } from '@treeseed/sdk/knowledge';
import type { KnowledgeSnapshotPackInput } from '@treeseed/sdk/knowledge-packs';
import { createDeterministicZip } from './knowledge-pack-zip.ts';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const normalizedSource = (value: string) => `${value.replaceAll('\r\n', '\n').trimEnd()}\n`;
const visibilityOrder: KnowledgeVisibility[] = ['public', 'authenticated', 'team', 'project', 'admin'];

export function buildKnowledgeSnapshotPack(input: KnowledgeSnapshotPackInput) {
	const selectedIds = new Set(input.bookIds);
	if (!selectedIds.size) throw new Error('A knowledge pack must select at least one book.');
	const availableBooks = input.projects.flatMap((project) => project.books.map((book) => ({ book, project })));
	const duplicateBookIds = availableBooks.map(({ book }) => book.id)
		.filter((id, index, values) => values.indexOf(id) !== index);
	if (duplicateBookIds.length) throw new Error(`Duplicate book ids in snapshot: ${[...new Set(duplicateBookIds)].join(', ')}.`);
	const selected = availableBooks.filter(({ book }) => selectedIds.has(book.id));
	const missing = [...selectedIds].filter((id) => !selected.some(({ book }) => book.id === id));
	if (missing.length) throw new Error(`Unknown selected books: ${missing.join(', ')}.`);
	if (selected.some(({ book }) => book.status !== 'published')) throw new Error('A selected book is not published.');
	if (selected.some(({ project }) => project.teamId !== input.teamId)) throw new Error('A selected book is outside the pack team.');
	if (selected.some(({ book }) => book.packPolicy === 'disabled')) throw new Error('A selected book does not permit knowledge-pack creation.');

	const selectedPages = selected.flatMap(({ book, project }) => project.pages
		.filter(({ definition }) => definition.bookId === book.id && definition.status === 'published')
		.map((page) => ({ ...page, book, project })))
		.sort((left, right) => left.book.id.localeCompare(right.book.id)
			|| left.definition.order - right.definition.order || left.definition.slug.localeCompare(right.definition.slug));
	const pageIds = new Set(selectedPages.map(({ definition }) => definition.id));
	const members = selected.map(({ book, project }) => {
		const pages = selectedPages.filter((page) => page.book.id === book.id && page.project.projectId === project.projectId);
		return {
			teamId: project.teamId, projectId: project.projectId, repositoryId: project.repositoryId,
			commitSha: project.commitSha, bookId: book.id, pageIds: pages.map(({ definition }) => definition.id),
			digest: digest(pages.map(({ definition, source }) => `${definition.id}:${digest(normalizedSource(source))}`).join('|')),
		};
	});
	const sourceClosure = digest(members.map((member) =>
		`${member.teamId}:${member.projectId}:${member.repositoryId}:${member.commitSha}:${member.bookId}:${member.digest}`).join('|'));
	const files = selectedPages.map(({ definition, source }) => ({
		path: `books/${definition.bookId}/${definition.slug}.md`, sha256: digest(normalizedSource(source)), mediaType: 'text/markdown',
	}));
	const visibility = selected.reduce<KnowledgeVisibility>((current, { book }) =>
		visibilityOrder.indexOf(book.visibility) > visibilityOrder.indexOf(current) ? book.visibility : current, 'public');
	const manifest: KnowledgePackManifest = {
		schemaVersion: KNOWLEDGE_PACK_SCHEMA_VERSION, id: input.id ?? `knowledge-pack:${sourceClosure.slice(0, 24)}`,
		teamId: input.teamId, createdAt: input.createdAt, sourceClosure,
		publicationRevision: input.publicationRevision, publicationSourceClosure: input.publicationSourceClosure,
		visibility, members, files,
	};
	const graph = selectedPages.flatMap(({ definition }) => [
		...(definition.parentId ? [{ sourceId: definition.id, targetId: definition.parentId, type: 'parent', included: pageIds.has(definition.parentId) }] : []),
		...definition.relatedKnowledgeIds.map((targetId) => ({ sourceId: definition.id, targetId, type: 'related-knowledge', included: pageIds.has(targetId) })),
		...definition.relatedBookIds.map((targetId) => ({ sourceId: definition.id, targetId, type: 'related-book', included: selected.some(({ book }) => book.id === targetId) })),
		...definition.guaranteeIds.map((targetId) => ({ sourceId: definition.id, targetId, type: 'documents-guarantee', included: false })),
	]);
	const combined = selected.flatMap(({ book }) => [
		`# ${book.title}`, '', book.summary, '',
		...selectedPages.filter((page) => page.book.id === book.id)
			.flatMap(({ definition, source }) => [`## ${definition.title}`, '', normalizedSource(source), '']),
	]).join('\n');
	const index = selectedPages.map(({ definition, source }) => ({
		id: definition.id, bookId: definition.bookId, slug: definition.slug, title: definition.title,
		summary: definition.summary, digest: digest(normalizedSource(source)),
	}));
	const entries = [
		{ path: 'manifest.json', bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
		{ path: 'graph.jsonl', bytes: new TextEncoder().encode(graph.map((edge) => JSON.stringify(edge)).join('\n') + (graph.length ? '\n' : '')) },
		{ path: 'combined.md', bytes: new TextEncoder().encode(combined) },
		{ path: 'index.json', bytes: new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`) },
		...selectedPages.map(({ definition, source }) => ({ path: `books/${definition.bookId}/${definition.slug}.md`, bytes: new TextEncoder().encode(normalizedSource(source)) })),
	];
	const cleanSlug = selected[0]?.book.slug.trim().replace(/^\/+|\/+$/gu, '').replace(/[^a-z0-9-]+/giu, '-').toLowerCase();
	const fileName = selected.length === 1 ? `${cleanSlug}.knowledge-pack.zip`
		: `library-${sourceClosure.slice(0, 12)}.knowledge-pack.zip`;
	return { manifest, bytes: createDeterministicZip(entries), fileName, graph, index };
}
