import { createHash } from 'node:crypto';
import { KNOWLEDGE_PUBLICATION_SCHEMA_VERSION, type KnowledgePublicationManifest, type KnowledgeVisibility } from '@treeseed/sdk/knowledge';
import type { KnowledgeSnapshotProject } from '@treeseed/sdk/knowledge-packs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const canonicalKnowledgePublicationValue = (value: unknown): string => Array.isArray(value)
	? `[${value.map(canonicalKnowledgePublicationValue).join(',')}]`
	: value && typeof value === 'object'
		? `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalKnowledgePublicationValue(item)}`).join(',')}}`
		: value === undefined ? 'null' : JSON.stringify(value);

export function buildKnowledgePublication(input: { teamId: string; generatedAt: string; previousRevision?: string;
	projects: KnowledgeSnapshotProject[]; graphRevisions: Record<string, string>; refs: Record<string, string>;
	previousManifest?: KnowledgePublicationManifest | null; retainedProjectIds?: Set<string> }) {
	const objects: Array<{ key: string; body: string }> = [];
	const changedProjectIds = new Set(input.projects.map((project) => project.projectId));
	const retainedProjectIds = input.retainedProjectIds ?? new Set([
		...(input.previousManifest?.projects.map((project) => project.projectId) ?? []), ...changedProjectIds,
	]);
	const entries: KnowledgePublicationManifest['entries'] = (input.previousManifest?.entries ?? [])
		.filter((entry) => retainedProjectIds.has(entry.projectId) && !changedProjectIds.has(entry.projectId));
	const indexes = Object.fromEntries(['public', 'authenticated', 'team', 'project', 'admin'].map((key) => [key, []])) as Record<KnowledgeVisibility, string[]>;
	for (const project of [...input.projects].sort((left, right) => left.projectId.localeCompare(right.projectId))) {
		for (const [kind, values] of [['book', project.books], ['page', project.pages.map((page) => page.definition)]] as const) {
			for (const definition of [...values].sort((left, right) => left.id.localeCompare(right.id))) {
				if (!['published', 'archived'].includes(definition.status)) continue;
				const sourceMarkdown = kind === 'page' ? project.pages.find((page) => page.definition.id === definition.id)?.source : undefined;
				const body = `${canonicalKnowledgePublicationValue({ definition, sourceMarkdown, source: { teamId: project.teamId, projectId: project.projectId,
					repositoryId: project.repositoryId, commitSha: project.commitSha } })}\n`;
				const digest = hash(body);
				const key = `teams/${input.teamId}/objects/sha256/${digest}`;
				objects.push({ key, body });
				const page = kind === 'page' ? project.pages.find((candidate) => candidate.definition.id === definition.id) : undefined;
				entries.push({ kind, id: definition.id, ...(kind === 'page' ? { bookId: definition.bookId } : {}),
					visibility: definition.visibility, status: definition.status as 'published' | 'archived', projectId: project.projectId,
					sourcePath: kind === 'book' ? project.bookSourcePaths?.[definition.id] ?? `books/${definition.slug}.md`
						: page?.sourcePath ?? `knowledge/${definition.bookId}/${definition.slug}.md`,
					content: { objectKey: key, sha256: digest, byteSize: Buffer.byteLength(body) } });
			}
		}
	}
	for (const entry of entries) if (entry.status === 'published') indexes[entry.visibility].push(entry.id);
	for (const ids of Object.values(indexes)) ids.sort();
	const projects = [...(input.previousManifest?.projects ?? [])
		.filter((project) => retainedProjectIds.has(project.projectId) && !changedProjectIds.has(project.projectId)),
	...input.projects.map((project) => ({ teamId: project.teamId, projectId: project.projectId,
		repositoryId: project.repositoryId, ref: input.refs[project.projectId] ?? 'main', commitSha: project.commitSha,
		graphRevision: input.graphRevisions[project.projectId] ?? project.commitSha,
		contentDigest: hash(canonicalKnowledgePublicationValue({ books: project.books, pages: project.pages.map((page) => page.definition) })) }))]
		.sort((left, right) => left.projectId.localeCompare(right.projectId));
	const sourceClosure = hash(canonicalKnowledgePublicationValue(projects));
	const revision = hash(canonicalKnowledgePublicationValue({ sourceClosure, entries })).slice(0, 40);
	const unsigned = { schemaVersion: KNOWLEDGE_PUBLICATION_SCHEMA_VERSION, teamId: input.teamId, revision,
		generatedAt: input.generatedAt, previousRevision: input.previousRevision ?? input.previousManifest?.revision,
		sourceClosure, projects, entries, indexes };
	const manifest: KnowledgePublicationManifest = { ...unsigned, digest: hash(canonicalKnowledgePublicationValue(unsigned)) };
	return { manifest, objects };
}
