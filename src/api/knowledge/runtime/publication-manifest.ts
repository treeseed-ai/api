import type { KnowledgeVisibility } from '@treeseed/sdk/knowledge';

// Publication storage is owned by API, not the portable SDK contracts.
export interface KnowledgePublicationManifest {
	schemaVersion: 'treeseed.knowledge-publication/v1';
	teamId: string;
	revision: string;
	generatedAt: string;
	previousRevision?: string;
	sourceClosure: string;
	projects: Array<{ teamId: string; projectId: string; repositoryId: string; ref: string;
		commitSha: string; graphRevision: string; contentDigest: string }>;
	entries: Array<{ kind: 'book' | 'page'; id: string; bookId?: string; visibility: KnowledgeVisibility;
		status: 'published' | 'archived'; projectId: string; sourcePath: string;
		content: { objectKey: string; sha256: string; byteSize: number } }>;
	indexes: Record<KnowledgeVisibility, string[]>;
	digest: string;
}

const visibilityKeys = ['public', 'authenticated', 'team', 'project', 'admin'] as const;
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid knowledge publication manifest.');
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string, trim = false): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid knowledge publication ${label}.`);
	return trim ? value.trim() : value;
}
function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`Invalid knowledge publication ${label}.`);
	return value;
}
export function parseKnowledgePublicationManifest(value: unknown): KnowledgePublicationManifest {
	const input = record(value);
	if (input.schemaVersion !== 'treeseed.knowledge-publication/v1') throw new Error('Unsupported knowledge publication schema.');
	const projects = array(input.projects, 'projects').map((value) => {
		const project = record(value);
		return { ...project, teamId: text(project.teamId, 'project team'), projectId: text(project.projectId, 'project id'),
			repositoryId: text(project.repositoryId, 'project repository'), ref: text(project.ref, 'project ref'),
			commitSha: text(project.commitSha, 'project commit'), graphRevision: text(project.graphRevision, 'project graph'),
			contentDigest: text(project.contentDigest, 'project content digest') };
	});
	const entries = array(input.entries, 'entries').map((value): KnowledgePublicationManifest['entries'][number] => {
		const entry = record(value), content = record(entry.content);
		if (entry.kind !== 'book' && entry.kind !== 'page') throw new Error('Invalid knowledge publication entry.');
		const visibility = visibilityKeys.find((key) => key === entry.visibility);
		if (!visibility || (entry.status !== 'published' && entry.status !== 'archived')) throw new Error('Invalid knowledge publication entry.');
		if (typeof content.byteSize !== 'number' || !Number.isSafeInteger(content.byteSize) || content.byteSize < 0)
			throw new Error('Invalid knowledge publication object byte size.');
		return { ...entry, kind: entry.kind, id: text(entry.id, 'entry id'), visibility, status: entry.status,
			...(entry.kind === 'page' || entry.bookId !== undefined ? { bookId: text(entry.bookId, 'entry book') } : {}),
			projectId: text(entry.projectId, 'entry project'), sourcePath: text(entry.sourcePath, 'entry path'),
			content: { ...content, objectKey: text(content.objectKey, 'object key'), sha256: text(content.sha256, 'object digest'), byteSize: content.byteSize } };
	});
	const suppliedIndexes = record(input.indexes);
	const indexes: KnowledgePublicationManifest['indexes'] = { public: [], authenticated: [], team: [], project: [], admin: [] };
	for (const key of visibilityKeys) indexes[key] = [...new Set(array(suppliedIndexes[key], `index ${key}`).map(String))].sort();
	return { schemaVersion: 'treeseed.knowledge-publication/v1', teamId: text(input.teamId, 'team', true),
		revision: text(input.revision, 'revision', true), generatedAt: text(input.generatedAt, 'generated time', true),
		previousRevision: input.previousRevision ? text(input.previousRevision, 'previous revision', true) : undefined,
		sourceClosure: text(input.sourceClosure, 'source closure', true), projects, entries, indexes, digest: text(input.digest, 'digest', true) };
}
